"""
MwM - HTTP API Server (FastAPI)
Implements the complete REST API contract for the Money with Memory frontend
(matching frontend/src/api/types.ts).

Key Endpoints:
- GET  /api/health
- GET  /api/market
- GET  /api/wallets
- GET  /api/wallets/{wallet_id}
- POST /api/wallets/create
- PUT  /api/wallets/{wallet_id}/aliases
- PUT  /api/wallets/{wallet_id}/agent_profile
- GET  /api/wallets/{wallet_id}/contacts
- POST /api/sessions
- GET  /api/sessions?wallet_id={wallet_id}
- GET  /api/sessions/{session_id}?wallet_id={wallet_id}
- POST /api/sessions/{session_id}/sign
- POST /api/sessions/{session_id}/cancel
- GET  /api/negotiations/queue
- GET  /api/shop?wallet_id=&kind=&asset_id=&q=
- POST /api/shop/wants
- POST /api/shop/{listing_id}/close
- POST /api/shop/agent_search
"""

import time
import uuid
import logging
import threading
from typing import Any, Dict, List, Optional, Tuple
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, Query, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
import requests

from backend.config import settings
from backend import regtest
from backend.seed import init_seed_state, SEED_WALLETS
from backend.memory_graph import memory_graph, TrustTier
from backend.deterministic_gate import (
    CanonicalSwapTerms,
    compute_terms_hash,
    evaluate_gate,
)
from backend.qvac_negotiator import negotiator, NegotiationContext
from backend.session_store import session_store, SessionStatus
from backend.rgb_swap_engine import RgbSwapEngine, WalletManager
from backend.market import market_manager
from backend.shop import shop_store, Want
from backend.negotiation_queue import NegotiationQueue
from backend.wallet_state import (
    wallet_state_manager,
    AgentProfile,
    WalletState,
)

logger = logging.getLogger("mwm.api")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# Global instances
wallet_mgr = WalletManager()
rgb_engine = RgbSwapEngine(wallet_mgr=wallet_mgr)

# Initialize seed identities & addresses immediately
init_seed_state()
for wid, info in SEED_WALLETS.items():
    try:
        _, _, addr = wallet_mgr.get_or_create_wallet(wid)
        wallet_state_manager.register_wallet(wid, info.label, addr)
    except Exception as exc:
        logger.warning(f"Could not initialize wallet {wid} on import: {exc}")

# Background workers lock
WORKER_LOCK = threading.Lock()

# ── Lifespan Startup / Shutdown ─────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Initializing MwM backend services...")
    # 1. Setup demo assets (PEPE and USDT) if regtest is reachable
    try:
        height = regtest.get_height()
        logger.info(f"Regtest online at block height {height}. Setting up demo assets...")
        assets = rgb_engine.setup_demo_environment()
        settings.PAYMENT_ASSET_ID = assets["usdt_asset_id"]
        settings.DEMO_ASSET_ID = assets["pepe_asset_id"]
        market_manager.set_asset_ids(assets["pepe_asset_id"], assets["usdt_asset_id"])
        wallet_state_manager.sync_demo_assets(assets["pepe_asset_id"], assets["usdt_asset_id"])
        shop_store.seed_demo_wants(assets["pepe_asset_id"])
        logger.info(f"Demo environment ready: PEPE={assets['pepe_asset_id'][:12]}... USDT={assets['usdt_asset_id'][:12]}...")
    except Exception as exc:
        logger.warning(f"Demo environment setup deferred (regtest offline or starting): {exc}")

    yield
    logger.info("MwM backend shut down cleanly.")

# ── FastAPI App Initialization ──────────────────────────────────────

app = FastAPI(
    title="MwM Protocol API",
    description="Agentic P2P Atomic Swaps on Bitcoin Regtest with Local QVAC Negotiation",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

from fastapi.exceptions import RequestValidationError

# ── Global Error Handler matching ApiErrorBody ──────────────────────

@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    messages = []
    for err in exc.errors():
        loc = ".".join(str(l) for l in err.get("loc", []))
        msg = err.get("msg", "Invalid value")
        messages.append(f"{loc}: {msg}" if loc else msg)
    combined_msg = "; ".join(messages) if messages else "Invalid request payload"
    return JSONResponse(
        status_code=400,
        content={"code": "invalid_request", "message": combined_msg},
    )

@app.exception_handler(HTTPException)
async def http_exception_handler(request: Request, exc: HTTPException):
    if isinstance(exc.detail, dict) and "code" in exc.detail:
        return JSONResponse(status_code=exc.status_code, content=exc.detail)
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": f"http_{exc.status_code}", "message": str(exc.detail)},
    )

@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception):
    logger.error(f"Unhandled server error on {request.url.path}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=500,
        content={"code": "internal_server_error", "message": str(exc)},
    )

# ── Request / Response Models ───────────────────────────────────────

class HealthResponse(BaseModel):
    regtest: bool
    qvac: bool
    proxy: bool

class WalletSummary(BaseModel):
    wallet_id: str
    label: str
    address: str

class CreateWalletRequest(BaseModel):
    label: str
    mnemonic: Optional[str] = None

class SetAliasRequest(BaseModel):
    address: str
    name: str

