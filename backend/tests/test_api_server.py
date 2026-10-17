"""
API Server Test Suite (FastAPI TestClient)
Verifies all 12 API endpoints, error handling, perspective privacy masking,
pre-signature security gates, signature hash verification (409 on mismatch),
and state machine progression.
"""

import time
import pytest
from fastapi.testclient import TestClient

from backend.api_server import app
from backend.session_store import session_store, SessionStatus
from backend.deterministic_gate import compute_terms_hash, CanonicalSwapTerms

client = TestClient(app)


def _desk_asset() -> str:
    return client.get("/api/wallets/wallet_b").json()["agent_profile"]["offered_asset_id"]


def _reset_desk(asking: int = 150, reserve: int = 110) -> None:
    client.put("/api/wallets/wallet_b/agent_profile", json={
        "seller_active": True, "asking_price_usd": asking, "secret_min_reserve_usd": reserve, "offered_amount": 1_000_000,
    })


def _fund_wallets(monkeypatch, amount: int = 10**9) -> None:
    # Test wallets live in a temp dir with no RGB assets; stub the balance read.
    monkeypatch.setattr("backend.api_server._spendable", lambda wallet_id, asset_id: amount)

def test_health_endpoint():
    resp = client.get("/api/health")
    assert resp.status_code == 200
    data = resp.json()
    assert "regtest" in data
    assert "qvac" in data
    assert "proxy" in data
    assert isinstance(data["regtest"], bool)
    assert isinstance(data["qvac"], bool)
    assert isinstance(data["proxy"], bool)

def test_market_endpoint():
    resp = client.get("/api/market")
    assert resp.status_code == 200
    data = resp.json()
    assert data["mode"] == "fixed_simulated"
    assert data["sats_per_usd"] == 1000
    assert len(data["assets"]) >= 2
    usdt_asset = next(a for a in data["assets"] if a["ticker"] == "USDT")
    assert usdt_asset["price_usd"] == 1.0
    assert usdt_asset["precision"] == 0
    assert usdt_asset["source"] == "fixed_peg"
    pepe_asset = next(a for a in data["assets"] if a["ticker"] == "PEPE")
    assert pepe_asset["precision"] == 0

def test_wallets_list_and_details():
    resp = client.get("/api/wallets")
    assert resp.status_code == 200
    wallets = resp.json()
    assert len(wallets) >= 3
    wids = [w["wallet_id"] for w in wallets]
    assert "wallet_a" in wids
    assert "wallet_b" in wids
    assert "wallet_sybil" in wids

    # Check Wallet A details
    resp_a = client.get("/api/wallets/wallet_a")
    assert resp_a.status_code == 200
    wa = resp_a.json()
    assert wa["wallet_id"] == "wallet_a"
    assert wa["label"] == "Wallet A"
    assert "assets" in wa
    # Check assets use "schema", not "schema_type"
    for asset in wa["assets"]:
        assert "schema" in asset
        assert "schema_type" not in asset
    assert "history_points" in wa
    for hp in wa["history_points"]:
        assert "btc" in hp["balances"]
    assert "btc" in wa["avg_cost_basis"]
    assert wa["agent_profile"]["buyer_max_ceiling_usd"] == 135

    # Wallet B history starts from the seeded 0.01 BTC (1,000 USD at 1,000 sats/USD)
    resp_b = client.get("/api/wallets/wallet_b")
    assert resp_b.status_code == 200
    wb = resp_b.json()
    assert wb["history_points"][0]["balances"]["btc"] == 1_000_000
    assert wb["history_points"][0]["total_usd"] == 1_000.0

def test_put_agent_profile_seller_desk():
    """Verify PUT /api/wallets/{id}/agent_profile updates seller desk settings."""
    payload = {
        "seller_active": True,
        "asking_price_usd": 160,
        "secret_min_reserve_usd": 120,
        "seller_ai_prompt": "Updated tactical seller instructions.",
    }
    resp = client.put("/api/wallets/wallet_b/agent_profile", json=payload)
    assert resp.status_code == 200
    profile = resp.json()
    assert profile["seller_active"] is True
    assert profile["asking_price_usd"] == 160
    assert profile["secret_min_reserve_usd"] == 120
    assert profile["seller_ai_prompt"] == "Updated tactical seller instructions."
    assert "buyer_max_ceiling_usd" in profile

