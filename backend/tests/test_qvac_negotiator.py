"""
Unit tests for QvacNegotiator, leak_guard, rationality_guard, and multi-round convergence.
"""

import pytest
from backend.qvac_negotiator import (
    leak_guard,
    rationality_guard,
    parse_llm_json_response,
    NegotiationContext,
    QvacNegotiator,
)

def test_leak_guard_integer_detection():
    secret_reserve = 110
    # Leaking message with the exact number
    leaky_msg = "I can't go below 110 because that is my floor."
    has_leak, sanitized = leak_guard(leaky_msg, secret_reserve)
    assert has_leak is True
    assert "110" not in sanitized

    # Message with different integers (e.g. asset supply) should pass cleanly
    safe_msg = "I offer 125 USDT for 1000000 PEPE tokens in round 2."
    has_leak, sanitized = leak_guard(safe_msg, secret_reserve)
    assert has_leak is False
    assert sanitized == safe_msg

    # Sensitive phrase detection
    phrase_msg = "My secret reserve is not for you to know, but here is my offer."
    has_leak, sanitized = leak_guard(phrase_msg, secret_reserve)
    assert has_leak is True

def test_rationality_guard_buyer_clamp():
    # Buyer attempts to bid higher than max budget (135)
    action, offer = rationality_guard(
        role="buyer",
        raw_action="OFFER",
        raw_offer_usd=145,
        secret_limit_usd=135,
        current_bid_usd=110,
        current_ask_usd=140,
        your_previous_offer_usd=110,
        round_number=2,
    )
    assert offer == 135
    assert action == "OFFER"

    # Buyer attempts to lower bid
    action, offer = rationality_guard(
        role="buyer",
        raw_action="OFFER",
        raw_offer_usd=100,
        secret_limit_usd=135,
        current_bid_usd=115,
        current_ask_usd=130,
        your_previous_offer_usd=115,
        round_number=3,
    )
    assert offer == 115

    # Buyer bid meets or exceeds ask -> converts to ACCEPT
    action, offer = rationality_guard(
        role="buyer",
        raw_action="OFFER",
        raw_offer_usd=130,
        secret_limit_usd=135,
        current_bid_usd=115,
        current_ask_usd=125,
        your_previous_offer_usd=115,
        round_number=3,
    )
    assert action == "ACCEPT"
    assert offer == 125

def test_rationality_guard_seller_clamp():
    # Seller attempts to ask below reserve (110)
    action, offer = rationality_guard(
        role="seller",
        raw_action="OFFER",
        raw_offer_usd=90,
        secret_limit_usd=110,
        current_bid_usd=100,
        current_ask_usd=130,
        your_previous_offer_usd=130,
        round_number=2,
    )
    assert offer == 110
    assert action == "OFFER"

    # Seller attempts to raise ask
    action, offer = rationality_guard(
        role="seller",
        raw_action="OFFER",
        raw_offer_usd=140,
        secret_limit_usd=110,
        current_bid_usd=100,
        current_ask_usd=130,
        your_previous_offer_usd=130,
        round_number=3,
    )
    assert offer == 130

    # Seller ask meets or goes below bid -> converts to ACCEPT
    action, offer = rationality_guard(
        role="seller",
        raw_action="OFFER",
        raw_offer_usd=115,
        secret_limit_usd=110,
        current_bid_usd=120,
        current_ask_usd=130,
        your_previous_offer_usd=130,
        round_number=3,
    )
    assert action == "ACCEPT"
    assert offer == 120

def test_parse_llm_json_response_with_think_and_codefence():
    raw_output = """<think>
    I must be careful not to reveal the reserve price.
    110 is my limit, but let's counter at 125.
    </think>
    ```json
    {
      "private_thought": "Counterparty is serious. Conceding moderately.",
      "action": "OFFER",
      "offer_usd": 125,
      "public_message": "I can agree to 125 USDT."
    }
    ```"""
    parsed = parse_llm_json_response(raw_output)
    assert parsed["action"] == "OFFER"
    assert parsed["offer_usd"] == 125
    assert "private_thought" in parsed
    assert "Counterparty is serious" in parsed["private_thought"]

def test_full_four_round_mock_negotiation_convergence():
    negotiator = QvacNegotiator()
    negotiator.use_mock = True

    history = []
    seller_reserve = 110
    buyer_budget = 135

    current_ask = 150
    current_bid = None
    buyer_prev = None
    seller_prev = None

    agreed = False
    agreed_price = None

    for round_num in range(1, 5):
        # 1. Buyer Turn
        buyer_ctx = NegotiationContext(
            session_id="test_sess",
            round_number=round_num,
            role="buyer",
            wallet_id="wallet_a",
            wallet_label="Wallet A",
            counterparty_wallet_id="wallet_b",
            counterparty_label="Wallet B",
            asset_ticker="PEPE",
            asset_amount=1_000_000,
            payment_ticker="USDT",
            secret_limit_usd=buyer_budget,
            current_bid_usd=current_bid,
            current_ask_usd=current_ask,
            your_previous_offer_usd=buyer_prev,
            history=history,
        )
        buyer_turn = negotiator.generate_turn(buyer_ctx)
        history.append(buyer_turn)
        current_bid = buyer_turn.offer_usd
        buyer_prev = buyer_turn.offer_usd

        # Check if buyer accepted
        if buyer_turn.action == "ACCEPT":
            agreed = True
            agreed_price = buyer_turn.offer_usd
            break

        # 2. Seller Turn
        seller_ctx = NegotiationContext(
            session_id="test_sess",
            round_number=round_num,
            role="seller",
            wallet_id="wallet_b",
            wallet_label="Wallet B",
            counterparty_wallet_id="wallet_a",
            counterparty_label="Wallet A",
            asset_ticker="PEPE",
            asset_amount=1_000_000,
            payment_ticker="USDT",
            secret_limit_usd=seller_reserve,
            current_bid_usd=current_bid,
            current_ask_usd=current_ask,
            your_previous_offer_usd=seller_prev,
            history=history,
        )
        seller_turn = negotiator.generate_turn(seller_ctx)
        history.append(seller_turn)
        current_ask = seller_turn.offer_usd
        seller_prev = seller_turn.offer_usd

        # Check if seller accepted
        if seller_turn.action == "ACCEPT":
            agreed = True
            agreed_price = seller_turn.offer_usd
            break

    assert agreed is True
    assert agreed_price is not None
    # Price must land inside the deal zone [110, 135]
    assert 110 <= agreed_price <= 135
    # Secrets must not appear in any public message
    for turn in history:
        assert str(seller_reserve) not in turn.public_message or "reserve" not in turn.public_message.lower()
        assert str(buyer_budget) not in turn.public_message or "budget" not in turn.public_message.lower()