class UpdateAgentProfileRequest(BaseModel):
    seller_active: Optional[bool] = None
    offered_asset_id: Optional[str] = None
    offered_amount: Optional[int] = None
    asking_price_usd: Optional[int] = None
    secret_min_reserve_usd: Optional[int] = None
    seller_ai_prompt: Optional[str] = None
    buyer_max_ceiling_usd: Optional[int] = None
    buyer_target_usd: Optional[int] = None
    buyer_ai_prompt: Optional[str] = None

class CreateSessionRequest(BaseModel):
    buyer_wallet_id: str
    seller_address: str
    asset_id: str
    rgb_amount: int
    buyer_max_ceiling_usd: int
    buyer_target_usd: int
    buyer_ai_prompt: str

class SignSessionRequest(BaseModel):
    wallet_id: str
    terms_hash: str

class CancelSessionRequest(BaseModel):
    wallet_id: str

class CreateWantRequest(BaseModel):
    wallet_id: str
    asset_id: str
    # Validated by hand so a non-integer amount gets the contract's invalid_amount code.
    amount: Any
    target_usd: Any
    note: Optional[str] = None

class CloseListingRequest(BaseModel):
    wallet_id: str

class AgentSearchRequest(BaseModel):
    buyer_wallet_id: str
    asset_id: str
    rgb_amount: int
    buyer_max_ceiling_usd: int
    buyer_target_usd: int
    buyer_ai_prompt: str

# ── Health & Market ─────────────────────────────────────────────────

@app.get("/api/health", response_model=HealthResponse)
def get_health() -> HealthResponse:
    # 1. Regtest
    regtest_ok = False
    try:
        h = regtest.get_height()
        regtest_ok = h >= 0
    except Exception:
        regtest_ok = False

    # 2. QVAC
    qvac_ok = False
    if settings.QVAC_MOCK:
        qvac_ok = True
    else:
        try:
            headers = {}
            api_key = settings.get_api_key()
            if api_key:
                headers["Authorization"] = f"Bearer {api_key}"
            r = requests.get(f"{settings.QVAC_BASE_URL.rstrip('/')}/models", headers=headers, timeout=2.0)
            qvac_ok = r.status_code == 200
        except Exception:
            qvac_ok = False

    # 3. RGB Proxy
    proxy_ok = False
    try:
        r = requests.get(f"{settings.PROXY_URL.rstrip('/')}/", timeout=2.0)
        proxy_ok = r.status_code in (200, 400, 404, 405)
    except Exception:
        proxy_ok = False

    return HealthResponse(regtest=regtest_ok, qvac=qvac_ok, proxy=proxy_ok)

@app.get("/api/market")
def get_market():
    return market_manager.get_market().model_dump()

# ── Wallets ─────────────────────────────────────────────────────────

@app.get("/api/wallets", response_model=List[WalletSummary])
def list_wallets() -> List[WalletSummary]:
    summaries: List[WalletSummary] = []
    for wid, label in wallet_state_manager._labels.items():
        try:
            _, _, addr = wallet_mgr.get_or_create_wallet(wid)
            summaries.append(WalletSummary(wallet_id=wid, label=label, address=addr))
        except Exception:
            addr = wallet_state_manager._addresses.get(wid, "")
            summaries.append(WalletSummary(wallet_id=wid, label=label, address=addr))
    return summaries

@app.get("/api/wallets/{wallet_id}")
def get_wallet(wallet_id: str):
    if wallet_id not in wallet_state_manager._labels and wallet_id not in SEED_WALLETS:
        raise HTTPException(
            status_code=404,
            detail={"code": "wallet_not_found", "message": f"Wallet {wallet_id} does not exist"},
        )
    try:
        balances = wallet_mgr.get_balances(wallet_id)
    except Exception as exc:
        logger.warning(f"Could not load on-chain balances for {wallet_id}: {exc}")
        balances = {
            "wallet_id": wallet_id,
            "address": wallet_state_manager._addresses.get(wallet_id, ""),
            "btc_sats": 0,
            "assets": [],
        }

    state = wallet_state_manager.assemble_wallet_state(wallet_id, balances)
    return state.model_dump()

@app.post("/api/wallets/create", response_model=WalletSummary)
def create_wallet(req: CreateWalletRequest) -> WalletSummary:
    new_wid = f"wallet_{uuid.uuid4().hex[:8]}"
    try:
        _, _, addr = wallet_mgr.get_or_create_wallet(new_wid, mnemonic=req.mnemonic)
    except Exception as exc:
        raise HTTPException(
            status_code=500,
            detail={"code": "wallet_creation_failed", "message": str(exc)},
        )

    wallet_state_manager.register_wallet(new_wid, req.label, addr)
    memory_graph.register_wallet(new_wid, req.label)
    return WalletSummary(wallet_id=new_wid, label=req.label, address=addr)

@app.put("/api/wallets/{wallet_id}/aliases")
def set_alias(wallet_id: str, req: SetAliasRequest):
    return wallet_state_manager.set_alias(wallet_id, req.address, req.name)

