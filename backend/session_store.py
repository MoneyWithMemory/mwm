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
from typing import Any, Dict, List, Optional
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

    history: List[NegotiationTurn] = Field(default_factory=list)
    created_at_unix: int = Field(default_factory=lambda: int(time.time()))

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
        expiry_seconds: int = 3600,
        network_fee_sat: int = 2_000,
    ) -> Session:
        with self._lock:
            now = int(time.time())
            session = Session(
                session_id=session_id,
                status=SessionStatus.NEGOTIATING,
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
                seller_min_reserve_usd=seller_min_reserve_usd,
                network_fee_sat=network_fee_sat,
                expiry_unix=now + expiry_seconds,
                created_at_unix=now,
            )
            self._sessions[session_id] = session
            return session

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
            session.status = SessionStatus.AWAITING_SIGNATURES
            session.agreed_price_usd = agreed_price_usd
            session.payment_amount = payment_amount
            session.terms = canonical_terms.model_dump()
            session.terms_hash = terms_hash
            session.expiry_unix = canonical_terms.expiry_unix
            return session

    def sign_session(self, session_id: str, wallet_id: str, signed_hash: str) -> Session:
        """
        Record signature from buyer or seller.
        If signed_hash does not match session terms_hash, rejects transition.
        If both have signed with matching hash, transitions to SETTLING.
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

            # If both have signed with the valid matching hash -> transition to SETTLING
            if session.buyer_signed and session.seller_signed:
                session.status = SessionStatus.SETTLING
                session.settlement_step = 1
                session.settlement_message = "Double signature verified (2/2). Starting on-chain atomic swap."
                logger.info(f"Session {session_id}: Double signature complete (2/2). Status -> SETTLING.")

            return session

    def cancel_session(self, session_id: str, cancelled_by: str) -> Session:
        with self._lock:
            session = self._sessions[session_id]
            if session.status in (SessionStatus.SETTLING, SessionStatus.SETTLED):
                raise ValueError(f"Cannot cancel session {session_id} in state {session.status}")
            session.status = SessionStatus.CANCELLED_BY_USER
            logger.info(f"Session {session_id} cancelled by {cancelled_by}")
            return session

    def update_settlement_progress(self, session_id: str, step: int, message: str) -> None:
        with self._lock:
            if session_id in self._sessions:
                session = self._sessions[session_id]
                session.settlement_step = step
                session.settlement_message = message

    def set_settled(self, session_id: str, txid: str) -> Session:
        with self._lock:
            session = self._sessions[session_id]
            session.status = SessionStatus.SETTLED
            session.txid = txid
            session.settlement_step = 7
            session.settlement_message = f"Atomic swap broadcast and settled successfully (txid: {txid})."
            logger.info(f"Session {session_id} -> SETTLED (txid: {txid})")
            return session

    def set_failed(self, session_id: str, error_message: str) -> Session:
        with self._lock:
            session = self._sessions[session_id]
            session.status = SessionStatus.FAILED
            session.error_message = error_message
            logger.error(f"Session {session_id} -> FAILED: {error_message}")
            return session

    def set_blocked(self, session_id: str, reason: str) -> Session:
        with self._lock:
            session = self._sessions[session_id]
            session.status = SessionStatus.BLOCKED_BY_GATE
            session.error_message = reason
            logger.warning(f"Session {session_id} -> BLOCKED_BY_GATE: {reason}")
            return session

# Global session store instance
session_store = SessionStore()