def test_put_aliases_and_get_contacts():
    """Verify alias creation and contact list with trust audit."""
    # Set alias
    resp_alias = client.put("/api/wallets/wallet_a/aliases", json={
        "address": "bcrt1q_test_seller",
        "name": "Trusted Liquidity Provider",
    })
    assert resp_alias.status_code == 200
    aliases = resp_alias.json()
    assert aliases["bcrt1q_test_seller"] == "Trusted Liquidity Provider"

    # Get contacts for wallet_a
    resp_contacts = client.get("/api/wallets/wallet_a/contacts")
    assert resp_contacts.status_code == 200
    contacts = resp_contacts.json()
    assert len(contacts) >= 2
    # Check Sybil contact reflects Ring Anomaly Detected
    sybil_contact = next(c for c in contacts if c["trust"]["sybil_ring_detected"] is True)
    assert sybil_contact["trust"]["trust_tier"] == "Ring Anomaly Detected"
    assert sybil_contact["trust"]["trusted"] is False

    # Check desk presence on contacts
    for c in contacts:
        assert "desk" in c
    # Wallet B has active desk
    wallet_b_contact = next((c for c in contacts if c.get("desk") is not None), None)
    assert wallet_b_contact is not None
    assert wallet_b_contact["desk"]["asking_price_usd"] > 0
    assert "secret_min_reserve_usd" not in wallet_b_contact["desk"]
    assert "seller_ai_prompt" not in wallet_b_contact["desk"]

def test_session_blocked_immediately_by_gate_on_sybil():
    """
    Verify that creating a session with a Ring Anomaly or untrusted counterparty
    is blocked immediately at session creation without invoking QVAC.
    """
    # Look up sybil address
    wallets = client.get("/api/wallets").json()
    sybil_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_sybil")

    req = {
        "buyer_wallet_id": "wallet_a",
        "seller_address": sybil_addr,
        "asset_id": _desk_asset(),
        "rgb_amount": 1_000_000,
        "buyer_max_ceiling_usd": 135,
        "buyer_target_usd": 100,
        "buyer_ai_prompt": "Buyer prompt",
    }
    resp = client.post("/api/sessions", json=req)
    assert resp.status_code == 200
    sess = resp.json()
    assert sess["state"] == "BLOCKED_BY_GATE"
    assert sess["gate"]["passed"] is False
    assert sess["gate"]["trust_tier"] == "Ring Anomaly Detected"
    assert len(sess["rounds"]) == 0
    assert sess["thinking"] is None

def test_session_signature_hash_mismatch_returns_409(monkeypatch):
    _fund_wallets(monkeypatch)
    """
    Verify that POST /api/sessions/{id}/sign returns 409 if terms_hash does not match active session terms.
    """
    monkeypatch.setattr("backend.qvac_negotiator.negotiator.use_mock", True)

    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")

    # Reset seller desk parameters to ensure quick agreement
    client.put("/api/wallets/wallet_b/agent_profile", json={
        "asking_price_usd": 140,
        "secret_min_reserve_usd": 110,
    })

    req = {
        "buyer_wallet_id": "wallet_a",
        "seller_address": seller_addr,
        "asset_id": _desk_asset(),
        "rgb_amount": 1_000_000,
        "buyer_max_ceiling_usd": 135,
        "buyer_target_usd": 120,
        "buyer_ai_prompt": "Negotiate quickly",
    }
    resp = client.post("/api/sessions", json=req)
    assert resp.status_code == 200
    sess = resp.json()
    sess_id = sess["session_id"]

    # Poll for negotiation loop to reach agreement
    sess_updated = None
    for _ in range(40):
        time.sleep(0.1)
        resp_sess = client.get(f"/api/sessions/{sess_id}?wallet_id=wallet_a")
        sess_updated = resp_sess.json()
        if sess_updated["state"] == "AWAITING_SIGNATURES":
            break

    assert sess_updated is not None
    assert sess_updated["state"] == "AWAITING_SIGNATURES"
    assert sess_updated["terms_hash"] is not None

    # Sign with mismatched terms_hash -> 409
    sign_mismatch = {
        "wallet_id": "wallet_a",
        "terms_hash": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855_fake",
    }
    resp_sign_err = client.post(f"/api/sessions/{sess_id}/sign", json=sign_mismatch)
    assert resp_sign_err.status_code == 409
    err_body = resp_sign_err.json()
    assert err_body["code"] == "terms_hash_mismatch"

    # Sign with valid terms_hash -> 200
    valid_hash = sess_updated["terms_hash"]
    sign_ok = {
        "wallet_id": "wallet_a",
        "terms_hash": valid_hash,
    }
    resp_sign_ok = client.post(f"/api/sessions/{sess_id}/sign", json=sign_ok)
    assert resp_sign_ok.status_code == 200
    sess_after_buyer = resp_sign_ok.json()
    assert sess_after_buyer["buyer_signed"] is True
    assert sess_after_buyer["seller_signed"] is False