@app.put("/api/wallets/{wallet_id}/agent_profile")
def update_agent_profile(wallet_id: str, req: UpdateAgentProfileRequest):
    updates = req.model_dump(exclude_unset=True)
    updated_profile = wallet_state_manager.update_profile(wallet_id, updates)
    return updated_profile.model_dump()

def _public_desk(wallet_id: str) -> Optional[Dict[str, Any]]:
    """Public part of a Seller Desk (never the reserve or the prompt); None if inactive."""
    profile = wallet_state_manager.get_profile(wallet_id)
    if not (profile.seller_active and profile.offered_asset_id):
        return None
    ticker = "PEPE"
    for ma in market_manager.get_market().assets:
        if ma.asset_id == profile.offered_asset_id:
            ticker = ma.ticker
            break
    return {
        "asset": {
            "asset_id": profile.offered_asset_id,
            "ticker": ticker,
            "schema": "NIA",
            "precision": 0,
        },
        "offered_amount": profile.offered_amount,
        "asking_price_usd": profile.asking_price_usd,
    }

def _trust_audit(rep) -> Dict[str, Any]:
    return {
        "trusted": rep.is_trusted,
        "sybil_ring_detected": rep.trust_tier == TrustTier.RING_ANOMALY,
        "reliability_pct": rep.reliability_pct,
        "trust_tier": rep.trust_tier,
        "assessment_summary": rep.assessment_summary,
    }

@app.get("/api/wallets/{wallet_id}/contacts")
def get_contacts(wallet_id: str):
    contacts: List[Dict[str, Any]] = []
    local_aliases = wallet_state_manager.get_aliases(wallet_id)

    # List all known counterparties from memory graph
    reps = memory_graph.list_contacts_for(wallet_id)
    for rep in reps:
        peer_id = rep.wallet_id
        peer_addr = wallet_state_manager._addresses.get(peer_id, "")
        if not peer_addr:
            try:
                _, _, peer_addr = wallet_mgr.get_or_create_wallet(peer_id)
                wallet_state_manager._addresses[peer_id] = peer_addr
            except Exception:
                peer_addr = f"bcrt1q{peer_id[:10]}"

        alias = local_aliases.get(peer_addr, rep.label if rep.label != peer_id else None)
        contacts.append({
            "address": peer_addr,
            "alias": alias,
            "trust": _trust_audit(rep),
            "desk": _public_desk(peer_id),
        })

    # Adding a contact is PUT aliases: aliased addresses outside the memory graph are contacts too.
    listed = {c["address"] for c in contacts}
    own_address = wallet_state_manager._addresses.get(wallet_id)
    for address, name in local_aliases.items():
        if address in listed or address == own_address:
            continue
        peer_id = wallet_state_manager.get_wallet_by_address(address)
        rep = memory_graph.get_reputation(peer_id or address)
        contacts.append({
            "address": address,
            "alias": name,
            "trust": _trust_audit(rep),
            "desk": _public_desk(peer_id) if peer_id else None,
        })
    return contacts

# ── Background Autonomous Negotiation Runner ────────────────────────

