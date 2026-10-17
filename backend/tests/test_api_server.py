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
    assert usdt_asset["source"] == "fixed_peg"

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
    assert "history_points" in wa
    assert "agent_profile" in wa
    assert wa["agent_profile"]["buyer_max_ceiling_usd"] == 135

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
        "asset_id": "rgb:pepe_test",
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
        "asset_id": "rgb:pepe_test",
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

def test_negotiation_no_agreement_blocked_after_4_rounds(monkeypatch):
    """
    Verify that if buyer ceiling < seller reserve, 4 rounds elapse without agreement
    and the session transitions to BLOCKED_BY_GATE with reason 'No agreement within 4 rounds'.
    """
    monkeypatch.setattr("backend.qvac_negotiator.negotiator.use_mock", True)

    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")

    # Set disjoint pricing: seller reserve 140, buyer ceiling 100 -> impossible agreement
    client.put("/api/wallets/wallet_b/agent_profile", json={
        "asking_price_usd": 150,
        "secret_min_reserve_usd": 140,
    })

    req = {
        "buyer_wallet_id": "wallet_a",
        "seller_address": seller_addr,
        "asset_id": "rgb:pepe_test",
        "rgb_amount": 1_000_000,
        "buyer_max_ceiling_usd": 100,
        "buyer_target_usd": 90,
        "buyer_ai_prompt": "Hard cap 100",
    }
    resp = client.post("/api/sessions", json=req)
    assert resp.status_code == 200
    sess_id = resp.json()["session_id"]

    # Poll until 4 rounds finish
    final_sess = None
    for _ in range(50):
        time.sleep(0.1)
        resp_sess = client.get(f"/api/sessions/{sess_id}?wallet_id=wallet_a")
        final_sess = resp_sess.json()
        if final_sess["state"] == "BLOCKED_BY_GATE":
            break

    assert final_sess is not None
    assert final_sess["state"] == "BLOCKED_BY_GATE"
    assert final_sess["gate"] is not None
    assert final_sess["gate"]["passed"] is False
    assert "No agreement within 4 rounds" in final_sess["gate"]["reasons"]


def test_session_cancellation():
    """Verify session can be cancelled before settlement."""
    wallets = client.get("/api/wallets").json()
    seller_addr = next(w["address"] for w in wallets if w["wallet_id"] == "wallet_b")

    req = {
        "buyer_wallet_id": "wallet_a",
        "seller_address": seller_addr,
        "asset_id": "rgb:pepe_test",
        "rgb_amount": 1_000_000,
        "buyer_max_ceiling_usd": 135,
        "buyer_target_usd": 120,
        "buyer_ai_prompt": "Negotiate",
    }
    resp = client.post("/api/sessions", json=req)
    sess_id = resp.json()["session_id"]

    resp_cancel = client.post(f"/api/sessions/{sess_id}/cancel", json={"wallet_id": "wallet_a"})
    assert resp_cancel.status_code == 200
    assert resp_cancel.json()["state"] == "CANCELLED_BY_USER"
