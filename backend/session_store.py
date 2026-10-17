"""
MwM - Session Store & State Machine
Coordinates session lifecycle from negotiation rounds to cryptographic signatures and on-chain settlement.

Supported States:
- NEGOTIATING -> AWAITING_SIGNATURES -> SETTLING -> SETTLED
- Terminal: CANCELLED_BY_USER, BLOCKED_BY_GATE, FAILED, EXPIRED

Features:
- Perspective privacy masking: caller sees only their own my_private_thought
- Enforces strict state transitions and 2/2 signature validation
- In-memory thread-safe store with locking
"""

import time
import logging
import threading
from typing import Any, Dict, List, Optional, Tuple
from pydantic import BaseModel, Field

from backend.qvac_negotiator import NegotiationTurn
from backend.deterministic_gate import CanonicalSwapTerms

logger = logging.getLogger("mwm.session")

class SessionStatus:
    NEGOTIATING = "NEGOTIATING"
    AWAITING_SIGNATURES = "AWAITING_SIGNATURES"
    SETTLING = "SETTLING"
    SETTLED = "SETTLED"
    CANCELLED_BY_USER = "CANCELLED_BY_USER"
    BLOCKED_BY_GATE = "BLOCKED_BY_GATE"
    FAILED = "FAILED"
    EXPIRED = "EXPIRED"

