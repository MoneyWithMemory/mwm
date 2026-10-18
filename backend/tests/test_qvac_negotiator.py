"""
Unit tests for QvacNegotiator, leak_guard, rationality_guard, and multi-round convergence.
"""

import pytest
from backend.qvac_negotiator import (
    leak_guard,
    rationality_guard,
    parse_llm_json_response,
    ConcessionPace,
    NegotiationContext,
    QvacNegotiator,
)

# The fastest secret pace (half of the room, a 1 USD margin): the guard's numbers below follow from it.
FASTEST = ConcessionPace(share_pct=50, margin_usd=1)

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
    # Buyer attempts to bid higher than max budget (135): clamped to it, then, before the closing
    # rounds, capped at half of the 24 USD left from its last bid to its hold line (134).
    action, offer = rationality_guard(
        role="buyer",
        raw_action="OFFER",
        raw_offer_usd=145,
        secret_limit_usd=135,
        current_bid_usd=110,
        current_ask_usd=140,
        your_previous_offer_usd=110,
        round_number=2,
        pace=FASTEST,
    )
    assert offer == 122
    assert action == "OFFER"
    # In a closing round the ceiling itself may be bid.
    assert rationality_guard("buyer", "OFFER", 145, 135, 110, 140, 110, 9, max_rounds=10, pace=FASTEST) == ("OFFER", 135)

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
        pace=FASTEST,
    )
    assert offer == 117  # raised to the previous bid, then the minimum step

    # Buyer bid meets or exceeds an ask close to its last bid -> converts to ACCEPT
    action, offer = rationality_guard(
        role="buyer",
        raw_action="OFFER",
        raw_offer_usd=130,
        secret_limit_usd=135,
        current_bid_usd=122,
        current_ask_usd=125,
        your_previous_offer_usd=122,
        round_number=3,
        pace=FASTEST,
    )
    assert action == "ACCEPT"
    assert offer == 125

