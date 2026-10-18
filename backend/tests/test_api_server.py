"""
API Server Test Suite (FastAPI TestClient)
Verifies all 12 API endpoints, error handling, perspective privacy masking,
pre-signature security gates, signature hash verification (409 on mismatch),
and state machine progression.
"""

import re
import time
import pytest
from fastapi.testclient import TestClient

from backend.api_server import app
from backend.session_store import session_store, SessionStatus
from backend.deterministic_gate import compute_terms_hash, CanonicalSwapTerms

client = TestClient(app)


def _desk_asset() -> str:
    return client.get("/api/wallets/wallet_b").json()["agent_profile"]["offered_asset_id"]


def _reset_desk(asking: int = 150, reserve: int = 110, allow_partial: bool = False) -> None:
    client.put("/api/wallets/wallet_b/agent_profile", json={
        "seller_active": True, "asking_price_usd": asking, "secret_min_reserve_usd": reserve, "offered_amount": 1_000_000,
        "allow_partial": allow_partial,
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

def test_one_btc_rate_from_settings(monkeypatch):
    from pydantic import ValidationError
    from backend.config import Settings

    monkeypatch.setattr("backend.config.settings.SATS_PER_USD", 2_000)
    assert client.get("/api/market").json()["sats_per_usd"] == 2_000
    # Totals use the same rate: Sybil's seeded 500,000 sats, and nothing else, are 250 USD.
    assert client.get("/api/wallets/wallet_sybil").json()["history_points"][0]["total_usd"] == 250.0

    monkeypatch.setenv("SATS_PER_USD", "2500")
    assert Settings().SATS_PER_USD == 2_500
    monkeypatch.delenv("SATS_PER_USD")
    assert Settings().SATS_PER_USD == 1_000
    monkeypatch.setenv("SATS_PER_USD", "0")  # every total would divide by it
    with pytest.raises(ValidationError, match="SATS_PER_USD"):
        Settings()

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

def test_wallet_state_carries_its_own_trust():
    trust = {wid: client.get(f"/api/wallets/{wid}").json()["trust"] for wid in ("wallet_a", "wallet_sybil")}
    assert (trust["wallet_a"]["trust_tier"], trust["wallet_a"]["trusted"]) == ("High Authenticity", True)
    assert (trust["wallet_sybil"]["trust_tier"], trust["wallet_sybil"]["sybil_ring_detected"]) == ("Ring Anomaly Detected", True)
    # The same audit counterparties get in their contacts: no loop % or raw counts, nothing secret.
    contacts = client.get("/api/wallets/wallet_b/contacts").json()
    wallet_a_addr = client.get("/api/wallets/wallet_a").json()["address"]
    assert next(c["trust"] for c in contacts if c["address"] == wallet_a_addr) == trust["wallet_a"]


def test_a_wallet_lists_only_the_rgb_assets_it_holds(monkeypatch):
    from backend.market import market_manager
    from backend.wallet_state import WalletStateManager

    monkeypatch.setattr(market_manager, "pepe_asset_id", "rgb:pepe_demo")
    monkeypatch.setattr(market_manager, "usdt_asset_id", "rgb:usdt_demo")

    def held(asset_id, ticker, spendable, future):
        return {"asset_id": asset_id, "ticker": ticker, "name": ticker, "settled": spendable, "future": future, "spendable": spendable}

    # The whole lot sold (or moved to the Vault): no PEPE row, as in mock mode. USDT a settling
    # transfer keeps unspendable for a moment is still held, so it stays listed.
    state = WalletStateManager().assemble_wallet_state("wallet_b", {
        "btc_sats": 990_000, "assets": [held("rgb:pepe_demo", "PEPE", 0, 0), held("rgb:usdt_demo", "USDT", 0, 75)],
    })
    assert [(a.ticker, a.amount) for a in state.assets] == [("BTC", 990_000), ("USDT", 0)]


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

def test_a_ring_needs_consent_and_negotiates_with_it(monkeypatch):
    """
    A ring member is not blocked: without the buyer's consent the answer is 409 confirm_risk and
    nothing is created (no QVAC call); with it the agents negotiate, and the check after the
    agreement honours the consent.
    """
    from backend.api_server import finalize_agreement
    from backend.memory_graph import memory_graph
    from backend.negotiation_queue import NegotiationQueue

    _fund_wallets(monkeypatch)
    monkeypatch.setattr("backend.api_server.negotiation_queue", NegotiationQueue(lambda sid: None))
    wallets = client.get("/api/wallets").json()
    sybil_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_sybil")
    req = {
        "buyer_wallet_id": "wallet_a",
        "seller_address": sybil_addr,
        "asset_id": _desk_asset(),
        "rgb_amount": 500_000,
        "buyer_max_ceiling_usd": 135,
        "buyer_target_usd": 100,
        "buyer_ai_prompt": "Buyer prompt",
    }
    before = len(client.get("/api/sessions?wallet_id=wallet_a").json())
    refused = client.post("/api/sessions", json=req)
    assert refused.status_code == 409
    assert refused.json() == {
        "code": "confirm_risk",
        "message": "Sybil trades in loops with itself, a pattern used to fake reliability. Trading with it is a high risk.",
    }
    assert len(client.get("/api/sessions?wallet_id=wallet_a").json()) == before

    sess = client.post("/api/sessions", json={**req, "accept_risk": True}).json()
    assert (sess["state"], sess["risk_accepted"]) == ("NEGOTIATING", True)
    assert sess["counterparty_trust"]["trust_tier"] == "Ring Anomaly Detected"
    finalize_agreement(sess["session_id"], 70)
    agreed = client.get(f"/api/sessions/{sess['session_id']}?wallet_id=wallet_a").json()
    assert agreed["state"] == "AWAITING_SIGNATURES"
    assert agreed["gate"] == {"passed": True, "trust_tier": "Ring Anomaly Detected", "reasons": []}

    # Declining the deal with a ring is not a walk-away.
    client.post(f"/api/sessions/{sess['session_id']}/cancel", json={"wallet_id": "wallet_a"})
    assert not any(w.session_id == sess["session_id"] for w in memory_graph._walk_aways)

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

def _leaves(value):
    """Every scalar inside a JSON value."""
    if isinstance(value, dict):
        return [leaf for v in value.values() for leaf in _leaves(v)]
    if isinstance(value, list):
        return [leaf for v in value for leaf in _leaves(v)]
    return [value]

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
    # The reserve as a value anywhere (ids, hashes and timestamps may contain the digits by chance).
    leaves = _leaves(sess)
    assert 140 not in leaves and not any(isinstance(v, str) and re.search(r"\b140\b", v) for v in leaves)
    assert "100" not in str(sess["gate"])
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


def test_session_blocked_for_unknown_seller_but_not_for_a_ring_buyer(monkeypatch):
    from backend.negotiation_queue import NegotiationQueue

    _fund_wallets(monkeypatch)
    resp = client.post("/api/sessions", json=_session_request("bcrt1q_unknown_address"))
    sess = resp.json()
    assert sess["state"] == "BLOCKED_BY_GATE"
    assert sess["gate"]["reasons"] == ["Counterparty has no active desk."]

    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")
    # The starter's own tier never blocks, a ring's included: the seller sees its badge and may decline.
    _reset_desk()
    monkeypatch.setattr("backend.api_server.negotiation_queue", NegotiationQueue(lambda sid: None))
    resp = client.post("/api/sessions", json=_session_request(seller_addr, buyer_wallet_id="wallet_sybil"))
    sess = resp.json()
    assert (sess["state"], sess["gate"], sess["risk_accepted"]) == ("NEGOTIATING", None, False)
    client.post(f"/api/sessions/{sess['session_id']}/cancel", json={"wallet_id": "wallet_sybil"})


def test_contacts_include_aliased_addresses():
    client.put("/api/wallets/wallet_a/aliases", json={"address": "bcrt1q_new_friend", "name": "Friend"})
    contacts = client.get("/api/wallets/wallet_a/contacts").json()
    friend = next(c for c in contacts if c["address"] == "bcrt1q_new_friend")
    assert friend["alias"] == "Friend"
    assert friend["trust"]["trust_tier"] == "Unverified"
    assert friend["desk"] is None
    assert len([c for c in contacts if c["address"] == "bcrt1q_new_friend"]) == 1


def test_new_wdk_wallet_can_start_a_deal(monkeypatch):
    from backend.negotiation_queue import NegotiationQueue

    # A wallet with no history yet is not blocked as the starter: trading is how it builds a score.
    _fund_wallets(monkeypatch)
    _reset_desk()
    monkeypatch.setattr("backend.api_server.negotiation_queue", NegotiationQueue(lambda sid: None))
    new_wallet = client.post("/api/wallets/create", json={"label": "WDK demo"}).json()
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")
    resp = client.post("/api/sessions", json=_session_request(seller_addr, buyer_wallet_id=new_wallet["wallet_id"]))
    sess = resp.json()
    assert resp.status_code == 200
    assert (sess["state"], sess["gate"], sess["risk_accepted"]) == ("NEGOTIATING", None, False)
    client.post(f"/api/sessions/{sess['session_id']}/cancel", json={"wallet_id": new_wallet["wallet_id"]})


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
    client.put("/api/wallets/wallet_b/agent_profile", json={"seller_active": True, "asking_price_usd": 150, "secret_min_reserve_usd": 110, "allow_partial": True})
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
    # Wallet B's floor for half the lot (140 * 0.5 = 70) above the buyer's maximum: no desk can
    # close, so no session is opened. Just above it, the half lot is negotiated at half the price.
    _reset_desk(asking=150, reserve=140, allow_partial=True)
    assert client.post("/api/shop/agent_search", json={**req, "buyer_max_ceiling_usd": 65, "buyer_target_usd": 60}).json()["code"] == "no_match"
    body = client.post("/api/shop/agent_search", json={**req, "buyer_max_ceiling_usd": 75, "buyer_target_usd": 60}).json()
    assert (body["session"]["state"], body["session"]["list_price_usd"]) == ("NEGOTIATING", 75)
    _reset_desk(allow_partial=True)
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


def test_partial_lot_is_priced_pro_rata(monkeypatch):
    _fund_wallets(monkeypatch)
    _reset_desk(asking=150, reserve=110, allow_partial=True)
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")

    # Half the lot: list price 75, reserve 55. A maximum of 60 can close, 50 cannot.
    half = client.post("/api/sessions", json=_session_request(seller_addr, rgb_amount=500_000, buyer_max_ceiling_usd=60, buyer_target_usd=50)).json()
    assert (half["state"], half["list_price_usd"], half["rgb_amount"]) == ("NEGOTIATING", 75, 500_000)
    client.post(f"/api/sessions/{half['session_id']}/cancel", json={"wallet_id": "wallet_a"})
    low = client.post("/api/sessions", json=_session_request(seller_addr, rgb_amount=500_000, buyer_max_ceiling_usd=50, buyer_target_usd=40)).json()
    assert low["state"] == "BLOCKED_BY_GATE"
    assert low["gate"]["reasons"] == ["No deal possible: the buyer's maximum is below the seller's minimum."]

    resp = client.post("/api/sessions", json=_session_request(seller_addr, rgb_amount=1_000_001))
    assert (resp.status_code, resp.json()["code"]) == (409, "exceeds_lot")
    # The smallest part is worth MIN_PART_USD (10) at the list price: ceil(1,000,000 * 10 / 150) = 66,667.
    from backend.api_server import MIN_PART_USD
    assert MIN_PART_USD == 10  # same value as frontend/src/lib/lots.ts
    resp = client.post("/api/sessions", json=_session_request(seller_addr, rgb_amount=66_666, buyer_max_ceiling_usd=9, buyer_target_usd=8))
    assert (resp.status_code, resp.json()) == (400, {
        "code": "amount_too_small", "message": "Buy at least 66667 PEPE: a smaller part is worth less than 10 USDT.",
    })
    smallest = client.post("/api/sessions", json=_session_request(seller_addr, rgb_amount=66_667, buyer_max_ceiling_usd=9, buyer_target_usd=8)).json()
    assert (smallest["state"], smallest["list_price_usd"]) == ("NEGOTIATING", 10)
    client.post(f"/api/sessions/{smallest['session_id']}/cancel", json={"wallet_id": "wallet_a"})
    # The agent never picks a part below the minimum either.
    search = {"buyer_wallet_id": "wallet_a", "asset_id": _desk_asset(), "rgb_amount": 12_500, "buyer_max_ceiling_usd": 9, "buyer_target_usd": 8, "buyer_ai_prompt": ""}
    assert client.post("/api/shop/agent_search", json=search).json()["code"] == "no_match"

    # A lot worth less than MIN_PART_USD sells whole only.
    _reset_desk(asking=8, reserve=5, allow_partial=True)
    resp = client.post("/api/sessions", json=_session_request(seller_addr, rgb_amount=999_999, buyer_max_ceiling_usd=8, buyer_target_usd=6))
    assert (resp.status_code, resp.json()["code"]) == (400, "amount_too_small")
    whole = client.post("/api/sessions", json=_session_request(seller_addr, buyer_max_ceiling_usd=8, buyer_target_usd=6)).json()
    assert (whole["state"], whole["list_price_usd"]) == ("NEGOTIATING", 8)
    client.post(f"/api/sessions/{whole['session_id']}/cancel", json={"wallet_id": "wallet_a"})
    _reset_desk()


def test_partial_purchase_needs_the_sellers_consent(monkeypatch):
    from backend.wallet_state import AgentProfile, WalletStateManager

    _fund_wallets(monkeypatch)
    assert AgentProfile.model_fields["allow_partial"].default is False  # off unless the seller opts in
    # The demo seller has opted in: profiles live in RAM, and the demo's partial purchase must not
    # need the switch again after every restart.
    seeded = WalletStateManager()
    assert (seeded.get_profile("wallet_b").allow_partial, seeded.get_profile("wallet_sybil").allow_partial) == (True, False)
    _reset_desk()
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")

    def public_flags():
        desk = next(c for c in client.get("/api/wallets/wallet_a/contacts").json() if c["address"] == seller_addr)["desk"]
        listing = next(l for l in client.get("/api/shop?wallet_id=wallet_a&kind=sell").json() if l["listing_id"] == "desk_wallet_b")
        return desk["allow_partial"], listing["allow_partial"]

    def cancel(session):
        client.post(f"/api/sessions/{session['session_id']}/cancel", json={"wallet_id": "wallet_a"})

    search = {
        "buyer_wallet_id": "wallet_a", "asset_id": _desk_asset(), "rgb_amount": 500_000,
        "buyer_max_ceiling_usd": 135, "buyer_target_usd": 120, "buyer_ai_prompt": "",
    }

    # Whole lot only: one unit short is refused, more than the lot is still exceeds_lot.
    assert public_flags() == (False, False)
    resp = client.post("/api/sessions", json=_session_request(seller_addr, rgb_amount=999_999))
    assert (resp.status_code, resp.json()["code"]) == (409, "partial_not_allowed")
    resp = client.post("/api/sessions", json=_session_request(seller_addr, rgb_amount=1_000_001))
    assert (resp.status_code, resp.json()["code"]) == (409, "exceeds_lot")
    whole = client.post("/api/sessions", json=_session_request(seller_addr)).json()
    assert (whole["state"], whole["rgb_amount"], whole["list_price_usd"]) == ("NEGOTIATING", 1_000_000, 150)
    cancel(whole)
    assert client.post("/api/shop/agent_search", json=search).json()["code"] == "no_match"
    found = client.post("/api/shop/agent_search", json={**search, "rgb_amount": 1_000_000}).json()
    assert found["listing"]["listing_id"] == "desk_wallet_b"
    cancel(found["session"])

    # With the seller's consent a part is sold at the pro-rata list price, by hand or by the agent.
    assert client.put("/api/wallets/wallet_b/agent_profile", json={"allow_partial": True}).json()["allow_partial"] is True
    assert public_flags() == (True, True)
    half = client.post("/api/sessions", json=_session_request(seller_addr, rgb_amount=500_000, buyer_max_ceiling_usd=70, buyer_target_usd=60)).json()
    assert (half["state"], half["rgb_amount"], half["list_price_usd"]) == ("NEGOTIATING", 500_000, 75)
    cancel(half)
    found = client.post("/api/shop/agent_search", json=search).json()
    assert (found["listing"]["listing_id"], found["session"]["list_price_usd"]) == ("desk_wallet_b", 75)
    cancel(found["session"])
    resp = client.post("/api/sessions", json=_session_request(seller_addr, rgb_amount=1_000_001))
    assert (resp.status_code, resp.json()["code"]) == (409, "exceeds_lot")
    _reset_desk()


def test_session_view_shows_every_round(monkeypatch):
    from backend.qvac_negotiator import NegotiationTurn

    _fund_wallets(monkeypatch)
    monkeypatch.setattr("backend.api_server.settings.NEGOTIATION_MAX_ROUNDS", 6)
    contexts = []

    def moving_but_never_crossing(ctx):
        contexts.append(ctx)
        offer = 100 + ctx.round_number if ctx.role == "buyer" else 200 - ctx.round_number
        return NegotiationTurn(
            speaker_wallet_id=ctx.wallet_id, speaker_label=ctx.wallet_label, action="OFFER",
            offer_usd=offer, public_message="Moving.", private_thought="Moving.", round_number=ctx.round_number,
        )

    monkeypatch.setattr("backend.api_server.negotiator.generate_turn", moving_but_never_crossing)
    _reset_desk()
    client.put("/api/wallets/wallet_b/agent_profile", json={"seller_ai_prompt": "Defend the list price."})
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")
    sess_id = client.post("/api/sessions", json=_session_request(seller_addr, buyer_ai_prompt="Raise slowly.")).json()["session_id"]

    final = None
    for _ in range(150):
        time.sleep(0.1)
        final = client.get(f"/api/sessions/{sess_id}?wallet_id=wallet_a").json()
        if final["state"] == "BLOCKED_BY_GATE":
            break
    assert [r["n"] for r in final["rounds"]] == [1, 2, 3, 4, 5, 6]
    assert final["rounds"][5]["buyer_offer_usd"] == 106 and final["rounds"][5]["seller_offer_usd"] == 194
    # Each agent gets its owner's strategy and the real wallet names.
    # (Sessions left over from other tests share the queue: look at this one only.)
    buyer_ctx = next(c for c in contexts if c.session_id == sess_id and c.role == "buyer")
    seller_ctx = next(c for c in contexts if c.session_id == sess_id and c.role == "seller")
    assert (buyer_ctx.owner_instructions, buyer_ctx.wallet_label, buyer_ctx.counterparty_label) == ("Raise slowly.", "Wallet A", "Wallet B")
    assert (seller_ctx.owner_instructions, seller_ctx.wallet_label) == ("Defend the list price.", "Wallet B")
    # ...and the other side's computed reliability, as the API shows it (never its limits or counts).
    for ctx, other in ((buyer_ctx, "wallet_b"), (seller_ctx, "wallet_a")):
        trust = client.get(f"/api/wallets/{other}").json()["trust"]
        assert (ctx.counterparty_reliability_pct, ctx.counterparty_trust_tier) == (trust["reliability_pct"], trust["trust_tier"])
    client.put("/api/wallets/wallet_b/agent_profile", json={"seller_ai_prompt": ""})


def test_a_sale_shrinks_the_desk_lot():
    from backend.wallet_state import wallet_state_manager

    _reset_desk(asking=150, reserve=110)
    asset = _desk_asset()
    wallet_state_manager.consume_lot("wallet_b", "rgb:other", 400_000)  # another asset: untouched
    wallet_state_manager.consume_lot("wallet_b", asset, 400_000)
    profile = client.get("/api/wallets/wallet_b").json()["agent_profile"]
    assert (profile["offered_amount"], profile["asking_price_usd"], profile["secret_min_reserve_usd"]) == (600_000, 90, 66)
    assert profile["seller_active"] is True
    wallet_state_manager.consume_lot("wallet_b", asset, 600_000)
    profile = client.get("/api/wallets/wallet_b").json()["agent_profile"]
    assert (profile["seller_active"], profile["offered_amount"]) == (False, 0)
    assert "desk_wallet_b" not in [l["listing_id"] for l in client.get("/api/shop?wallet_id=wallet_a").json()]
    _reset_desk()


def test_the_seeded_desk_lists_only_what_the_seller_holds():
    from backend.wallet_state import WalletStateManager

    state = WalletStateManager()
    pepe = state.get_profile("wallet_b").offered_asset_id

    def desk():
        p = state.get_profile("wallet_b")
        return p.seller_active, p.offered_amount, p.asking_price_usd, p.secret_min_reserve_usd

    state.fit_lot("wallet_b", pepe, 1_000_000)  # the whole lot is held
    state.fit_lot("wallet_b", "rgb:other", 1)    # another asset
    assert desk() == (True, 1_000_000, 150, 110)
    # Part sold or moved to the Vault before a restart: the lot shrinks to it at the same unit prices.
    state.fit_lot("wallet_b", pepe, 750_000)
    assert desk() == (True, 750_000, 113, 83)


def test_a_restart_starts_history_and_desk_from_what_the_wallets_hold(monkeypatch):
    from backend import api_server
    from backend.config import settings
    from backend.market import market_manager
    from backend.wallet_state import WalletStateManager

    # The restart kept both demo assets after 250,000 PEPE were sold for 50 USDT.
    pepe, usdt = "rgb:pepe_kept", "rgb:usdt_kept"

    def asset(asset_id, ticker, amount):
        return {"asset_id": asset_id, "ticker": ticker, "name": ticker, "settled": amount, "future": amount, "spendable": amount}

    on_chain = {
        "wallet_a": {"btc_sats": 990_000, "assets": [asset(pepe, "PEPE", 250_000), asset(usdt, "USDT", 9_950)]},
        "wallet_b": {"btc_sats": 995_000, "assets": [asset(pepe, "PEPE", 750_000), asset(usdt, "USDT", 50), asset("rgb:sold_out", "PEPE", 0)]},
    }

    def get_balances(wallet_id):
        if wallet_id not in on_chain:
            raise RuntimeError("indexer unreachable")  # Sybil: its seed amounts instead
        return on_chain[wallet_id]

    state = WalletStateManager()
    monkeypatch.setattr(api_server, "wallet_state_manager", state)
    monkeypatch.setattr(api_server.regtest, "get_height", lambda: 200)
    monkeypatch.setattr(api_server.rgb_engine, "setup_demo_environment", lambda: {"pepe_asset_id": pepe, "usdt_asset_id": usdt})
    monkeypatch.setattr(api_server.wallet_mgr, "get_balances", get_balances)
    monkeypatch.setattr(api_server.shop_store, "seed_demo_wants", lambda asset_id: None)
    for obj, name in ((settings, "DEMO_ASSET_ID"), (settings, "PAYMENT_ASSET_ID"), (market_manager, "pepe_asset_id"),
                      (market_manager, "usdt_asset_id"), (market_manager, "last_pepe_price_usd")):
        monkeypatch.setattr(obj, name, getattr(obj, name))  # set by the startup or the sale below: restored
    with TestClient(app):  # runs the startup
        pass

    assert {wid: state._history[wid][0].balances for wid in ("wallet_a", "wallet_b", "wallet_sybil")} == {
        "wallet_a": {"btc": 990_000, pepe: 250_000, usdt: 9_950},
        "wallet_b": {"btc": 995_000, pepe: 750_000, usdt: 50},
        "wallet_sybil": {"btc": 500_000, pepe: 0, usdt: 0},
    }
    profile = state.get_profile("wallet_b")
    assert (profile.offered_asset_id, profile.offered_amount, profile.asking_price_usd) == (pepe, 750_000, 113)

    # The next sale moves on from what the wallets hold, not from the seeded supply.
    state.record_swap_settlement(
        buyer_wallet_id="wallet_a", seller_wallet_id="wallet_b", session_id="sess_next", txid="txid_next",
        asset_id=pepe, asset_ticker="PEPE", asset_amount=375_000, payment_asset_id=usdt, payment_ticker="USDT",
        payment_amount=75, agreed_price_usd=75,
    )
    assert state._history["wallet_b"][-1].balances == {"btc": 995_000, pepe: 375_000, usdt: 125}
    assert state._history["wallet_a"][-1].balances == {"btc": 990_000, pepe: 625_000, usdt: 9_875}


def test_a_failed_settlement_says_whether_funds_moved(monkeypatch):
    from backend import api_server
    from backend.memory_graph import MemoryGraph
    from backend.rgb_swap_engine import InsufficientFundsError
    from backend.session_store import SessionStore

    store = SessionStore(MemoryGraph())
    monkeypatch.setattr(api_server, "session_store", store)

    def failing_swap(exc, broadcast=False):
        def swap(**kwargs):
            if broadcast:
                kwargs["txid_callback"]("ab" * 32)
            raise exc
        return swap

    lot_gone = "The seller no longer holds the agreed lot, so no funds moved."
    cases = [
        # An rgb-lib error before the broadcast: the parties never see the library's text.
        (failing_swap(RuntimeError("RgbLibError.InsufficientAllocationSlots()")), api_server.SETTLEMENT_NOT_PREPARED, None),
        # A side no longer holds its part of the deal: said as is.
        (failing_swap(InsufficientFundsError(lot_gone)), lot_gone, None),
        # After the broadcast: the txid stays, so the parties can check it before trying again.
        (failing_swap(RuntimeError("accept_swap_transfers failed"), broadcast=True), api_server.SETTLEMENT_NOT_FINISHED, "ab" * 32),
    ]
    for i, (swap, message, txid) in enumerate(cases):
        session_id = f"sess_failed_{i}"
        store.create_session(
            session_id=session_id, asset_id="rgb:pepe", asset_ticker="PEPE", asset_amount=500_000,
            payment_asset_id="rgb:usdt", payment_ticker="USDT", buyer_wallet_id="wallet_a", seller_wallet_id="wallet_b",
            buyer_address="bcrt1qbuyer", seller_address="bcrt1qseller", asking_price_usd=75,
            buyer_max_budget_usd=70, seller_min_reserve_usd=55,
        )
        terms = CanonicalSwapTerms(
            session_id=session_id, asset_id="rgb:pepe", rgb_amount=500_000, payment_asset_id="rgb:usdt",
            payment_amount=65, agreed_price_usd=65, network_fee_sat=2000, buyer_address="bcrt1qbuyer",
            seller_address="bcrt1qseller", expiry_unix=int(time.time()) + 600,
        )
        terms_hash = compute_terms_hash(terms)
        store.set_awaiting_signatures(session_id, 65, 65, terms, terms_hash)
        store.sign_session(session_id, "wallet_a", terms_hash)
        store.sign_session(session_id, "wallet_b", terms_hash)
        monkeypatch.setattr(api_server.rgb_engine, "execute_atomic_swap", swap)
        api_server.run_settlement_worker(session_id)
        view = store.get_session(session_id).to_session_view("wallet_a")
        assert (view["state"], view["failure"], view["txid"]) == ("FAILED", {"code": "settlement_error", "message": message}, txid)
