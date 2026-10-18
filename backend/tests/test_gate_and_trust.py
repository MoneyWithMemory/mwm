"""
Unit tests for deterministic gate, terms hash, and memory graph trust calculations.
"""

import pytest
from backend.memory_graph import MemoryGraph, TrustTier
from backend.deterministic_gate import evaluate_gate, compute_terms_hash

def test_memory_graph_trust_tiers():
    graph = MemoryGraph()
    # Verified counterparties: scores computed from the seeded settled trades
    rep_a = graph.get_reputation("wallet_a")
    rep_b = graph.get_reputation("wallet_b")
    assert rep_a.trust_tier == TrustTier.HIGH_AUTHENTICITY
    assert 85 <= rep_a.reliability_pct <= 92
    assert rep_a.is_trusted is True
    assert rep_b.trust_tier == TrustTier.HIGH_AUTHENTICITY

    # Sybil wash-trading ring: capped at 20
    rep_sybil = graph.get_reputation("wallet_sybil")
    assert rep_sybil.trust_tier == TrustTier.RING_ANOMALY
    assert rep_sybil.reliability_pct <= 20
    assert rep_sybil.is_trusted is False
    assert "loop %" not in rep_sybil.assessment_summary.lower()

    # Cold start
    rep_unknown = graph.get_reputation("wallet_fresh_new")
    assert rep_unknown.trust_tier == TrustTier.UNVERIFIED
    assert rep_unknown.reliability_pct is None
    assert rep_unknown.is_trusted is False

def test_canonical_terms_hash_deterministic():
    from backend.deterministic_gate import CanonicalSwapTerms
    terms1 = CanonicalSwapTerms(
        session_id="sess_123",
        asset_id="rgb:pepe_test_asset_id",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt_test_asset_id",
        payment_amount=125,
        agreed_price_usd=125,
        network_fee_sat=2000,
        buyer_address="bcrt1qbuyeraddress",
        seller_address="bcrt1qselleraddress",
        expiry_unix=1700000000,
    )
    terms2_dict = {
        "expiry_unix": 1700000000,
        "seller_address": "bcrt1qselleraddress",
        "buyer_address": "bcrt1qbuyeraddress",
        "network_fee_sat": 2000,
        "agreed_price_usd": 125,
        "payment_amount": 125,
        "payment_asset_id": "rgb:usdt_test_asset_id",
        "rgb_amount": 1_000_000,
        "asset_id": "rgb:pepe_test_asset_id",
        "session_id": "sess_123",
    }
    hash1 = compute_terms_hash(terms1)
    hash2 = compute_terms_hash(terms2_dict)
    assert hash1 == hash2
    assert len(hash1) == 64

def test_gate_blocks_sybil_counterparty():
    res = evaluate_gate(
        session_id="sess_test",
        asset_id="rgb:pepe",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_amount=120,
        agreed_price_usd=120,
        network_fee_sat=2000,
        buyer_address="wallet_a",
        seller_address="wallet_sybil",
        expiry_unix=1700000000,
        active_signer_address="wallet_a",
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert res.passed is False
    assert res.block_state == "BLOCKED_BY_GATE"
    assert "Ring Anomaly Detected" in res.reason

def test_gate_blocks_budget_exceeded():
    res = evaluate_gate(
        session_id="sess_test",
        asset_id="rgb:pepe",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_amount=140,
        agreed_price_usd=140,  # Exceeds buyer ceiling 135
        network_fee_sat=2000,
        buyer_address="wallet_a",
        seller_address="wallet_b",
        expiry_unix=1700000000,
        active_signer_address="wallet_a",
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert res.passed is False
    assert res.block_state == "BLOCKED_BY_GATE"
    assert "buyer secret ceiling" in res.reason

def test_gate_blocks_seller_reserve_violated():
    res = evaluate_gate(
        session_id="sess_test",
        asset_id="rgb:pepe",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_amount=100,
        agreed_price_usd=100,  # Below seller reserve 110
        network_fee_sat=2000,
        buyer_address="wallet_a",
        seller_address="wallet_b",
        expiry_unix=1700000000,
        active_signer_address="wallet_b",
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert res.passed is False
    assert res.block_state == "BLOCKED_BY_GATE"
    assert "seller secret reserve" in res.reason

def test_gate_blocks_invalid_amounts():
    res = evaluate_gate(
        session_id="sess_test",
        asset_id="rgb:pepe",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_amount=0,  # invalid
        agreed_price_usd=0,  # invalid
        network_fee_sat=2000,
        buyer_address="wallet_a",
        seller_address="wallet_b",
        expiry_unix=1700000000,
        active_signer_address="wallet_a",
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert res.passed is False
    assert res.block_state == "BLOCKED_BY_GATE"

def test_gate_passes_within_deal_zone():
    res = evaluate_gate(
        session_id="sess_test",
        asset_id="rgb:pepe",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_amount=125,
        agreed_price_usd=125,  # within [110, 135]
        network_fee_sat=2000,
        buyer_address="wallet_a",
        seller_address="wallet_b",
        expiry_unix=1700000000,
        active_signer_address="wallet_a",
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert res.passed is True
    assert res.terms_hash is not None
    assert len(res.terms_hash) == 64
    assert res.terms["agreed_price_usd"] == 125
    assert res.terms["rgb_amount"] == 1_000_000
    assert res.terms["payment_amount"] == 125

def test_seed_identities():
    from backend.seed import SEED_WALLETS, init_seed_state
    wallets = init_seed_state()
    assert len(wallets) >= 3
    assert "wallet_a" in SEED_WALLETS
    assert "wallet_b" in SEED_WALLETS
    assert "wallet_sybil" in SEED_WALLETS
    assert SEED_WALLETS["wallet_a"].label == "Wallet A"
    assert SEED_WALLETS["wallet_b"].label == "Wallet B"
    assert SEED_WALLETS["wallet_sybil"].label == "Sybil"
    # Ensure legacy names are never present in seed descriptions or labels
    for w in SEED_WALLETS.values():
        assert "alice" not in w.label.lower()
        assert "bob" not in w.label.lower()
        assert "alice" not in w.description.lower()
        assert "bob" not in w.description.lower()