def test_rationality_guard_seller_clamp():
    # Seller attempts to ask below reserve (110): clamped to it, then, before the closing rounds,
    # capped at half of the 19 USD left from its last ask to its hold line (111), rounded down.
    action, offer = rationality_guard(
        role="seller",
        raw_action="OFFER",
        raw_offer_usd=90,
        secret_limit_usd=110,
        current_bid_usd=100,
        current_ask_usd=130,
        your_previous_offer_usd=130,
        round_number=2,
        pace=FASTEST,
    )
    assert offer == 121
    assert action == "OFFER"
    # In a closing round the reserve itself may be asked.
    assert rationality_guard("seller", "OFFER", 90, 110, 100, 130, 130, 9, max_rounds=10, pace=FASTEST) == ("OFFER", 110)

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
        pace=FASTEST,
    )
    assert offer == 126  # lowered to the previous ask, then 15% of the 30 USD gap

    # Seller ask meets or goes below a bid close to its last ask -> converts to ACCEPT
    action, offer = rationality_guard(
        role="seller",
        raw_action="OFFER",
        raw_offer_usd=115,
        secret_limit_usd=110,
        current_bid_usd=120,
        current_ask_usd=123,
        your_previous_offer_usd=123,
        round_number=3,
        pace=FASTEST,
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

    # Four rounds at most: rounds 3 and 4 are the closing rounds, where the guard lets an agent
    # reach its limit (before them every concession is capped).
    for round_num in range(1, 5):
        # 1. Buyer Turn
        buyer_ctx = NegotiationContext(
            session_id="test_sess",
            round_number=round_num,
            max_rounds=4,
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
            max_rounds=4,
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


def test_mock_buyer_takes_an_ask_within_its_target_without_quoting_the_target():
    # A part of a lot can list below the buyer's target: the mock buyer accepts the ask in round 1,
    # and its public message never names the secret target it did not offer.
    negotiator = QvacNegotiator()
    negotiator.use_mock = True

    def first_turn(ask):
        return negotiator.generate_turn(NegotiationContext(
            session_id="test_low_ask", round_number=1, role="buyer", wallet_id="wallet_a", wallet_label="Wallet A",
            counterparty_wallet_id="wallet_b", counterparty_label="Wallet B", asset_ticker="PEPE", asset_amount=400_000,
            payment_ticker="USDT", secret_limit_usd=135, buyer_target_usd=120, current_ask_usd=ask, list_price_usd=ask,
        ))

    turn = first_turn(60)
    assert (turn.action, turn.offer_usd, turn.public_message) == ("ACCEPT", 60, "Your ask of 60 USDT is acceptable.")
    # Above the target the buyer opens below it (Balanced: 90% of it), and never names it.
    turn = first_turn(150)
    assert (turn.action, turn.offer_usd) == ("OFFER", 114) and "114" in turn.public_message and "120" not in turn.public_message


def test_coerce_offer_usd():
    from backend.qvac_negotiator import coerce_offer_usd

    assert coerce_offer_usd(130) == 130
    assert coerce_offer_usd(129.6) == 130
    assert coerce_offer_usd("$130") == 130
    assert coerce_offer_usd("130 USDT") == 130
    for bad in (None, True, "", "about 130", "130-140", 0, -5, 0.4):
        assert coerce_offer_usd(bad) is None
    # json.loads reads Infinity, NaN and 1e309: never an offer, never an OverflowError.
    for bad in (float("inf"), float("-inf"), float("nan"), "9" * 400):
        assert coerce_offer_usd(bad) is None


def test_accept_is_recorded_at_the_counterparty_price():
    # Buyer says ACCEPT with its own lower number: the round must show the seller's ask.
    assert rationality_guard("buyer", "ACCEPT", 120, 135, 125, 128, 125, 3, pace=FASTEST) == ("ACCEPT", 128)
    # Buyer cannot accept an ask above its ceiling: the ACCEPT becomes an OFFER.
    assert rationality_guard("buyer", "ACCEPT", 120, 135, 115, 140, 115, 3, pace=FASTEST) == ("OFFER", 120)
    # Seller cannot accept a bid below its reserve.
    assert rationality_guard("seller", "ACCEPT", 130, 110, 100, 135, 135, 3, pace=FASTEST) == ("OFFER", 130)


def test_seller_closes_an_in_range_bid_on_the_final_turn():
    assert rationality_guard("seller", "OFFER", 128, 110, 124, 132, 132, 4, max_rounds=4, pace=FASTEST) == ("ACCEPT", 124)
    assert rationality_guard("seller", "OFFER", 128, 110, 124, 132, 132, 3, max_rounds=4, pace=FASTEST) == ("OFFER", 128)
    assert rationality_guard("seller", "OFFER", 128, 110, 105, 132, 132, 4, max_rounds=4, pace=FASTEST) == ("OFFER", 128)
    # With a cap of 10, round 4 is not the last turn any more.
    assert rationality_guard("seller", "OFFER", 128, 110, 124, 132, 132, 4, max_rounds=10, pace=FASTEST) == ("OFFER", 128)
    assert rationality_guard("seller", "OFFER", 128, 110, 124, 132, 132, 10, max_rounds=10, pace=FASTEST) == ("ACCEPT", 124)


def test_missing_offer_from_model_never_publishes_the_secret(monkeypatch):
    class FakeResponse:
        def raise_for_status(self):
            pass

        def json(self):
            content = '{"private_thought": "x", "action": "OFFER", "public_message": "Let us talk."}'
            return {"choices": [{"message": {"content": content}}]}

    monkeypatch.setattr("backend.qvac_negotiator.requests.post", lambda *a, **kw: FakeResponse())
    live = QvacNegotiator()
    live.use_mock = False
    ctx = NegotiationContext(
        session_id="test_missing_offer",
        round_number=1,
        role="buyer",
        wallet_id="wallet_a",
        wallet_label="Wallet A",
        counterparty_wallet_id="wallet_b",
        counterparty_label="Wallet B",
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_ticker="USDT",
        secret_limit_usd=135,
        buyer_target_usd=120,
        current_ask_usd=150,
    )
    turn = live.generate_turn(ctx)
    assert turn.offer_usd != 135
    assert turn.action == "OFFER"


def test_no_early_capitulation_far_from_own_last_offer():
    # Round 1: the seller (list price 150) tries to take a 120 bid -> counters 150 - 30/4 instead.
    assert rationality_guard("seller", "ACCEPT", 120, 110, 120, 150, 150, 1, max_rounds=10, pace=FASTEST) == ("OFFER", 142)
    # Same move in a closing round is honoured.
    assert rationality_guard("seller", "ACCEPT", 120, 110, 120, 150, 150, 9, max_rounds=10, pace=FASTEST) == ("ACCEPT", 120)
    # The buyer jumping from 115 to a 140 ask counts too, and never passes its ceiling.
    assert rationality_guard("buyer", "ACCEPT", 140, 135, 115, 135, 115, 2, max_rounds=10, pace=FASTEST) == ("OFFER", 120)
    # Within a small gap the counterparty's price is taken.
    assert rationality_guard("seller", "ACCEPT", 127, 110, 127, 130, 130, 3, max_rounds=10, pace=FASTEST) == ("ACCEPT", 127)


def test_offers_always_move_towards_each_other():
    # A seller repeating its ask is moved down by the minimum step (but not in its opening round).
    assert rationality_guard("seller", "OFFER", 140, 110, 125, 140, 140, 3, max_rounds=10, pace=FASTEST) == ("OFFER", 138)
    assert rationality_guard("seller", "OFFER", 150, 110, 120, 150, 150, 1, max_rounds=10, pace=FASTEST) == ("OFFER", 150)
    # Never below the reserve, never above the ceiling: 1 USD from its limit an offer stays put
    # until the closing rounds, where the limit itself may be offered.
    assert rationality_guard("seller", "OFFER", 111, 110, 100, 111, 111, 3, max_rounds=10, pace=FASTEST) == ("OFFER", 111)
    assert rationality_guard("seller", "OFFER", 111, 110, 100, 111, 111, 9, max_rounds=10, pace=FASTEST) == ("OFFER", 110)
    assert rationality_guard("buyer", "OFFER", 134, 135, 134, 150, 134, 3, max_rounds=10, pace=FASTEST) == ("OFFER", 134)
    assert rationality_guard("buyer", "OFFER", 134, 135, 134, 150, 134, 9, max_rounds=10, pace=FASTEST) == ("OFFER", 135)
