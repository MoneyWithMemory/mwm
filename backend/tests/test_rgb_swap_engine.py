"""
Unit tests for rgb_swap_engine, double signature enforcement, and session state machine.
"""

import time
import pytest
from backend.deterministic_gate import CanonicalSwapTerms, compute_terms_hash
from backend.rgb_swap_engine import (
    RgbSwapEngine,
    SecurityViolationError,
    WalletManager,
)
from backend.session_store import SessionStore, SessionStatus
from backend.qvac_negotiator import NegotiationTurn

def test_session_state_machine_and_signatures():
    store = SessionStore()
    sess = store.create_session(
        session_id="sess_flow_1",
        asset_id="rgb:pepe_id",
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_asset_id="rgb:usdt_id",
        payment_ticker="USDT",
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        asking_price_usd=150,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert sess.status == SessionStatus.NEGOTIATING

    # Add a negotiation turn
    turn_a = NegotiationTurn(
        speaker_wallet_id="wallet_a",
        speaker_label="Wallet A",
        action="OFFER",
        offer_usd=125,
        public_message="Counteroffer 125 USDT",
        private_thought="This is my strategic maximum concession.",
        round_number=2,
    )
    store.record_turn("sess_flow_1", turn_a)

    # Perspective masking test
    view_buyer = sess.to_view("wallet_a")
    assert view_buyer["my_private_thought"] == "This is my strategic maximum concession."
    assert view_buyer["history"][0]["private_thought"] == "This is my strategic maximum concession."

    view_seller = sess.to_view("wallet_b")
    # Seller should NOT see buyer's private thought!
    assert view_seller["my_private_thought"] == ""
    assert view_seller["history"][0]["private_thought"] is None

    # Transition to AWAITING_SIGNATURES
    terms = CanonicalSwapTerms(
        session_id="sess_flow_1",
        asset_id="rgb:pepe_id",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt_id",
        payment_amount=125,
        agreed_price_usd=125,
        network_fee_sat=2000,
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        expiry_unix=int(time.time()) + 3600,
    )
    valid_hash = compute_terms_hash(terms)
    store.set_awaiting_signatures("sess_flow_1", 125, 125, terms, valid_hash)
    assert sess.status == SessionStatus.AWAITING_SIGNATURES

    # Signing with wrong hash must fail
    with pytest.raises(ValueError, match="does not match active session terms_hash"):
        store.sign_session("sess_flow_1", "wallet_a", "invalid_bad_hash")

    # Unauthorized party cannot sign
    with pytest.raises(ValueError, match="not an authorized party"):
        store.sign_session("sess_flow_1", "wallet_intruder", valid_hash)

    # 1/2 signature (Buyer signs)
    store.sign_session("sess_flow_1", "wallet_a", valid_hash)
    assert sess.buyer_signed is True
    assert sess.seller_signed is False
    # Status should still be AWAITING_SIGNATURES
    assert sess.status == SessionStatus.AWAITING_SIGNATURES

    # 2/2 signature (Seller signs)
    store.sign_session("sess_flow_1", "wallet_b", valid_hash)
    assert sess.seller_signed is True
    # Auto-transitions to SETTLING!
    assert sess.status == SessionStatus.SETTLING

    # Transition to SETTLED
    store.set_settled("sess_flow_1", "txid_1234567890abcdef")
    assert sess.status == SessionStatus.SETTLED
    assert sess.txid == "txid_1234567890abcdef"
    assert sess.settlement_step == 7

def test_session_cancellation_and_expiry():
    store = SessionStore()
    sess = store.create_session(
        session_id="sess_cancel",
        asset_id="rgb:pepe",
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_ticker="USDT",
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        asking_price_usd=150,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
        expiry_seconds=1,  # 1 second expiry
    )
    # Cancel by user
    store.cancel_session("sess_cancel", cancelled_by="wallet_a")
    assert sess.status == SessionStatus.CANCELLED_BY_USER

    # Expiry test
    sess_exp = store.create_session(
        session_id="sess_exp",
        asset_id="rgb:pepe",
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_ticker="USDT",
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        asking_price_usd=150,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
        expiry_seconds=0,
    )
    terms = CanonicalSwapTerms(
        session_id="sess_exp",
        asset_id="rgb:pepe",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_amount=125,
        agreed_price_usd=125,
        network_fee_sat=2000,
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        expiry_unix=int(time.time()) - 10,
    )
    store.set_awaiting_signatures("sess_exp", 125, 125, terms, compute_terms_hash(terms))
    retrieved = store.get_session("sess_exp")
    assert retrieved.status == SessionStatus.EXPIRED

def test_engine_enforces_double_signature_and_hash_security():
    engine = RgbSwapEngine()
    terms = CanonicalSwapTerms(
        session_id="sess_sec_test",
        asset_id="rgb:pepe_asset",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt_asset",
        payment_amount=125,
        agreed_price_usd=125,
        network_fee_sat=2000,
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        expiry_unix=int(time.time()) + 3600,
    )
    correct_hash = compute_terms_hash(terms)

    # 1. Missing signature (1/2) must raise SecurityViolationError
    with pytest.raises(SecurityViolationError, match="both buyer and seller signatures are strictly required"):
        engine.execute_atomic_swap(
            canonical_terms=terms,
            buyer_signed=True,
            seller_signed=False,
            buyer_signed_hash=correct_hash,
            seller_signed_hash=correct_hash,
        )

    # 2. Hash mismatch between buyer and seller must raise SecurityViolationError
    with pytest.raises(SecurityViolationError, match="signature terms_hash mismatch"):
        engine.execute_atomic_swap(
            canonical_terms=terms,
            buyer_signed=True,
            seller_signed=True,
            buyer_signed_hash=correct_hash,
            seller_signed_hash="different_hash_value",
        )

    # 3. Signed hash mismatch with current terms must raise SecurityViolationError
    with pytest.raises(SecurityViolationError, match="does not match canonical terms"):
        engine.execute_atomic_swap(
            canonical_terms=terms,
            buyer_signed=True,
            seller_signed=True,
            buyer_signed_hash="outdated_terms_hash",
            seller_signed_hash="outdated_terms_hash",
        )
