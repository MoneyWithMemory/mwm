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
"""

import time
import uuid
import logging
import threading
from typing import Any, Dict, List, Optional
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
        market_manager.set_asset_ids(assets["pepe_asset_id"], assets["usdt_asset_id"])
        # Update offered asset on seller profile
        wallet_state_manager.update_profile("wallet_b", {"offered_asset_id": assets["pepe_asset_id"]})
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

# ── Global Error Handler matching ApiErrorBody ──────────────────────

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
    terms_hash: Optional[str] = None

class CancelSessionRequest(BaseModel):
    wallet_id: str

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
            r = requests.get(f"{settings.QVAC_BASE_URL.rstrip('/')}/models", timeout=2.0)
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
            "btc_sats": 100_000_000,
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
            "trust": {
                "trusted": rep.is_trusted,
                "sybil_ring_detected": rep.trust_tier == TrustTier.RING_ANOMALY,
                "reliability_pct": rep.reliability_pct,
                "trust_tier": rep.trust_tier,
                "assessment_summary": rep.assessment_summary,
            },
        })
    return contacts

# ── Background Autonomous Negotiation Runner ────────────────────────

def run_negotiation_loop(session_id: str) -> None:
    """
    Executes autonomous negotiation rounds (1 to 4) between Buyer and Seller.
    Enforces rationality bounds, leak guard, and 4-round agreement cut-off.
    """
    session = session_store.get_session(session_id)
    if not session or session.status != SessionStatus.NEGOTIATING:
        return

    logger.info(f"Starting autonomous negotiation loop for session {session_id}...")

    for r_num in range(1, 5):
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
            role="buyer",
            wallet_id=session.buyer_wallet_id,
            wallet_label="Wallet A",
            counterparty_wallet_id=session.seller_wallet_id,
            counterparty_label="Wallet B",
            asset_ticker=session.asset_ticker,
            asset_amount=session.asset_amount,
            payment_ticker=session.payment_ticker,
            secret_limit_usd=session.buyer_max_budget_usd,
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

        # Check if buyer accepted or crossed
        if buyer_turn.action == "ACCEPT" or (current_ask is not None and buyer_turn.offer_usd >= current_ask):
            agreed = current_ask if buyer_turn.action == "ACCEPT" else min(buyer_turn.offer_usd, current_ask or buyer_turn.offer_usd)
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

        # Check if seller accepted or crossed
        if seller_turn.action == "ACCEPT" or (current_bid is not None and seller_turn.offer_usd <= current_bid):
            agreed = current_bid if seller_turn.action == "ACCEPT" else max(seller_turn.offer_usd, current_bid or seller_turn.offer_usd)
            finalize_agreement(session_id, agreed)
            return

        session.thinking = None

    # End of Round 4 without agreement -> BLOCKED_BY_GATE
    logger.info(f"Session {session_id}: 4 rounds completed without agreement. Transitioning to BLOCKED_BY_GATE.")
    session = session_store.get_session(session_id)
    if session:
        session.thinking = None
    session_store.set_blocked(session_id, "No agreement within 4 rounds", trust_tier="High Authenticity")

def finalize_agreement(session_id: str, agreed_price_usd: int) -> None:
    """Prepares canonical terms, computes terms_hash, and moves session to AWAITING_SIGNATURES."""
    session = session_store.get_session(session_id)
    if not session:
        return

    session.thinking = None
    now = int(time.time())
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
        expiry_unix=now + 3600,
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
            progress_callback=progress_callback,
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
        )
        logger.info(f"Session {session_id} successfully settled and confirmed. txid={txid}")
    except Exception as exc:
        logger.error(f"Settlement failed for session {session_id}: {exc}", exc_info=True)
        session_store.set_failed(session_id, str(exc))

# ── Sessions Endpoints ──────────────────────────────────────────────

@app.post("/api/sessions")
def create_session(req: CreateSessionRequest):
    session_id = f"sess_{uuid.uuid4().hex[:12]}"

    # 1. Resolve buyer address
    try:
        _, _, buyer_addr = wallet_mgr.get_or_create_wallet(req.buyer_wallet_id)
    except Exception:
        buyer_addr = wallet_state_manager._addresses.get(req.buyer_wallet_id, f"bcrt1q{req.buyer_wallet_id}")

    # 2. Resolve seller wallet and address
    seller_wid = wallet_state_manager.get_wallet_by_address(req.seller_address)
    if not seller_wid:
        # Fallback resolution: check if address matches any known seed
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
    if not seller_wid:
        seller_wid = "wallet_b"

    seller_profile = wallet_state_manager.get_profile(seller_wid)
    seller_addr = req.seller_address

    # 3. Preventive Counterparty Trust Check (Layer-0 Memory Graph)
    # If counterparty is Ring Anomaly Detected or Unverified, session is born BLOCKED_BY_GATE without QVAC!
    rep = memory_graph.get_reputation(seller_wid)
    if rep.trust_tier in (TrustTier.RING_ANOMALY, TrustTier.UNVERIFIED) or not rep.is_trusted:
        logger.warning(f"Session creation blocked by gate: counterparty {seller_wid} trust_tier={rep.trust_tier}")
        gate_info = {
            "passed": False,
            "trust_tier": rep.trust_tier,
            "reasons": [f"Counterparty trust check failed: {rep.trust_tier}"],
        }
        session = session_store.create_session(
            session_id=session_id,
            asset_id=req.asset_id,
            asset_ticker=settings.DEMO_ASSET_TICKER,
            asset_amount=req.rgb_amount,
            payment_asset_id=settings.PAYMENT_ASSET_ID or "rgb:usdt_nia",
            payment_ticker=settings.PAYMENT_ASSET_TICKER,
            buyer_wallet_id=req.buyer_wallet_id,
            seller_wallet_id=seller_wid,
            buyer_address=buyer_addr,
            seller_address=seller_addr,
            asking_price_usd=seller_profile.asking_price_usd,
            buyer_max_budget_usd=req.buyer_max_ceiling_usd,
            seller_min_reserve_usd=seller_profile.secret_min_reserve_usd,
            network_fee_sat=2_000,
            initial_status=SessionStatus.BLOCKED_BY_GATE,
            initial_gate=gate_info,
        )
        return session.to_session_view(viewer_wallet_id=req.buyer_wallet_id)

    # 4. Create negotiating session
    session = session_store.create_session(
        session_id=session_id,
        asset_id=req.asset_id,
        asset_ticker=settings.DEMO_ASSET_TICKER,
        asset_amount=req.rgb_amount,
        payment_asset_id=settings.PAYMENT_ASSET_ID or "rgb:usdt_nia",
        payment_ticker=settings.PAYMENT_ASSET_TICKER,
        buyer_wallet_id=req.buyer_wallet_id,
        seller_wallet_id=seller_wid,
        buyer_address=buyer_addr,
        seller_address=seller_addr,
        asking_price_usd=seller_profile.asking_price_usd,
        buyer_max_budget_usd=req.buyer_max_ceiling_usd,
        seller_min_reserve_usd=seller_profile.secret_min_reserve_usd,
        network_fee_sat=2_000,
        initial_status=SessionStatus.NEGOTIATING,
    )

    # Launch background autonomous negotiation loop
    thread = threading.Thread(target=run_negotiation_loop, args=(session_id,), daemon=True)
    thread.start()

    return session.to_session_view(viewer_wallet_id=req.buyer_wallet_id)

@app.get("/api/sessions")
def list_sessions(wallet_id: str = Query(...)):
    sessions = session_store.list_sessions_for(wallet_id)
    return [s.to_summary(viewer_wallet_id=wallet_id) for s in sessions]

@app.get("/api/sessions/{session_id}")
def get_session(session_id: str, wallet_id: str = Query(...)):
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(
            status_code=404,
            detail={"code": "session_not_found", "message": f"Session {session_id} does not exist"},
        )
    return session.to_session_view(viewer_wallet_id=wallet_id)

@app.post("/api/sessions/{session_id}/sign")
def sign_session(session_id: str, req: SignSessionRequest):
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(
            status_code=404,
            detail={"code": "session_not_found", "message": f"Session {session_id} does not exist"},
        )

    if session.status != SessionStatus.AWAITING_SIGNATURES:
        raise HTTPException(
            status_code=400,
            detail={"code": "invalid_session_state", "message": f"Cannot sign session in state {session.status}"},
        )

    # Validate terms_hash: if provided by user, must match active session terms_hash
    if req.terms_hash is not None and session.terms_hash is not None:
        if req.terms_hash != session.terms_hash:
            logger.warning(f"Signature mismatch on session {session_id}: expected {session.terms_hash}, got {req.terms_hash}")
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail={"code": "terms_hash_mismatch", "message": "Terms hash mismatch with active session terms"},
            )

    active_hash = session.terms_hash or ""
    try:
        session_store.sign_session(session_id, req.wallet_id, active_hash)
    except Exception as exc:
        raise HTTPException(
            status_code=400,
            detail={"code": "sign_error", "message": str(exc)},
        )

    # If both signed -> start on-chain atomic swap in background
    if session.buyer_signed and session.seller_signed:
        thread = threading.Thread(target=run_settlement_worker, args=(session_id,), daemon=True)
        thread.start()

    return session.to_session_view(viewer_wallet_id=req.wallet_id)

@app.post("/api/sessions/{session_id}/cancel")
def cancel_session(session_id: str, req: CancelSessionRequest):
    session = session_store.get_session(session_id)
    if not session:
        raise HTTPException(
            status_code=404,
            detail={"code": "session_not_found", "message": f"Session {session_id} does not exist"},
        )

    if session.status in (SessionStatus.SETTLING, SessionStatus.SETTLED):
        raise HTTPException(
            status_code=400,
            detail={"code": "cannot_cancel", "message": f"Cannot cancel session in state {session.status}"},
        )

    session_store.cancel_session(session_id, req.wallet_id)
    return session.to_session_view(viewer_wallet_id=req.wallet_id)