def run_negotiation_loop(session_id: str) -> None:
    """
    Executes autonomous negotiation rounds between Buyer and Seller until agreement, a stall,
    or the NEGOTIATION_MAX_ROUNDS safety cap. Enforces rationality bounds and the leak guard.
    """
    session = session_store.get_session(session_id)
    if not session or session.status != SessionStatus.NEGOTIATING:
        return

    # A queued negotiation may start after the lot was sold in another session.
    if _spendable(session.seller_wallet_id, session.asset_id) < session.asset_amount:
        session_store.set_blocked(session_id, "The seller no longer holds this lot.", trust_tier="High Authenticity")
        return

    max_rounds = settings.NEGOTIATION_MAX_ROUNDS
    offers_per_round: List[Tuple[int, int]] = []
    logger.info(f"Starting autonomous negotiation loop for session {session_id} (max {max_rounds} rounds)...")

    for r_num in range(1, max_rounds + 1):
        # Refresh session state
        session = session_store.get_session(session_id)
        if not session or session.status != SessionStatus.NEGOTIATING:
            logger.info(f"Negotiation loop exited early for session {session_id} (status: {session.status if session else 'None'})")
            return

        # ── Step A: Buyer Turn ──
        session.thinking = "buyer"
        time.sleep(0.3)

        current_bid = None
        current_ask = session.asking_price_usd
        for t in session.history:
            if t.speaker_wallet_id == session.buyer_wallet_id:
                current_bid = t.offer_usd
            elif t.speaker_wallet_id == session.seller_wallet_id:
                current_ask = t.offer_usd

        buyer_ctx = NegotiationContext(
            session_id=session_id,
            round_number=r_num,
            max_rounds=max_rounds,
            role="buyer",
            wallet_id=session.buyer_wallet_id,
            wallet_label="Wallet A",
            counterparty_wallet_id=session.seller_wallet_id,
            counterparty_label="Wallet B",
            asset_ticker=session.asset_ticker,
            asset_amount=session.asset_amount,
            payment_ticker=session.payment_ticker,
            secret_limit_usd=session.buyer_max_budget_usd,
            buyer_target_usd=session.buyer_target_usd,
            current_bid_usd=current_bid,
            current_ask_usd=current_ask,
            your_previous_offer_usd=current_bid,
            history=list(session.history),
        )

        try:
            buyer_turn = negotiator.generate_turn(buyer_ctx)
        except Exception as exc:
            logger.error(f"Buyer turn generation error in session {session_id}: {exc}")
            session_store.set_failed(session_id, f"Buyer agent inference failed: {exc}")
            return

        session_store.record_turn(session_id, buyer_turn)
        logger.info(f"Session {session_id} [R{r_num}] Buyer: {buyer_turn.action} {buyer_turn.offer_usd} USD")

        # Check if buyer accepted or crossed (strictly within buyer budget ceiling)
        buyer_can_accept = current_ask is not None and current_ask <= session.buyer_max_budget_usd
        if (buyer_turn.action == "ACCEPT" and buyer_can_accept) or (current_ask is not None and buyer_turn.offer_usd >= current_ask and current_ask <= session.buyer_max_budget_usd):
            agreed = current_ask
            finalize_agreement(session_id, agreed)
            return

        # ── Step B: Seller Turn ──
        session = session_store.get_session(session_id)
        if not session or session.status != SessionStatus.NEGOTIATING:
            return

        session.thinking = "seller"
        time.sleep(0.3)

        current_bid = buyer_turn.offer_usd
        seller_ctx = NegotiationContext(
            session_id=session_id,
            round_number=r_num,
            max_rounds=max_rounds,
            role="seller",
            wallet_id=session.seller_wallet_id,
            wallet_label="Wallet B",
            counterparty_wallet_id=session.buyer_wallet_id,
            counterparty_label="Wallet A",
            asset_ticker=session.asset_ticker,
            asset_amount=session.asset_amount,
            payment_ticker=session.payment_ticker,
            secret_limit_usd=session.seller_min_reserve_usd,
            current_bid_usd=current_bid,
            current_ask_usd=current_ask,
            your_previous_offer_usd=current_ask,
            history=list(session.history),
        )

        try:
            seller_turn = negotiator.generate_turn(seller_ctx)
        except Exception as exc:
            logger.error(f"Seller turn generation error in session {session_id}: {exc}")
            session_store.set_failed(session_id, f"Seller agent inference failed: {exc}")
            return

        session_store.record_turn(session_id, seller_turn)
        logger.info(f"Session {session_id} [R{r_num}] Seller: {seller_turn.action} {seller_turn.offer_usd} USD")

        # Check if seller accepted or crossed (strictly above seller reserve floor)
        seller_can_accept = current_bid is not None and current_bid >= session.seller_min_reserve_usd
        if (seller_turn.action == "ACCEPT" and seller_can_accept) or (current_bid is not None and seller_turn.offer_usd <= current_bid and current_bid >= session.seller_min_reserve_usd):
            agreed = current_bid
            finalize_agreement(session_id, agreed)
            return

        session.thinking = None

        # Two full rounds in which neither side moved: the negotiation has stalled.
        offers_per_round.append((buyer_turn.offer_usd, seller_turn.offer_usd))
        if len(offers_per_round) >= 3 and len(set(offers_per_round[-3:])) == 1:
            logger.info(f"Session {session_id}: offers unchanged for two rounds, stopping at round {r_num}.")
            session_store.set_blocked(session_id, "No agreement: the offers stopped moving.", trust_tier="High Authenticity")
            return

    logger.info(f"Session {session_id}: {max_rounds} rounds completed without agreement. Transitioning to BLOCKED_BY_GATE.")
    session = session_store.get_session(session_id)
    if session:
        session.thinking = None
    session_store.set_blocked(session_id, f"No agreement within {max_rounds} rounds.", trust_tier="High Authenticity")

def _run_negotiation_safely(session_id: str) -> None:
    try:
        run_negotiation_loop(session_id)
    except Exception as exc:
        logger.exception(f"Negotiation loop crashed for session {session_id}")
        session_store.set_failed(session_id, f"Negotiation error: {exc}")

negotiation_queue = NegotiationQueue(_run_negotiation_safely, concurrency=settings.NEGOTIATION_CONCURRENCY)

def _session_view(session, viewer_wallet_id: str) -> Dict[str, Any]:
    view = session.to_session_view(viewer_wallet_id=viewer_wallet_id)
    waiting = session.status == SessionStatus.NEGOTIATING
    view["queue_position"] = negotiation_queue.position(session.session_id) if waiting else None
    view["max_rounds"] = settings.NEGOTIATION_MAX_ROUNDS
    return view