def test_incompatible_buyer_is_blocked_before_any_negotiation(monkeypatch):
    """Buyer maximum below the seller's minimum: no agent ever talks, and no number is revealed."""
    _fund_wallets(monkeypatch)
    _reset_desk(asking=150, reserve=140)
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")
    sess = client.post("/api/sessions", json=_session_request(seller_addr, buyer_max_ceiling_usd=100, buyer_target_usd=90)).json()
    assert sess["state"] == "BLOCKED_BY_GATE"
    assert sess["gate"]["reasons"] == ["No deal possible: the buyer's maximum is below the seller's minimum."]
    assert sess["rounds"] == [] and sess["queue_position"] is None
    assert "140" not in str(sess) and "100" not in str(sess["gate"])
    _reset_desk()


def test_negotiation_stops_when_offers_stall(monkeypatch):
    from backend.qvac_negotiator import NegotiationTurn

    _fund_wallets(monkeypatch)
    _reset_desk()

    def stubborn(ctx):
        offer = 112 if ctx.role == "buyer" else 140
        return NegotiationTurn(
            speaker_wallet_id=ctx.wallet_id, speaker_label=ctx.wallet_label, action="OFFER",
            offer_usd=offer, public_message="Holding.", private_thought="Holding.", round_number=ctx.round_number,
        )

    monkeypatch.setattr("backend.api_server.negotiator.generate_turn", stubborn)
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")
    sess_id = client.post("/api/sessions", json=_session_request(seller_addr)).json()["session_id"]

    final = None
    for _ in range(100):
        time.sleep(0.1)
        final = client.get(f"/api/sessions/{sess_id}?wallet_id=wallet_a").json()
        if final["state"] == "BLOCKED_BY_GATE":
            break
    assert final["gate"]["reasons"] == ["No agreement: the offers stopped moving."]
    assert len(final["rounds"]) == 3 and final["max_rounds"] == 10


def test_session_cancellation(monkeypatch):
    """Verify session can be cancelled before settlement."""
    _fund_wallets(monkeypatch)
    _reset_desk()
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")

    req = {
        "buyer_wallet_id": "wallet_a",
        "seller_address": seller_addr,
        "asset_id": _desk_asset(),
        "rgb_amount": 1_000_000,
        "buyer_max_ceiling_usd": 135,
        "buyer_target_usd": 120,
        "buyer_ai_prompt": "Negotiate",
    }
    resp = client.post("/api/sessions", json=req)
    sess_id = resp.json()["session_id"]

    # Attempt cancel from third party wallet -> 403 Forbidden
    resp_forbidden = client.post(f"/api/sessions/{sess_id}/cancel", json={"wallet_id": "wallet_sybil"})
    assert resp_forbidden.status_code == 403
    assert resp_forbidden.json()["code"] == "forbidden"

    resp_cancel = client.post(f"/api/sessions/{sess_id}/cancel", json={"wallet_id": "wallet_a"})
    assert resp_cancel.status_code == 200
    assert resp_cancel.json()["state"] == "CANCELLED_BY_USER"

