"""
Unit tests for deterministic gate, terms hash, and memory graph trust calculations.
"""

import pytest
from backend.memory_graph import MemoryGraph, TrustTier
from backend.deterministic_gate import evaluate_gate, compute_terms_hash

def test_memory_graph_trust_tiers():
    graph = MemoryGraph()
    # Verified counterparties
    rep_a = graph.get_reputation("wallet_a")
    rep_b = graph.get_reputation("wallet_b")
    assert rep_a.trust_tier == TrustTier.HIGH_AUTHENTICITY
    assert rep_a.reliability_pct == 98
    assert rep_a.is_trusted is True
    assert rep_b.trust_tier == TrustTier.HIGH_AUTHENTICITY

    # Sybil wash-trading ring
    rep_sybil = graph.get_reputation("wallet_sybil")
    assert rep_sybil.trust_tier == TrustTier.RING_ANOMALY
    assert rep_sybil.reliability_pct == 15
    assert rep_sybil.is_trusted is False
    assert "loop %" not in rep_sybil.assessment_summary.lower()

    # Cold start
    rep_unknown = graph.get_reputation("wallet_fresh_new")
    assert rep_unknown.trust_tier == TrustTier.UNVERIFIED
    assert rep_unknown.reliability_pct is None
    assert rep_unknown.is_trusted is False

def test_canonical_terms_hash_deterministic():
    terms1 = {
        "seller_wallet_id": "wallet_b",
        "buyer_wallet_id": "wallet_a",
        "price_usd": 125,
        "asset_ticker": "PEPE",
        "asset_amount": 1000000,
        "payment_ticker": "USDT",
        "payment_amount": 125,
    }
    # Same dictionary with different insertion order
    terms2 = {
        "payment_amount": 125,
        "price_usd": 125,
        "asset_amount": 1000000,
        "buyer_wallet_id": "wallet_a",
        "payment_ticker": "USDT",
        "asset_ticker": "PEPE",
        "seller_wallet_id": "wallet_b",
    }
    hash1 = compute_terms_hash(terms1)
    hash2 = compute_terms_hash(terms2)
    assert hash1 == hash2
    assert len(hash1) == 64

def test_gate_blocks_sybil_counterparty():
    res = evaluate_gate(
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_sybil",
        active_signer_wallet_id="wallet_a",
        agreed_price_usd=120,
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_ticker="USDT",
        payment_amount=120,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert res.passed is False
    assert res.block_state == "BLOCKED_BY_GATE"
    assert "Ring Anomaly Detected" in res.reason

def test_gate_blocks_budget_exceeded():
    res = evaluate_gate(
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        active_signer_wallet_id="wallet_a",
        agreed_price_usd=140,  # Exceeds buyer ceiling 135
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_ticker="USDT",
        payment_amount=140,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert res.passed is False
    assert res.block_state == "BLOCKED_BY_GATE"
    assert "buyer secret ceiling" in res.reason

def test_gate_blocks_seller_reserve_violated():
    res = evaluate_gate(
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        active_signer_wallet_id="wallet_b",
        agreed_price_usd=100,  # Below seller reserve 110
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_ticker="USDT",
        payment_amount=100,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert res.passed is False
    assert res.block_state == "BLOCKED_BY_GATE"
    assert "seller secret reserve" in res.reason

def test_gate_blocks_invalid_amounts():
    res = evaluate_gate(
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        active_signer_wallet_id="wallet_a",
        agreed_price_usd=0,  # invalid
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_ticker="USDT",
        payment_amount=0,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert res.passed is False
    assert res.block_state == "BLOCKED_BY_GATE"

def test_gate_passes_within_deal_zone():
    res = evaluate_gate(
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        active_signer_wallet_id="wallet_a",
        agreed_price_usd=125,  # within [110, 135]
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_ticker="USDT",
        payment_amount=125,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert res.passed is True
    assert res.terms_hash is not None
    assert len(res.terms_hash) == 64
    assert res.terms["price_usd"] == 125

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