def finalize_agreement(session_id: str, agreed_price_usd: int) -> None:
    """Prepares canonical terms, evaluates deterministic gate, and moves session to AWAITING_SIGNATURES."""
    session = session_store.get_session(session_id)
    if not session:
        return

    session.thinking = None
    now = int(time.time())

    # Deterministic Gate Check on agreed terms
    gate_res = evaluate_gate(
        session_id=session_id,
        asset_id=session.asset_id,
        rgb_amount=session.asset_amount,
        payment_asset_id=session.payment_asset_id,
        payment_amount=agreed_price_usd,
        agreed_price_usd=agreed_price_usd,
        network_fee_sat=session.network_fee_sat,
        buyer_address=session.buyer_address,
        seller_address=session.seller_address,
        expiry_unix=now + 600,
        active_signer_address=session.buyer_address,
        buyer_max_budget_usd=session.buyer_max_budget_usd,
        seller_min_reserve_usd=session.seller_min_reserve_usd,
        counterparty_wallet_id=session.seller_wallet_id,
    )

    if not gate_res.passed:
        logger.warning(f"Session {session_id} agreement blocked by gate: {gate_res.reason}")
        session_store.set_blocked(
            session_id,
            reason="Agreed price outside the secret limits",
            trust_tier="High Authenticity",
        )
        return

    canonical_terms = CanonicalSwapTerms(
        session_id=session_id,
        asset_id=session.asset_id,
        rgb_amount=session.asset_amount,
        payment_asset_id=session.payment_asset_id,
        payment_amount=agreed_price_usd,  # USDT precision 0 -> 1 USDT = 1 unit
        agreed_price_usd=agreed_price_usd,
        network_fee_sat=session.network_fee_sat,
        buyer_address=session.buyer_address,
        seller_address=session.seller_address,
        expiry_unix=now + 600,  # 10 minutes TTL
    )
    terms_hash = compute_terms_hash(canonical_terms)

    session_store.set_awaiting_signatures(
        session_id=session_id,
        agreed_price_usd=agreed_price_usd,
        payment_amount=agreed_price_usd,
        canonical_terms=canonical_terms,
        terms_hash=terms_hash,
    )
    logger.info(f"Session {session_id}: Agreement reached at {agreed_price_usd} USD. terms_hash={terms_hash[:12]}...")

# ── Background On-Chain Settlement Runner ───────────────────────────

def _btc_sats(wallet_id: str) -> Optional[int]:
    try:
        return wallet_mgr.get_balances(wallet_id)["btc_sats"]
    except Exception as exc:
        logger.warning(f"Could not read BTC balance of {wallet_id}: {exc}")
        return None

def run_settlement_worker(session_id: str) -> None:
    """Executes the 7-step atomic swap on Bitcoin regtest once both parties sign."""
    session = session_store.get_session(session_id)
    if not session or not session.terms:
        return

    terms = CanonicalSwapTerms(**session.terms)
    logger.info(f"Starting on-chain settlement worker for session {session_id}...")

    def progress_callback(step: int, msg: str) -> None:
        session_store.update_settlement_progress(session_id, step, msg)

    try:
        txid = rgb_engine.execute_atomic_swap(
            canonical_terms=terms,
            buyer_signed=session.buyer_signed,
            seller_signed=session.seller_signed,
            buyer_signed_hash=session.buyer_signed_hash or "",
            seller_signed_hash=session.seller_signed_hash or "",
            maker_wallet_id=session.seller_wallet_id,
            taker_wallet_id=session.buyer_wallet_id,
            progress_callback=progress_callback,
            txid_callback=lambda txid: session_store.set_txid(session_id, txid),
        )
        session_store.set_settled(session_id, txid)

        # Record trade in Layer-0 memory graph
        memory_graph.record_trade(
            source_wallet=session.buyer_wallet_id,
            counterparty=session.seller_wallet_id,
            asset_ticker=session.payment_ticker,
            amount=terms.payment_amount,
        )
        memory_graph.record_trade(
            source_wallet=session.seller_wallet_id,
            counterparty=session.buyer_wallet_id,
            asset_ticker=session.asset_ticker,
            amount=terms.rgb_amount,
        )

        # Update wallet state, activity records, and market price
        wallet_state_manager.record_swap_settlement(
            buyer_wallet_id=session.buyer_wallet_id,
            seller_wallet_id=session.seller_wallet_id,
            session_id=session_id,
            txid=txid,
            asset_id=session.asset_id,
            asset_ticker=session.asset_ticker,
            asset_amount=terms.rgb_amount,
            payment_asset_id=session.payment_asset_id,
            payment_ticker=session.payment_ticker,
            payment_amount=terms.payment_amount,
            agreed_price_usd=terms.agreed_price_usd,
            buyer_btc_sats=_btc_sats(session.buyer_wallet_id),
            seller_btc_sats=_btc_sats(session.seller_wallet_id),
        )
        logger.info(f"Session {session_id} successfully settled and confirmed. txid={txid}")
    except Exception as exc:
        logger.error(f"Settlement failed for session {session_id}: {exc}", exc_info=True)
        failure_msg = str(exc).strip() or repr(exc)
        failure_str = f"{type(exc).__name__}: {failure_msg}"
        session_store.set_failed(session_id, failure_str)

# ── Sessions Endpoints ──────────────────────────────────────────────

def _spendable(wallet_id: str, asset_id: str) -> int:
    try:
        return wallet_mgr.get_spendable(wallet_id, asset_id)
    except Exception as exc:
        logger.warning(f"Could not read {asset_id} balance of {wallet_id}: {exc}")
        return 0