def test_finalize_agreement_gate_check():
    """Verify finalize_agreement calls evaluate_gate and blocks if outside limits."""
    from backend.api_server import finalize_agreement
    from backend.session_store import session_store, SessionStatus

    # Create dummy session
    session_store.create_session(
        session_id="sess_gate_test",
        asset_id="rgb:pepe_test",
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_asset_id="rgb:usdt_test",
        payment_ticker="USDT",
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        buyer_address="bcrt1q_buyer",
        seller_address="bcrt1q_seller",
        asking_price_usd=150,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    # Attempt finalize at 140 (exceeds buyer budget 135)
    finalize_agreement("sess_gate_test", 140)
    res = session_store.get_session("sess_gate_test")
    assert res.status == SessionStatus.BLOCKED_BY_GATE
    assert res.gate["passed"] is False
    assert "Agreed price outside the secret limits" in res.gate["reasons"]


def test_session_view_forbidden_for_non_participants():
    from backend.session_store import session_store

    session_store.create_session(
        session_id="sess_view_403",
        asset_id="rgb:pepe_test",
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_asset_id="rgb:usdt_test",
        payment_ticker="USDT",
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        buyer_address="bcrt1q_buyer",
        seller_address="bcrt1q_seller",
        asking_price_usd=150,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert client.get("/api/sessions/sess_view_403?wallet_id=wallet_a").status_code == 200
    resp = client.get("/api/sessions/sess_view_403?wallet_id=wallet_sybil")
    assert resp.status_code == 403
    assert resp.json()["code"] == "forbidden"


def _session_request(seller_addr: str, **overrides):
    req = {
        "buyer_wallet_id": "wallet_a",
        "seller_address": seller_addr,
        "asset_id": _desk_asset(),
        "rgb_amount": 1_000_000,
        "buyer_max_ceiling_usd": 135,
        "buyer_target_usd": 120,
        "buyer_ai_prompt": "Negotiate",
    }
    req.update(overrides)
    return req


def test_session_creation_contract_errors(monkeypatch):
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")
    client.put("/api/wallets/wallet_b/agent_profile", json={"seller_active": True})

    def post(**overrides):
        return client.post("/api/sessions", json=_session_request(seller_addr, **overrides))

    _fund_wallets(monkeypatch)
    assert post(buyer_wallet_id="wallet_ghost").status_code == 404
    assert post(rgb_amount=0).json()["code"] == "invalid_amount"
    assert post(buyer_target_usd=140).json()["code"] == "invalid_limits"
    resp = post(asset_id="rgb:not_on_the_desk")
    assert (resp.status_code, resp.json()["code"]) == (409, "seller_desk_inactive")

    _fund_wallets(monkeypatch, amount=0)
    resp = post()
    assert (resp.status_code, resp.json()["code"]) == (409, "insufficient_funds")


def test_session_blocked_for_unknown_seller_and_untrusted_buyer(monkeypatch):
    _fund_wallets(monkeypatch)
    resp = client.post("/api/sessions", json=_session_request("bcrt1q_unknown_address"))
    sess = resp.json()
    assert sess["state"] == "BLOCKED_BY_GATE"
    assert sess["gate"]["reasons"] == ["Counterparty has no active desk."]

    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")
    resp = client.post("/api/sessions", json=_session_request(seller_addr, buyer_wallet_id="wallet_sybil"))
    sess = resp.json()
    assert sess["state"] == "BLOCKED_BY_GATE"
    assert any(r.startswith("Buyer trust check failed") for r in sess["gate"]["reasons"])
    assert sess["rounds"] == []


def test_contacts_include_aliased_addresses():
    client.put("/api/wallets/wallet_a/aliases", json={"address": "bcrt1q_new_friend", "name": "Friend"})
    contacts = client.get("/api/wallets/wallet_a/contacts").json()
    friend = next(c for c in contacts if c["address"] == "bcrt1q_new_friend")
    assert friend["alias"] == "Friend"
    assert friend["trust"]["trust_tier"] == "Unverified"
    assert friend["desk"] is None
    assert len([c for c in contacts if c["address"] == "bcrt1q_new_friend"]) == 1


def test_new_wdk_wallet_buying_is_blocked_by_gate(monkeypatch):
    _fund_wallets(monkeypatch, amount=0)
    new_wallet = client.post("/api/wallets/create", json={"label": "WDK demo"}).json()
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")
    resp = client.post("/api/sessions", json=_session_request(seller_addr, buyer_wallet_id=new_wallet["wallet_id"]))
    sess = resp.json()
    assert resp.status_code == 200
    assert sess["state"] == "BLOCKED_BY_GATE"
    assert "Buyer trust check failed: Unverified" in sess["gate"]["reasons"]


SECRET_KEYS = ("secret_min_reserve_usd", "seller_ai_prompt", "buyer_max_ceiling_usd", "buyer_target_usd", "buyer_ai_prompt")


def test_shop_lists_public_seller_desks():
    client.put("/api/wallets/wallet_b/agent_profile", json={"seller_active": True})
    assert client.get("/api/shop?wallet_id=wallet_ghost").status_code == 404

    resp = client.get("/api/shop?wallet_id=wallet_a&kind=sell")
    assert resp.status_code == 200
    listings = resp.json()
    by_id = {l["listing_id"]: l for l in listings}
    desk_b = by_id["desk_wallet_b"]
    assert desk_b["kind"] == "sell" and desk_b["is_mine"] is False and desk_b["created_at"] is None
    assert desk_b["asset"]["asset_id"] == _desk_asset()
    assert desk_b["price_usd"] == client.get("/api/wallets/wallet_b").json()["agent_profile"]["asking_price_usd"]
    assert by_id["desk_wallet_sybil"]["trust"]["trust_tier"] == "Ring Anomaly Detected"
    assert desk_b["owner_alias"] == "Wallet B"  # wallet label when the viewer has no alias
    assert "desk_wallet_a" not in by_id  # Wallet A's desk is off
    for listing in listings:
        assert not any(k in listing for k in SECRET_KEYS)

    mine = client.get("/api/shop?wallet_id=wallet_b&kind=sell").json()
    assert next(l for l in mine if l["listing_id"] == "desk_wallet_b")["is_mine"] is True


def test_shop_wants_create_filter_and_close():
    pepe = _desk_asset()
    bad = {"wallet_id": "wallet_a", "asset_id": pepe, "amount": 250_000, "target_usd": 55}
    assert client.post("/api/shop/wants", json={**bad, "asset_id": "btc"}).json()["code"] == "invalid_asset"
    assert client.post("/api/shop/wants", json={**bad, "amount": 0}).json()["code"] == "invalid_amount"
    assert client.post("/api/shop/wants", json={**bad, "amount": 2.5}).json()["code"] == "invalid_amount"
    assert client.post("/api/shop/wants", json={**bad, "target_usd": 0}).json()["code"] == "invalid_price"

    resp = client.post("/api/shop/wants", json={**bad, "note": "  Clean lot wanted, quick settle.  "})
    assert resp.status_code == 200
    want = resp.json()
    assert want["kind"] == "want" and want["is_mine"] is True
    assert want["price_usd"] == 55 and want["amount"] == 250_000
    assert want["note"] == "Clean lot wanted, quick settle."
    assert want["listing_id"].startswith("want_") and want["created_at"] > 0

    found = client.get("/api/shop?wallet_id=wallet_b&kind=want&q=CLEAN LOT").json()
    assert [l["listing_id"] for l in found] == [want["listing_id"]]
    assert found[0]["is_mine"] is False
    assert client.get(f"/api/shop?wallet_id=wallet_b&asset_id=rgb:other&q=clean").json() == []

    wid = want["listing_id"]
    assert client.post(f"/api/shop/{wid}/close", json={"wallet_id": "wallet_b"}).status_code == 403
    assert client.post("/api/shop/desk_wallet_b/close", json={"wallet_id": "wallet_b"}).json()["code"] == "desk_listing"
    assert client.post("/api/shop/want_missing/close", json={"wallet_id": "wallet_a"}).status_code == 404
    assert client.post(f"/api/shop/{wid}/close", json={"wallet_id": "wallet_a"}).status_code == 200
    assert client.post(f"/api/shop/{wid}/close", json={"wallet_id": "wallet_a"}).json()["code"] == "listing_not_found"
    assert wid not in [l["listing_id"] for l in client.get("/api/shop?wallet_id=wallet_a").json()]


def test_agent_search_skips_rings_and_opens_a_session(monkeypatch):
    monkeypatch.setattr("backend.qvac_negotiator.negotiator.use_mock", True)
    _fund_wallets(monkeypatch)
    client.put("/api/wallets/wallet_b/agent_profile", json={"seller_active": True, "asking_price_usd": 150, "secret_min_reserve_usd": 110})
    req = {
        "buyer_wallet_id": "wallet_a",
        "asset_id": _desk_asset(),
        "rgb_amount": 500_000,
        "buyer_max_ceiling_usd": 135,
        "buyer_target_usd": 120,
        "buyer_ai_prompt": "Open low and concede in steps.",
    }
    # Make Sybil's desk the cheapest (40 vs 75 USD for 500k): it is a ring, so Wallet B's desk must win.
    client.put("/api/wallets/wallet_sybil/agent_profile", json={"seller_active": True, "asking_price_usd": 40, "secret_min_reserve_usd": 30, "offered_amount": 500_000})
    resp = client.post("/api/shop/agent_search", json=req)
    assert resp.status_code == 200
    body = resp.json()
    assert body["listing"]["listing_id"] == "desk_wallet_b"
    assert body["session"]["state"] == "NEGOTIATING"
    assert body["session"]["counterparty_address"] == body["listing"]["owner_address"]

    assert client.post("/api/shop/agent_search", json={**req, "asset_id": "rgb:other"}).json()["code"] == "no_match"
    # Wallet B's floor above the buyer's maximum: no desk can close, so no session is opened.
    _reset_desk(asking=150, reserve=140)
    assert client.post("/api/shop/agent_search", json={**req, "buyer_max_ceiling_usd": 130}).json()["code"] == "no_match"
    _reset_desk()
    assert client.post("/api/shop/agent_search", json={**req, "rgb_amount": 5_000_000}).json()["code"] == "no_match"
    resp = client.post("/api/shop/agent_search", json={**req, "buyer_max_ceiling_usd": 40, "buyer_target_usd": 30})
    assert (resp.status_code, resp.json()["code"]) == (404, "no_match")


def test_negotiation_ends_at_the_round_cap(monkeypatch):
    from backend.qvac_negotiator import NegotiationTurn

    _fund_wallets(monkeypatch)
    monkeypatch.setattr("backend.api_server.settings.NEGOTIATION_MAX_ROUNDS", 3)

    def moving_but_never_crossing(ctx):
        offer = 100 + ctx.round_number if ctx.role == "buyer" else 200 - ctx.round_number
        return NegotiationTurn(
            speaker_wallet_id=ctx.wallet_id, speaker_label=ctx.wallet_label, action="OFFER",
            offer_usd=offer, public_message="Moving.", private_thought="Moving.", round_number=ctx.round_number,
        )

    monkeypatch.setattr("backend.api_server.negotiator.generate_turn", moving_but_never_crossing)
    _reset_desk()
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")
    sess_id = client.post("/api/sessions", json=_session_request(seller_addr)).json()["session_id"]

    final = None
    for _ in range(100):
        time.sleep(0.1)
        final = client.get(f"/api/sessions/{sess_id}?wallet_id=wallet_a").json()
        if final["state"] == "BLOCKED_BY_GATE":
            break
    assert final["gate"]["reasons"] == ["No agreement within 3 rounds."]
    assert len(final["rounds"]) == 3 and final["max_rounds"] == 3


def test_queued_negotiations_report_their_position(monkeypatch):
    import threading
    from backend.negotiation_queue import NegotiationQueue

    release = threading.Event()
    queue = NegotiationQueue(lambda sid: release.wait(10), concurrency=1)
    monkeypatch.setattr("backend.api_server.negotiation_queue", queue)
    _fund_wallets(monkeypatch)
    _reset_desk()
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")

    first = client.post("/api/sessions", json=_session_request(seller_addr)).json()
    second = client.post("/api/sessions", json=_session_request(seller_addr)).json()
    for _ in range(50):
        if queue.snapshot()["running"] == [first["session_id"]]:
            break
        time.sleep(0.02)
    assert client.get("/api/negotiations/queue").json() == {
        "running": [first["session_id"]], "waiting": [second["session_id"]],
    }
    view = client.get(f"/api/sessions/{second['session_id']}?wallet_id=wallet_a").json()
    assert view["queue_position"] == 1 and view["state"] == "NEGOTIATING" and view["rounds"] == []
    assert client.get(f"/api/sessions/{first['session_id']}?wallet_id=wallet_a").json()["queue_position"] is None

    release.set()
    for sid in (first["session_id"], second["session_id"]):
        client.post(f"/api/sessions/{sid}/cancel", json={"wallet_id": "wallet_a"})


def test_agent_profile_rejects_inconsistent_limits():
    _reset_desk()
    resp = client.put("/api/wallets/wallet_b/agent_profile", json={"secret_min_reserve_usd": 160})
    assert (resp.status_code, resp.json()["code"]) == (400, "invalid_profile")
    resp = client.put("/api/wallets/wallet_a/agent_profile", json={"buyer_target_usd": 200})
    assert (resp.status_code, resp.json()["code"]) == (400, "invalid_profile")
    profile = client.get("/api/wallets/wallet_b").json()["agent_profile"]
    assert profile["secret_min_reserve_usd"] == 110  # rejected updates change nothing