class Session(BaseModel):
    session_id: str
    status: str = SessionStatus.NEGOTIATING
    asset_id: str
    asset_ticker: str
    asset_amount: int
    payment_asset_id: str
    payment_ticker: str
    payment_amount: Optional[int] = None
    agreed_price_usd: Optional[int] = None

    buyer_wallet_id: str
    seller_wallet_id: str
    buyer_address: str
    seller_address: str

    asking_price_usd: int
    buyer_max_budget_usd: int
    buyer_target_usd: int = 120
    seller_min_reserve_usd: int
    network_fee_sat: int = 2_000
    expiry_unix: int

    terms: Optional[Dict[str, Any]] = None
    terms_hash: Optional[str] = None

    buyer_signed: bool = False
    seller_signed: bool = False
    buyer_signed_hash: Optional[str] = None
    seller_signed_hash: Optional[str] = None

    txid: Optional[str] = None
    settlement_step: int = 0
    settlement_message: str = ""
    error_message: Optional[str] = None

    thinking: Optional[str] = None
    gate: Optional[Dict[str, Any]] = None
    history: List[NegotiationTurn] = Field(default_factory=list)
    created_at_unix: int = Field(default_factory=lambda: int(time.time()))
    updated_at_unix: int = Field(default_factory=lambda: int(time.time()))

    def to_view(self, viewer_wallet_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Produce a view of the session with perspective privacy masking:
        Only exposes `my_private_thought` if the viewer matches the turn's speaker.
        """
        sanitized_history: List[Dict[str, Any]] = []
        my_latest_thought = ""

        for turn in self.history:
            is_me = (viewer_wallet_id is not None) and (turn.speaker_wallet_id == viewer_wallet_id)
            if is_me:
                my_latest_thought = turn.private_thought
            sanitized_history.append({
                "round_number": turn.round_number,
                "speaker_wallet_id": turn.speaker_wallet_id,
                "speaker_label": turn.speaker_label,
                "action": turn.action,
                "offer_usd": turn.offer_usd,
                "public_message": turn.public_message,
                # Private thought masked for the other party
                "private_thought": turn.private_thought if is_me else None,
            })

        data = self.model_dump()
        data["history"] = sanitized_history
        data["my_private_thought"] = my_latest_thought
        return data

    def needs_signature_from(self, viewer_wallet_id: Optional[str]) -> bool:
        """True while these terms wait for this wallet's signature (and have not expired)."""
        if self.status != SessionStatus.AWAITING_SIGNATURES or int(time.time()) > self.expiry_unix:
            return False
        if viewer_wallet_id in (self.buyer_wallet_id, self.buyer_address):
            return not self.buyer_signed
        if viewer_wallet_id in (self.seller_wallet_id, self.seller_address):
            return not self.seller_signed
        return False

    def to_session_view(self, viewer_wallet_id: Optional[str] = None) -> Dict[str, Any]:
        """
        Produce SessionView matching the exact frontend types.ts contract.
        Ensures strict perspective masking: my_private_thought is only revealed
        for the requesting wallet's own turns, never for the counterparty.
        """
        from backend.memory_graph import memory_graph

        is_buyer = viewer_wallet_id == self.buyer_wallet_id
        is_seller = viewer_wallet_id == self.seller_wallet_id
        my_role = "buyer" if is_buyer else ("seller" if is_seller else "buyer")

        counterparty_address = self.seller_address if is_buyer else self.buyer_address
        counterparty_wallet_id = self.seller_wallet_id if is_buyer else self.buyer_wallet_id

        rep = memory_graph.get_reputation(counterparty_wallet_id)
        counterparty_trust = {
            "trusted": rep.is_trusted,
            "sybil_ring_detected": rep.trust_tier == "Ring Anomaly Detected",
            "reliability_pct": rep.reliability_pct,
            "trust_tier": rep.trust_tier,
            "assessment_summary": rep.assessment_summary,
        }

        # Build rounds 1..4
        rounds_map: Dict[int, Dict[str, Any]] = {}
        for r_num in range(1, 5):
            rounds_map[r_num] = {
                "n": r_num,
                "buyer_offer_usd": None,
                "seller_offer_usd": None,
                "buyer_action": None,
                "seller_action": None,
                "my_private_thought": None,
                "public_messages": {"buyer": None, "seller": None},
            }

        max_round_seen = 0
        for turn in self.history:
            r = turn.round_number
            if 1 <= r <= 4:
                if r > max_round_seen:
                    max_round_seen = r
                target_round = rounds_map[r]
                if turn.speaker_wallet_id == self.buyer_wallet_id:
                    target_round["buyer_offer_usd"] = turn.offer_usd
                    target_round["buyer_action"] = turn.action
                    target_round["public_messages"]["buyer"] = turn.public_message
                    if is_buyer:
                        target_round["my_private_thought"] = turn.private_thought
                elif turn.speaker_wallet_id == self.seller_wallet_id:
                    target_round["seller_offer_usd"] = turn.offer_usd
                    target_round["seller_action"] = turn.action
                    target_round["public_messages"]["seller"] = turn.public_message
                    if is_seller:
                        target_round["my_private_thought"] = turn.private_thought

        rounds_list = [rounds_map[r] for r in range(1, max_round_seen + 1)] if max_round_seen > 0 else []

        settlement_steps: List[Dict[str, Any]] = []
        if self.status in (SessionStatus.SETTLING, SessionStatus.SETTLED, SessionStatus.FAILED):
            step_defs = [
                (1, "create_swap_offer"),
                (2, "accept_swap_offer"),
                (3, "accept_swap_request"),
                (4, "complete_swap_proposal"),
                (5, "process_swap_completion"),
                (6, "broadcast_swap_completion"),
                (7, "accept_swap_transfers"),
            ]
            for idx, name in step_defs:
                if self.status == SessionStatus.SETTLED:
                    st = "done"
                elif self.status == SessionStatus.FAILED:
                    if idx < self.settlement_step:
                        st = "done"
                    elif idx == self.settlement_step:
                        st = "failed"
                    else:
                        st = "pending"
                elif self.status == SessionStatus.SETTLING:
                    if idx < self.settlement_step:
                        st = "done"
                    elif idx == self.settlement_step:
                        st = "running"
                    else:
                        st = "pending"
                else:
                    st = "pending"
                settlement_steps.append({
                    "index": idx,
                    "name": name,
                    "status": st,
                })

        failure = None
        if self.status == SessionStatus.FAILED and self.error_message:
            failure = {"code": "settlement_error", "message": self.error_message}

        return {
            "session_id": self.session_id,
            "state": self.status,
            "my_role": my_role,
            "counterparty_address": counterparty_address,
            "asset": {
                "asset_id": self.asset_id,
                "ticker": self.asset_ticker,
                "schema": "NIA",
                "precision": 0,
            },
            "rgb_amount": self.asset_amount,
            "agreed_price_usd": self.agreed_price_usd,
            "created_at": self.created_at_unix,
            "updated_at": self.updated_at_unix,
            "payment_asset": {
                "asset_id": self.payment_asset_id,
                "ticker": self.payment_ticker,
                "schema": "NIA",
                "precision": 0,
            },
            "counterparty_trust": counterparty_trust,
            "rounds": rounds_list,
            # The negotiation thread may set thinking after a cancel; it only means something while negotiating.
            "thinking": self.thinking if self.status == SessionStatus.NEGOTIATING else None,
            "gate": self.gate,
            "terms": self.terms,
            "terms_hash": self.terms_hash,
            "buyer_signed": self.buyer_signed,
            "seller_signed": self.seller_signed,
            "settlement_steps": settlement_steps,
            "txid": self.txid,
            "failure": failure,
            "needs_my_signature": self.needs_signature_from(viewer_wallet_id),
        }

    def to_summary(self, viewer_wallet_id: Optional[str] = None) -> Dict[str, Any]:
        """Produce SessionSummary item for GET /api/sessions."""
        is_buyer = viewer_wallet_id == self.buyer_wallet_id
        is_seller = viewer_wallet_id == self.seller_wallet_id
        my_role = "buyer" if is_buyer else ("seller" if is_seller else "buyer")
        counterparty_address = self.seller_address if is_buyer else self.buyer_address
        return {
            "session_id": self.session_id,
            "state": self.status,
            "my_role": my_role,
            "counterparty_address": counterparty_address,
            "asset": {
                "asset_id": self.asset_id,
                "ticker": self.asset_ticker,
                "schema": "NIA",
                "precision": 0,
            },
            "rgb_amount": self.asset_amount,
            "agreed_price_usd": self.agreed_price_usd,
            "created_at": self.created_at_unix,
            "updated_at": self.updated_at_unix,
            "needs_my_signature": self.needs_signature_from(viewer_wallet_id),
        }



class SessionStore:
    """Thread-safe in-memory store for MwM negotiation and swap sessions."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: Dict[str, Session] = {}

    def create_session(
        self,
        session_id: str,
        asset_id: str,
        asset_ticker: str,
        asset_amount: int,
        payment_asset_id: str,
        payment_ticker: str,
        buyer_wallet_id: str,
        seller_wallet_id: str,
        buyer_address: str,
        seller_address: str,
        asking_price_usd: int,
        buyer_max_budget_usd: int,
        seller_min_reserve_usd: int,
        buyer_target_usd: int = 120,
        expiry_seconds: int = 3600,
        network_fee_sat: int = 2_000,
        initial_status: str = SessionStatus.NEGOTIATING,
        initial_gate: Optional[Dict[str, Any]] = None,
    ) -> Session:
        with self._lock:
            now = int(time.time())
            session = Session(
                session_id=session_id,
                status=initial_status,
                asset_id=asset_id,
                asset_ticker=asset_ticker,
                asset_amount=asset_amount,
                payment_asset_id=payment_asset_id,
                payment_ticker=payment_ticker,
                buyer_wallet_id=buyer_wallet_id,
                seller_wallet_id=seller_wallet_id,
                buyer_address=buyer_address,
                seller_address=seller_address,
                asking_price_usd=asking_price_usd,
                buyer_max_budget_usd=buyer_max_budget_usd,
                buyer_target_usd=buyer_target_usd,
                seller_min_reserve_usd=seller_min_reserve_usd,
                network_fee_sat=network_fee_sat,
                expiry_unix=now + expiry_seconds,
                gate=initial_gate,
                created_at_unix=now,
                updated_at_unix=now,
            )
            self._sessions[session_id] = session
            return session

    def list_sessions_for(self, wallet_id: str) -> List[Session]:
        with self._lock:
            res: List[Session] = []
            for s in self._sessions.values():
                if wallet_id in (s.buyer_wallet_id, s.seller_wallet_id, s.buyer_address, s.seller_address):
                    res.append(s)
            res.sort(key=lambda x: x.created_at_unix, reverse=True)
            return res

    def get_session(self, session_id: str) -> Optional[Session]:
        with self._lock:
            session = self._sessions.get(session_id)
            if session and session.status == SessionStatus.AWAITING_SIGNATURES:
                if int(time.time()) > session.expiry_unix:
                    session.status = SessionStatus.EXPIRED
            return session

    def record_turn(self, session_id: str, turn: NegotiationTurn) -> Session:
        with self._lock:
            session = self._sessions[session_id]
            if session.status == SessionStatus.NEGOTIATING:
                session.history.append(turn)
            return session

    def set_awaiting_signatures(
        self,
        session_id: str,
        agreed_price_usd: int,
        payment_amount: int,
        canonical_terms: CanonicalSwapTerms,
        terms_hash: str,
    ) -> Session:
        with self._lock:
            session = self._sessions[session_id]
            # A cancel that landed while the agents were thinking must stick.
            if session.status != SessionStatus.NEGOTIATING:
                logger.info(f"Session {session_id}: agreement ignored, session is {session.status}")
                return session
            session.status = SessionStatus.AWAITING_SIGNATURES
            session.agreed_price_usd = agreed_price_usd
            session.payment_amount = payment_amount
            session.terms = canonical_terms.model_dump()
            session.terms_hash = terms_hash
            session.expiry_unix = canonical_terms.expiry_unix
            session.gate = {
                "passed": True,
                "trust_tier": "High Authenticity",
                "reasons": [],
            }
            session.updated_at_unix = int(time.time())
            return session

    def sign_session(self, session_id: str, wallet_id: str, signed_hash: str) -> Tuple[Session, bool]:
        """
        Record signature from buyer or seller.
        If signed_hash does not match session terms_hash, rejects transition.
        If both have signed with matching hash, transitions to SETTLING.
        Returns (session, started): started is True only for the call that moved it to SETTLING,
        so exactly one settlement worker is launched.
        """
        with self._lock:
            session = self._sessions[session_id]
            if session.status != SessionStatus.AWAITING_SIGNATURES:
                raise ValueError(f"Cannot sign session in state {session.status}")

            if signed_hash != session.terms_hash:
                raise ValueError(f"Signed hash {signed_hash} does not match active session terms_hash {session.terms_hash}")

            if wallet_id in (session.buyer_wallet_id, session.buyer_address):
                session.buyer_signed = True
                session.buyer_signed_hash = signed_hash
                logger.info(f"Session {session_id}: Buyer signed with hash {signed_hash[:8]}...")
            elif wallet_id in (session.seller_wallet_id, session.seller_address):
                session.seller_signed = True
                session.seller_signed_hash = signed_hash
                logger.info(f"Session {session_id}: Seller signed with hash {signed_hash[:8]}...")
            else:
                raise ValueError(f"Wallet {wallet_id} is not an authorized party for session {session_id}")

            session.updated_at_unix = int(time.time())

            # If both have signed with the valid matching hash -> transition to SETTLING
            started = False
            if session.buyer_signed and session.seller_signed:
                session.status = SessionStatus.SETTLING
                session.settlement_step = 1
                session.settlement_message = "Double signature verified (2/2). Starting on-chain atomic swap."
                logger.info(f"Session {session_id}: Double signature complete (2/2). Status -> SETTLING.")
                started = True

            return session, started

    def cancel_session(self, session_id: str, cancelled_by: str) -> Session:
        with self._lock:
            session = self._sessions[session_id]
            if session.status not in (SessionStatus.NEGOTIATING, SessionStatus.AWAITING_SIGNATURES):
                raise ValueError(f"Cannot cancel session {session_id} in state {session.status}")
            session.status = SessionStatus.CANCELLED_BY_USER
            session.updated_at_unix = int(time.time())
            logger.info(f"Session {session_id} cancelled by {cancelled_by}")
            return session

    def update_settlement_progress(self, session_id: str, step: int, message: str) -> None:
        with self._lock:
            if session_id in self._sessions:
                session = self._sessions[session_id]
                session.settlement_step = step
                session.settlement_message = message
                session.updated_at_unix = int(time.time())

    def set_txid(self, session_id: str, txid: str) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
            if session:
                session.txid = txid
                session.updated_at_unix = int(time.time())

    def set_settled(self, session_id: str, txid: str) -> Session:
        with self._lock:
            session = self._sessions[session_id]
            if session.status != SessionStatus.SETTLING:
                logger.warning(f"Session {session_id}: SETTLED ignored, session is {session.status}")
                return session
            session.status = SessionStatus.SETTLED
            session.txid = txid
            session.settlement_step = 7
            session.settlement_message = f"Atomic swap broadcast and settled successfully (txid: {txid})."
            session.updated_at_unix = int(time.time())
            logger.info(f"Session {session_id} -> SETTLED (txid: {txid})")
            return session

    def set_failed(self, session_id: str, error_message: str) -> Session:
        with self._lock:
            session = self._sessions[session_id]
            if session.status not in (SessionStatus.NEGOTIATING, SessionStatus.SETTLING):
                logger.warning(f"Session {session_id}: FAILED ignored, session is {session.status} ({error_message})")
                return session
            session.status = SessionStatus.FAILED
            session.error_message = error_message
            session.updated_at_unix = int(time.time())
            logger.error(f"Session {session_id} -> FAILED: {error_message}")
            return session

    def set_blocked(self, session_id: str, reason: str, trust_tier: str = "High Authenticity") -> Session:
        with self._lock:
            session = self._sessions[session_id]
            if session.status != SessionStatus.NEGOTIATING:
                logger.info(f"Session {session_id}: BLOCKED ignored, session is {session.status}")
                return session
            session.status = SessionStatus.BLOCKED_BY_GATE
            session.error_message = reason
            session.gate = {
                "passed": False,
                "trust_tier": trust_tier,
                "reasons": [reason],
            }
            session.updated_at_unix = int(time.time())
            logger.warning(f"Session {session_id} -> BLOCKED_BY_GATE: {reason}")
            return session

# Global session store instance
session_store = SessionStore()