@app.post("/api/sessions")
def create_session(req: CreateSessionRequest):
    session_id = f"sess_{uuid.uuid4().hex[:12]}"

    if req.buyer_wallet_id not in wallet_state_manager._labels:
        raise HTTPException(
            status_code=404,
            detail={"code": "wallet_not_found", "message": f"Wallet {req.buyer_wallet_id} does not exist"},
        )
    if req.rgb_amount <= 0:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_amount", "message": "Amount must be a positive integer"},
        )
    if req.buyer_target_usd <= 0 or req.buyer_target_usd > req.buyer_max_ceiling_usd:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_limits", "message": "Target must be positive and not above the ceiling"},
        )

    # 1. Resolve buyer address
    try:
        _, _, buyer_addr = wallet_mgr.get_or_create_wallet(req.buyer_wallet_id)
    except Exception:
        buyer_addr = wallet_state_manager._addresses.get(req.buyer_wallet_id, f"bcrt1q{req.buyer_wallet_id}")

    # 2. Resolve seller wallet; seeds whose address is not cached yet are opened first
    seller_wid = wallet_state_manager.get_wallet_by_address(req.seller_address)
    if not seller_wid:
        for sid in ("wallet_b", "wallet_sybil"):
            if sid not in wallet_state_manager._addresses:
                try:
                    _, _, sid_addr = wallet_mgr.get_or_create_wallet(sid)
                    wallet_state_manager._addresses[sid] = sid_addr
                except Exception:
                    pass
            if wallet_state_manager._addresses.get(sid) == req.seller_address:
                seller_wid = sid
                break

    if req.buyer_wallet_id == seller_wid or buyer_addr == req.seller_address:
        raise HTTPException(
            status_code=400,
            detail={"code": "self_trade", "message": "Cannot create a trade session with yourself"},
        )

    resolved_payment_asset_id = (
        market_manager.usdt_asset_id
        or settings.PAYMENT_ASSET_ID
        or "rgb:IWq5H3Er-Mpe5VLG-6P91nnY-pwK0_EY-7FJUG1i-IWp8RuM"
    )
    seller_profile = wallet_state_manager.get_profile(seller_wid) if seller_wid else None

    def new_session(status_: str, gate_info: Optional[Dict[str, Any]] = None):
        return session_store.create_session(
            session_id=session_id,
            asset_id=req.asset_id,
            asset_ticker=settings.DEMO_ASSET_TICKER,
            asset_amount=req.rgb_amount,
            payment_asset_id=resolved_payment_asset_id,
            payment_ticker=settings.PAYMENT_ASSET_TICKER,
            buyer_wallet_id=req.buyer_wallet_id,
            seller_wallet_id=seller_wid or req.seller_address,
            buyer_address=buyer_addr,
            seller_address=req.seller_address,
            asking_price_usd=seller_profile.asking_price_usd if seller_profile else 0,
            buyer_max_budget_usd=req.buyer_max_ceiling_usd,
            buyer_target_usd=req.buyer_target_usd,
            seller_min_reserve_usd=seller_profile.secret_min_reserve_usd if seller_profile else 0,
            network_fee_sat=2_000,
            expiry_seconds=600,
            initial_status=status_,
            initial_gate=gate_info,
        )

    # 3. Layer-0 trust gate on both parties: rings, Unverified wallets and unknown
    # addresses are born BLOCKED_BY_GATE without any QVAC call.
    if not seller_wid:
        reasons = ["Counterparty has no active desk."]
        seller_tier = TrustTier.UNVERIFIED
    else:
        reasons = []
        seller_tier = memory_graph.get_reputation(seller_wid).trust_tier
        for who, wid in (("Counterparty", seller_wid), ("Buyer", req.buyer_wallet_id)):
            rep = memory_graph.get_reputation(wid)
            if rep.trust_tier in (TrustTier.RING_ANOMALY, TrustTier.UNVERIFIED) or not rep.is_trusted:
                reasons.append(f"{who} trust check failed: {rep.trust_tier}")
    if reasons:
        logger.warning(f"Session creation blocked by gate: {reasons}")
        session = new_session(
            SessionStatus.BLOCKED_BY_GATE,
            {"passed": False, "trust_tier": seller_tier, "reasons": reasons},
        )
        return _session_view(session, req.buyer_wallet_id)

    # 4. Desk and balances (contract: 409 seller_desk_inactive / insufficient_funds)
    if not seller_profile.seller_active or seller_profile.offered_asset_id != req.asset_id:
        raise HTTPException(
            status_code=409,
            detail={"code": "seller_desk_inactive", "message": "The counterparty is not selling this asset"},
        )
    if _spendable(seller_wid, req.asset_id) < req.rgb_amount:
        raise HTTPException(
            status_code=409,
            detail={"code": "insufficient_funds", "message": "The seller does not hold that amount"},
        )
    if _spendable(req.buyer_wallet_id, resolved_payment_asset_id) < req.buyer_max_ceiling_usd:
        raise HTTPException(
            status_code=409,
            detail={"code": "insufficient_funds", "message": "USDT balance is below the ceiling"},
        )

    # 5. Create negotiating session
    session = new_session(SessionStatus.NEGOTIATING)

    # Negotiations share one local model: they run in arrival order through the queue.
    negotiation_queue.submit(session_id)

    return _session_view(session, req.buyer_wallet_id)

@app.get("/api/sessions")
def list_sessions(wallet_id: str = Query(...)):
    sessions = session_store.list_sessions_for(wallet_id)
    return [s.to_summary(viewer_wallet_id=wallet_id) for s in sessions]

@app.get("/api/negotiations/queue")
def get_negotiation_queue():
    """Negotiations using QVAC now, and those waiting in arrival order."""
    return negotiation_queue.snapshot()

@app.get("/api/sessions/{session_id}")
def get_session(session_id: str, wallet_id: str = Query(...)):
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(
            status_code=404,
            detail={"code": "session_not_found", "message": f"Session {session_id} does not exist"},
        )
    participants = (session.buyer_wallet_id, session.buyer_address, session.seller_wallet_id, session.seller_address)
    if wallet_id not in participants:
        raise HTTPException(
            status_code=403,
            detail={"code": "forbidden", "message": "Wallet is not part of this session"},
        )
    return _session_view(session, wallet_id)

@app.post("/api/sessions/{session_id}/sign")
def sign_session(session_id: str, req: SignSessionRequest):
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(
            status_code=404,
            detail={"code": "session_not_found", "message": f"Session {session_id} does not exist"},
        )

    # get_session() has already moved stale AWAITING_SIGNATURES sessions to EXPIRED.
    if session.status == SessionStatus.EXPIRED:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "expired", "message": "The terms expired before both signatures"},
        )

    if session.status != SessionStatus.AWAITING_SIGNATURES:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "not_awaiting_signatures", "message": f"Session is {session.status}"},
        )

    is_buyer = req.wallet_id in (session.buyer_wallet_id, session.buyer_address)
    is_seller = req.wallet_id in (session.seller_wallet_id, session.seller_address)
    if not (is_buyer or is_seller):
        raise HTTPException(
            status_code=403,
            detail={"code": "forbidden", "message": "Wallet is not part of this session"},
        )

    if (is_buyer and session.buyer_signed) or (is_seller and session.seller_signed):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "already_signed", "message": "This wallet already signed"},
        )

    # Validate terms_hash: mandatory, must match active session terms_hash
    if not req.terms_hash or req.terms_hash != session.terms_hash:
        logger.warning(f"Signature mismatch on session {session_id}: expected {session.terms_hash}, got {req.terms_hash}")
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "terms_hash_mismatch", "message": "The signed terms differ from the active terms"},
        )

    active_hash = session.terms_hash or ""
    try:
        _, started = session_store.sign_session(session_id, req.wallet_id, active_hash)
    except ValueError as exc:
        # The session changed state since the checks above (e.g. a concurrent cancel).
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "not_awaiting_signatures", "message": str(exc)},
        )

    if started:
        thread = threading.Thread(target=run_settlement_worker, args=(session_id,), daemon=True)
        thread.start()

    return _session_view(session, req.wallet_id)

@app.post("/api/sessions/{session_id}/cancel")
def cancel_session(session_id: str, req: CancelSessionRequest):
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(
            status_code=404,
            detail={"code": "session_not_found", "message": f"Session {session_id} does not exist"},
        )

    is_buyer = req.wallet_id in (session.buyer_wallet_id, session.buyer_address)
    is_seller = req.wallet_id in (session.seller_wallet_id, session.seller_address)
    if not (is_buyer or is_seller):
        raise HTTPException(
            status_code=403,
            detail={"code": "forbidden", "message": "Wallet is not part of this session"},
        )

    if session.status not in (SessionStatus.NEGOTIATING, SessionStatus.AWAITING_SIGNATURES):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "not_cancellable", "message": f"Session is {session.status}"},
        )

    try:
        session_store.cancel_session(session_id, req.wallet_id)
        negotiation_queue.discard(session_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={"code": "not_cancellable", "message": f"Session is {session.status}"},
        )
    return _session_view(session, req.wallet_id)

# ── Shop ────────────────────────────────────────────────────────────

def _require_wallet(wallet_id: str) -> None:
    if wallet_id not in wallet_state_manager._labels:
        raise HTTPException(
            status_code=404,
            detail={"code": "wallet_not_found", "message": f"Wallet {wallet_id} does not exist"},
        )

def _asset_ref(asset_id: str) -> Dict[str, Any]:
    ticker = next((a.ticker for a in market_manager.get_market().assets if a.asset_id == asset_id), asset_id)
    return {"asset_id": asset_id, "ticker": ticker, "schema": "NIA", "precision": 0}

def _sell_listings(viewer_id: str) -> List[Dict[str, Any]]:
    """Active Seller Desks, public fields only (never the reserve or the prompt)."""
    aliases = wallet_state_manager.get_aliases(viewer_id)
    listings: List[Dict[str, Any]] = []
    for owner_id in list(wallet_state_manager._labels):
        desk = _public_desk(owner_id)
        if not desk or desk["offered_amount"] <= 0:
            continue
        owner_address = wallet_state_manager._addresses.get(owner_id, "")
        listings.append({
            "listing_id": f"desk_{owner_id}",
            "kind": "sell",
            "owner_address": owner_address,
            "owner_alias": aliases.get(owner_address),
            "is_mine": owner_id == viewer_id,
            "asset": desk["asset"],
            "amount": desk["offered_amount"],
            "price_usd": desk["asking_price_usd"],
            "note": None,
            "trust": _trust_audit(memory_graph.get_reputation(owner_id)),
            "created_at": None,
        })
    return listings

def _want_listing(want: Want, viewer_id: str) -> Dict[str, Any]:
    if want.owner_wallet_id:
        owner_address = wallet_state_manager._addresses.get(want.owner_wallet_id, "")
        rep = memory_graph.get_reputation(want.owner_wallet_id)
    else:
        owner_address = want.owner_address or ""
        rep = memory_graph.get_reputation(wallet_state_manager.get_wallet_by_address(owner_address) or owner_address)
    price = want.target_usd
    return {
        "listing_id": want.want_id,
        "kind": "want",
        "owner_address": owner_address,
        "owner_alias": wallet_state_manager.get_aliases(viewer_id).get(owner_address),
        "is_mine": want.owner_wallet_id == viewer_id,
        "asset": _asset_ref(want.asset_id),
        "amount": want.amount,
        "price_usd": int(price) if float(price).is_integer() else price,
        "note": want.note,
        "trust": _trust_audit(rep),
        "created_at": want.created_at,
    }

def _positive_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float) and value.is_integer() and value > 0:
        return int(value)
    return None

@app.get("/api/shop")
def get_shop(
    wallet_id: str = Query(...),
    kind: Optional[str] = Query(None),
    asset_id: Optional[str] = Query(None),
    q: Optional[str] = Query(None),
):
    _require_wallet(wallet_id)
    listings = _sell_listings(wallet_id) + [_want_listing(w, wallet_id) for w in shop_store.list_open()]
    text = (q or "").strip().lower()

    def matches(listing: Dict[str, Any]) -> bool:
        if kind and listing["kind"] != kind:
            return False
        if asset_id and listing["asset"]["asset_id"] != asset_id:
            return False
        if not text:
            return True
        fields = (listing["owner_alias"], listing["owner_address"], listing["asset"]["ticker"], listing["note"])
        return any(f and text in f.lower() for f in fields)

    return [l for l in listings if matches(l)]

@app.post("/api/shop/wants")
def create_want(req: CreateWantRequest):
    _require_wallet(req.wallet_id)
    rgb_asset_ids = {a.asset_id for a in market_manager.get_market().assets}
    if req.asset_id not in rgb_asset_ids:
        raise HTTPException(status_code=400, detail={"code": "invalid_asset", "message": "Unknown RGB asset"})
    amount = _positive_int(req.amount)
    if amount is None:
        raise HTTPException(status_code=400, detail={"code": "invalid_amount", "message": "Amount must be a positive integer"})
    target = req.target_usd
    if isinstance(target, bool) or not isinstance(target, (int, float)) or not target > 0:
        raise HTTPException(status_code=400, detail={"code": "invalid_price", "message": "The target price must be greater than 0"})

    want = shop_store.create_want(
        owner_wallet_id=req.wallet_id,
        asset_id=req.asset_id,
        amount=amount,
        target_usd=float(target),
        note=req.note,
    )
    return _want_listing(want, req.wallet_id)

@app.post("/api/shop/{listing_id}/close")
def close_listing(listing_id: str, req: CloseListingRequest):
    _require_wallet(req.wallet_id)
    if listing_id.startswith("desk_"):
        raise HTTPException(
            status_code=400,
            detail={"code": "desk_listing", "message": "Turn off your Seller Desk to remove this listing"},
        )
    want = shop_store.get(listing_id)
    if not want or want.closed:
        raise HTTPException(
            status_code=404,
            detail={"code": "listing_not_found", "message": f"No open listing {listing_id}"},
        )
    if want.owner_wallet_id != req.wallet_id:
        raise HTTPException(status_code=403, detail={"code": "forbidden", "message": "This listing is not yours"})
    return _want_listing(shop_store.close(listing_id), req.wallet_id)

@app.post("/api/shop/agent_search")
def agent_search(req: AgentSearchRequest):
    """The buyer's agent picks the cheapest fitting Seller Desk (rings skipped) and opens a session."""
    _require_wallet(req.buyer_wallet_id)

    def price_for(listing: Dict[str, Any]) -> float:
        return listing["price_usd"] * req.rgb_amount / listing["amount"]

    fits = [
        l for l in _sell_listings(req.buyer_wallet_id)
        if not l["is_mine"]
        and l["asset"]["asset_id"] == req.asset_id
        and l["amount"] >= req.rgb_amount
        and l["trust"]["trust_tier"] != TrustTier.RING_ANOMALY
        and price_for(l) <= 1.5 * req.buyer_max_ceiling_usd
    ]
    if not fits:
        raise HTTPException(status_code=404, detail={"code": "no_match", "message": "No matching listing right now"})
    best = min(fits, key=price_for)

    session = create_session(CreateSessionRequest(
        buyer_wallet_id=req.buyer_wallet_id,
        seller_address=best["owner_address"],
        asset_id=req.asset_id,
        rgb_amount=req.rgb_amount,
        buyer_max_ceiling_usd=req.buyer_max_ceiling_usd,
        buyer_target_usd=req.buyer_target_usd,
        buyer_ai_prompt=req.buyer_ai_prompt,
    ))
    return {"listing": best, "session": session}
