"""
Hardening of the negotiator after the real-model evals (evals/README.md, "What the eval found") and
their review: no offer publishes a secret limit before the closing rounds, and the offers do not solve
for it either, because each agent concedes at a secret pace; the leak guard finds a limit in any
format; a corrected turn is published with a neutral message quoting only its final offer; and each
agent reads only its own role's rules. Deals still close whenever the limits overlap, at any pace.
"""

import itertools
import json
import re
import time

import pytest

import backend.qvac_negotiator as qn
from backend.qvac_negotiator import (
    LIMIT_LANGUAGE,
    NEUTRAL_MESSAGES,
    OWN_LIMIT_TALK,
    ConcessionPace,
    NegotiationContext,
    QvacNegotiator,
    build_system_prompt,
    concession_pace,
    leak_guard,
    neutral_message,
    rationality_guard,
    stated_numbers,
)
from scripts.eval_negotiation import build_scenarios, load_strategy_presets

# The fastest pace (half of the room to a hold line 1 USD inside the limit): the numbers below follow from it.
FASTEST = ConcessionPace(share_pct=50, margin_usd=1)


def _widest(limit: int) -> int:
    return max(qn.PACE_MARGIN_MIN_USD, round(qn.PACE_MARGIN_SHARE * limit))


# Paces at the corners of the ranges: (share, "least" margin of 1 USD or the "widest" for the limit).
CORNERS = [(share, margin) for share in (25, 37, 50) for margin in ("least", "widest")]


def _fix_paces(monkeypatch, buyer=(50, "least"), seller=(50, "least")):
    def pace(session_id, role, limit, strategy="balanced"):
        share, margin = buyer if role == "buyer" else seller
        return ConcessionPace(share, 1 if margin == "least" else _widest(limit), strategy)

    monkeypatch.setattr("backend.qvac_negotiator.concession_pace", pace)


def _context(**overrides) -> NegotiationContext:
    ctx = dict(
        session_id="sess_hardening", round_number=3, role="buyer", wallet_id="wallet_a", wallet_label="Wallet A",
        counterparty_wallet_id="wallet_b", counterparty_label="Wallet B", asset_ticker="PEPE", asset_amount=1_000_000,
        payment_ticker="USDT", secret_limit_usd=135, buyer_target_usd=118, current_bid_usd=124, current_ask_usd=150,
        your_previous_offer_usd=124, list_price_usd=150, max_rounds=10,
    )
    ctx.update(overrides)
    return NegotiationContext(**ctx)


def _negotiate(reserve, ceiling, list_price, target, max_rounds=10, buyer_prompt="", seller_prompt=""):
    """
    The product's loop (api_server.run_negotiation_loop) on generate_turn: the buyer then the seller
    each round, a deal as soon as one side takes the other's price within its limit, and a stop when
    the offers do not move for two rounds. The prompts are the owners' strategies. Returns (outcome, price, turns).
    """
    negotiator = QvacNegotiator()
    negotiator.use_mock = True
    history, pairs = [], []
    common = dict(session_id=f"sess_{reserve}_{ceiling}_{list_price}", max_rounds=max_rounds, list_price_usd=list_price,
                  asset_ticker="PEPE", asset_amount=1_000_000, payment_ticker="USDT")
    for round_number in range(1, max_rounds + 1):
        bid = next((t.offer_usd for t in reversed(history) if t.speaker_wallet_id == "wallet_a"), None)
        ask = next((t.offer_usd for t in reversed(history) if t.speaker_wallet_id == "wallet_b"), list_price)
        buyer = negotiator.generate_turn(NegotiationContext(
            round_number=round_number, role="buyer", wallet_id="wallet_a", wallet_label="Wallet A",
            counterparty_wallet_id="wallet_b", counterparty_label="Wallet B", secret_limit_usd=ceiling,
            buyer_target_usd=target, current_bid_usd=bid, current_ask_usd=ask, your_previous_offer_usd=bid,
            owner_instructions=buyer_prompt, history=list(history), **common))
        history.append(buyer)
        if ask <= ceiling and (buyer.action == "ACCEPT" or buyer.offer_usd >= ask):
            return "deal", ask, history
        bid = buyer.offer_usd
        seller = negotiator.generate_turn(NegotiationContext(
            round_number=round_number, role="seller", wallet_id="wallet_b", wallet_label="Wallet B",
            counterparty_wallet_id="wallet_a", counterparty_label="Wallet A", secret_limit_usd=reserve,
            current_bid_usd=bid, current_ask_usd=ask, your_previous_offer_usd=ask, owner_instructions=seller_prompt,
            history=list(history), **common))
        history.append(seller)
        if bid >= reserve and (seller.action == "ACCEPT" or seller.offer_usd <= bid):
            return "deal", bid, history
        pairs.append((buyer.offer_usd, seller.offer_usd))
        if len(pairs) >= 3 and len(set(pairs[-3:])) == 1:
            return "stalled", None, history
    return "no_deal", None, history


def _overlapping_eval_scenarios():
    scenarios = build_scenarios(24, 2026, load_strategy_presets())
    return [sc for sc in scenarios if sc["buyer_ceiling_usd"] >= sc["expected_reserve_usd"]]


# ── H1: no offer publishes a limit before the closing rounds, nor solves for it ──

def test_the_eval_repro_no_longer_offers_the_reserve_before_the_closing_rounds():
    # Finding 1: the seller answered ACCEPT with its own reserve while the bid was below it.
    repro = dict(role="seller", raw_action="ACCEPT", raw_offer_usd=165, secret_limit_usd=165, current_bid_usd=135,
                 current_ask_usd=236, your_previous_offer_usd=236, max_rounds=10)
    # The ACCEPT is an OFFER at 165, capped at half of the 70 USD left above the hold line (166).
    assert rationality_guard(**repro, round_number=1, pace=FASTEST) == ("OFFER", 201)
    for share, margin, round_number in itertools.product(range(25, 51), range(1, _widest(165) + 1), range(1, 9)):
        action, offer = rationality_guard(**repro, round_number=round_number, pace=ConcessionPace(share, margin))
        assert action == "OFFER" and offer - 165 > margin
    # In the closing rounds (9 and 10 of 10) the reserve itself may be offered.
    assert rationality_guard(**repro, round_number=9, pace=FASTEST) == ("OFFER", 165)


def test_the_offers_do_not_solve_for_the_limit():
    # Review of finding 1: with one public rule, a capped move of d from o gave the limit as o - 2d
    # or o - 2d - 1. The offers follow the hold line, and the secret margin sets it: a reserve of 165
    # with a margin of 1 and a reserve of 163 with a margin of 3 publish the same offers, round after
    # round, to a model that pushes to its limit.
    bids = [135, 140, 145, 148, 150, 152, 154, 156]
    published = []
    for reserve, pace in ((165, ConcessionPace(50, 1)), (163, ConcessionPace(50, 3))):
        ask, offers = 236, []
        for round_number, bid in enumerate(bids, start=1):
            _, ask = rationality_guard("seller", "ACCEPT", reserve, reserve, bid, ask, ask, round_number, max_rounds=10, pace=pace)
            offers.append(ask)
        published.append(offers)
    assert published[0] == published[1] == [201, 184, 175, 171, 169, 168, 167, 167]


def test_the_pace_is_secret_reproducible_and_spans_its_ranges(monkeypatch):
    sessions = [f"sess_{i:04d}" for i in range(400)]
    paces = [concession_pace(s, "seller", 135) for s in sessions]
    assert paces == [concession_pace(s, "seller", 135) for s in sessions]
    assert {p.share_pct for p in paces} == set(range(25, 51))
    assert {p.margin_usd for p in paces} == set(range(1, _widest(135) + 1))
    assert any(concession_pace(s, "buyer", 135) != p for s, p in zip(sessions, paces))
    # Keyed by a secret of the process: the session id alone does not give the pace.
    monkeypatch.setattr("backend.qvac_negotiator._PACE_KEY", b"another process")
    assert sum(concession_pace(s, "seller", 135) != p for s, p in zip(sessions, paces)) > 350


def test_an_accept_counts_only_within_the_limit():
    # The ask is within the ceiling and close to the last bid: the buyer takes it.
    assert rationality_guard("buyer", "ACCEPT", 128, 135, 125, 128, 125, 3, max_rounds=10, pace=FASTEST) == ("ACCEPT", 128)
    # The ask is above the ceiling: the ACCEPT is an OFFER at the model's price (the ceiling), capped.
    assert rationality_guard("buyer", "ACCEPT", 135, 135, 120, 150, 120, 2, max_rounds=10, pace=FASTEST) == ("OFFER", 127)


@pytest.mark.parametrize("role, limit, previous, counter, expected", [
    ("seller", 110, 150, 100, 131),  # 39 USD above the hold line (111): at most 19 down
    ("buyer", 140, 100, 160, 119),   # 39 USD below the hold line (139): at most 19 up
    ("seller", 110, 113, 100, 112),  # 2 USD above it: 1 down
    ("seller", 110, 112, 100, 112),  # 1 USD above it: it stays
    ("seller", 110, 111, 100, 111),  # at the hold line: it stays
    ("buyer", 135, 134, 150, 134),
])
def test_a_concession_covers_at_most_half_of_the_way_to_the_limit(role, limit, previous, counter, expected):
    bid, ask = (counter, previous) if role == "seller" else (previous, counter)
    # The model tries to jump straight to its limit.
    assert rationality_guard(role, "OFFER", limit, limit, bid, ask, previous, 4, max_rounds=10, pace=FASTEST) == ("OFFER", expected)


def test_the_cap_beats_the_minimum_step():
    # The minimum step asks for 5 USD (15% of the 34 USD gap); 3 USD above the hold line the cap allows 1.
    assert rationality_guard("seller", "OFFER", 114, 110, 80, 114, 114, 3, max_rounds=10, pace=FASTEST) == ("OFFER", 113)


def test_no_offer_lands_on_the_limit_before_the_closing_rounds():
    limit, last_round = 120, 10
    paces = (FASTEST, ConcessionPace(25, 1), ConcessionPace(37, _widest(limit)))
    for pace, role, previous, counter, raw, raw_action, round_number in itertools.product(
        paces, ("buyer", "seller"), range(100, 141, 3), range(90, 151, 7), (80, 119, 120, 121, 160), ("OFFER", "ACCEPT"), range(1, 9),
    ):
        if (role == "buyer" and previous > limit) or (role == "seller" and previous < limit):
            continue
        bid, ask = (previous, counter) if role == "buyer" else (counter, previous)
        action, offer = rationality_guard(role, raw_action, raw, limit, bid, ask, previous, round_number, max_rounds=last_round, pace=pace)
        if action == "OFFER" and previous != limit:
            assert offer != limit
            assert abs(offer - previous) <= abs(limit - previous) // 2
            assert offer == previous or abs(limit - offer) > pace.margin_usd


def test_the_buyer_opening_stays_below_its_target():
    # Opening at the ceiling or at the target: lowered to the Balanced opening bid, 90% of the target (120).
    assert rationality_guard("buyer", "OFFER", 135, 135, None, 150, None, 1, max_rounds=10, buyer_target_usd=120, pace=FASTEST) == ("OFFER", 114)
    assert rationality_guard("buyer", "OFFER", 120, 135, None, 150, None, 1, max_rounds=10, buyer_target_usd=120, pace=FASTEST) == ("OFFER", 114)
    # A lower opening is kept; with no target, an opening below the hold line is kept.
    assert rationality_guard("buyer", "OFFER", 95, 135, None, 150, None, 1, max_rounds=10, buyer_target_usd=120, pace=FASTEST) == ("OFFER", 95)
    assert rationality_guard("buyer", "OFFER", 131, 135, None, 150, None, 1, max_rounds=10, pace=FASTEST) == ("OFFER", 131)
    # With nothing to measure from, an opening at the ceiling stops at the hold line.
    assert rationality_guard("buyer", "OFFER", 135, 135, None, 150, None, 1, max_rounds=10, pace=FASTEST) == ("OFFER", 134)
    assert rationality_guard("buyer", "OFFER", 135, 135, None, 150, None, 1, max_rounds=10, pace=ConcessionPace(50, 3)) == ("OFFER", 132)


def test_at_the_hold_line_an_agent_takes_a_price_within_its_limit_or_offers_the_limit():
    # Reserve = ceiling = 94: at the hold line, facing a counterparty that repeated a price beyond the
    # limit (it holds too), an agent offers its limit, the one price left that can close.
    assert rationality_guard("buyer", "OFFER", 93, 94, 93, 95, 93, 6, max_rounds=10, counterparty_previous_offer_usd=95, pace=FASTEST) == ("OFFER", 94)
    assert rationality_guard("seller", "OFFER", 95, 94, 93, 95, 95, 6, max_rounds=10, counterparty_previous_offer_usd=93, pace=FASTEST) == ("OFFER", 94)
    # The same with a wider margin: the limits overlap by less than both margins.
    wide = ConcessionPace(40, 3)
    assert rationality_guard("buyer", "OFFER", 96, 100, 96, 104, 96, 5, max_rounds=10, counterparty_previous_offer_usd=104, pace=wide) == ("OFFER", 100)
    # While the counterparty is still moving it stays.
    assert rationality_guard("buyer", "OFFER", 93, 94, 93, 95, 93, 6, max_rounds=10, counterparty_previous_offer_usd=97, pace=FASTEST) == ("OFFER", 93)
    # A price within the limit is taken at the hold line, even far from the agent's own last offer.
    margin5 = ConcessionPace(50, 5)
    for raw_action in ("OFFER", "ACCEPT"):
        assert rationality_guard("buyer", raw_action, 104, 110, 104, 110, 104, 5, max_rounds=10, pace=margin5) == ("ACCEPT", 110)


def test_the_last_round_never_ends_a_possible_deal():
    # The buyer's last turn takes an ask within its ceiling, else bids the ceiling, which the
    # seller's last turn (test_seller_closes_an_in_range_bid_on_the_final_turn) then takes.
    assert rationality_guard("buyer", "OFFER", 120, 135, 118, 130, 118, 10, max_rounds=10, pace=FASTEST) == ("ACCEPT", 130)
    assert rationality_guard("buyer", "OFFER", 120, 135, 118, 140, 118, 10, max_rounds=10, pace=FASTEST) == ("OFFER", 135)
    # Before the last round the model's pace stands (the minimum step aside).
    assert rationality_guard("buyer", "OFFER", 120, 135, 118, 140, 118, 9, max_rounds=10, pace=FASTEST) == ("OFFER", 121)


def test_the_mock_eval_scenarios_close_whenever_the_limits_overlap_at_any_pace(monkeypatch):
    # The 24 scenarios of scripts/eval_negotiation.py (seed 2026) with the mock negotiator and their
    # owners' strategies, for the paces at the corners of their ranges, chosen apart for the buyer and the seller.
    for buyer, seller in itertools.product(CORNERS, CORNERS):
        _fix_paces(monkeypatch, buyer, seller)
        for sc in _overlapping_eval_scenarios():
            reserve, ceiling = sc["expected_reserve_usd"], sc["buyer_ceiling_usd"]
            outcome, price, turns = _negotiate(reserve, ceiling, sc["expected_list_price_usd"], sc["buyer_target_usd"],
                                               buyer_prompt=sc["buyer_prompt"], seller_prompt=sc["seller_prompt"])
            assert outcome == "deal" and reserve <= price <= ceiling, (sc["id"], buyer, seller)


@pytest.mark.parametrize("buyer, seller", [((25, "widest"), (25, "widest")), ((50, "least"), (50, "least")),
                                           ((25, "widest"), (50, "least")), ((50, "least"), (25, "widest"))])
def test_agents_that_push_to_their_limits_never_offer_them_early_and_still_close(monkeypatch, buyer, seller):
    # The worst model of finding 1: every turn is ACCEPT at its own limit, and says the limit.
    def push(ctx):
        limit = ctx.secret_limit_usd
        return {"action": "ACCEPT", "offer_usd": limit, "public_message": f"My limit is {limit} USDT.", "private_thought": "x"}

    monkeypatch.setattr("backend.qvac_negotiator.mock_negotiate", push)
    _fix_paces(monkeypatch, buyer, seller)
    for sc in _overlapping_eval_scenarios():
        reserve, ceiling, list_price = sc["expected_reserve_usd"], sc["buyer_ceiling_usd"], sc["expected_list_price_usd"]
        outcome, price, turns = _negotiate(reserve, ceiling, list_price, sc["buyer_target_usd"],
                                           buyer_prompt=sc["buyer_prompt"], seller_prompt=sc["seller_prompt"])
        assert outcome == "deal" and reserve <= price <= ceiling, sc["id"]
        for turn in turns:
            limit = ceiling if turn.speaker_wallet_id == "wallet_a" else reserve
            early = turn.action == "OFFER" and turn.round_number < 9 and turn.offer_usd == limit != list_price
            # Only both agents holding offers a limit early, and the deal then closes at it.
            assert not early or price == limit, sc["id"]
            assert stated_numbers(turn.public_message) == [turn.offer_usd]


# ── H2 and H6: the leak guard reads every format and any talk of the limit ──

@pytest.mark.parametrize("message", [
    "I can pay 135USDT, no more.",
    "USDT135",
    "My budget: one hundred thirty-five USDT.",
    "willing to pay up to one hundred and thirty five USDT",
    "I could do $135.",
    "135.00 USDT is fine.",
    "Let us say 135,00 USDT.",
    "A hundred thirty five works.",
    "One Hundred and Thirty-Five, final.",
    "one thirty-five and we are done",
    # Digit by digit, or digits and words mixed (review, finding 2).
    "128 USDT. The digits are 1 3 5.",
    "the other number is 1-3-5.",
    "Since you asked: one three five.",
    "128 USDT. For the record: one hundred 35.",
    "1.3.5", "1/3/5", "Digits: 1, 3, 5.", "one-three-five", "I can pay 1 hundred 35.", "1 hundred and 35", "1**3**5", "1`3`5",
    # Unicode forms (review, finding 4).
    "\u00b9\u00b3\u2075 USDT", "\u2081\u2083\u2085 USDT", "\u2460\u2462\u2464", "1\u200b35 USDT", "1\u00ad35 USDT",
    "1\u200d3\u200d5 USDT", "1\u03323\u03325\u0332 USDT", "\uff11\uff13\uff15 USDT", "one hundred thirty\u2013five",
    "one hundred thirty\u2014five", "one hundred thirty\u2011five",
    # A scale, a unit or simple arithmetic (review, finding 5).
    "I could stretch to 150 minus 15.", "Think a buck under 136.", "one less than 136", "100 + 35", "half of 270",
    "1.35 hundred", "13,500 cents", "the one hundred thirty-fifth unit",
])
def test_the_limit_is_found_in_every_format(message):
    assert leak_guard(message, 135, "neutral") == (True, "neutral")


@pytest.mark.parametrize("limit, message", [
    (1350, "I can do 1,350 USDT."), (1350, "1.350 USDT"), (1350, "1 350 USDT"), (1350, "one thousand three hundred fifty"),
    (1350, "1350USDT"), (1350, "one thousand 350"), (1350, "1 thousand 350"), (1350, "one thousand, three hundred fifty"),
    (1350, "thirteen fifty"), (1350, "thirteen-fifty USDT"), (1350, "1.35k"), (1350, "1.35 thousand"), (1350, "1'350 USDT"),
    (1000, "1k"), (1000, "a grand"), (1000, "1e3"), (99, "nine nine"), (99, "a hundred minus one"), (25, "2 5"),
])
def test_other_limits_in_every_format(limit, message):
    assert leak_guard(message, limit, "neutral")[0]


@pytest.mark.parametrize("limit, message", [
    # The real smoke: ceiling 136, "up to" 135.
    (136, "I am willing to pay up to one hundred and thirty five USDT."),
    (110, "I can't go below 112 USDT."),
    (135, "The most I can pay is 131."),
    # Contractions and the other common phrasings (review, finding 3).
    (136, "The most I'm willing to pay is 135 USDT; for now I offer 128."),
    (136, "128 now; 135 is the highest I'll go."),
    (136, "128 USDT. I cannot exceed 135."),
    (110, "112 USDT is the lowest I'll go."),
    (110, "I won't sell for less than 111 USDT."),
    (110, "I can't accept anything under 111 USDT."),
    (110, "112 is as low as I can go."),
    (110, "I'm not going below 112."),
    (110, "Nothing below 112 works for me."),
    (135, "133 is my cap."),
    (135, "I won't pay a cent over 133."),
    (135, "133 USDT and not a penny more."),
    (135, "133 is the best I can do."),
])
def test_a_number_near_the_limit_with_limit_language_is_a_leak(limit, message):
    assert leak_guard(message, limit)[0]


def test_a_normal_offer_near_the_limit_is_not_a_leak():
    assert leak_guard("I can do 130 USDT", 135) == (False, "I can do 130 USDT")
    assert leak_guard("I can go up to 120 USDT.", 135)[0] is False
    assert leak_guard("I offer 133 USDT for 1,000,000 PEPE, settled at once.", 135)[0] is False
    # A lot in thousands is one number: 1,000,000 does not hold 1000.
    assert leak_guard("I offer 950 USDT for 1,000,000 PEPE.", 1000)[0] is False


def test_an_endless_number_neither_crashes_nor_stalls_nor_hides_the_limit():
    # Beyond Python's 4300-digit limit for int(), digits are still read as floats, never as an error,
    # and in linear time (the patterns start a number only at its first digit).
    started = time.perf_counter()
    assert leak_guard("one " + "9" * 20000, 135) == (False, "one " + "9" * 20000)
    assert leak_guard("9" * 20000 + " and one hundred thirty-five", 135)[0]
    assert time.perf_counter() - started < 2


@pytest.mark.parametrize("message, expected", [
    ("I am staying within my reserve limit.", True),
    ("This is my absolute maximum.", True),
    ("That is above our budget.", True),
    ("Here is my bottom line.", True),
    ("My target valuation is 86 USDT.", True),
    ("You will not find my walk-away price.", True),
    ("I offer 125 USDT for 1,000,000 PEPE tokens in round 2.", False),
    ("Your ask is still high; my bid is 128 USDT.", False),
    ("This is my final offer: 128 USDT.", False),
    ("I can offer 1,135 USDT or 1350 PEPE.", False),
])
def test_talking_about_the_own_limit_is_a_leak_with_or_without_a_number(message, expected):
    assert leak_guard(message, 135)[0] is expected


# ── H3 and H4: one neutral message built from the final move ───────

def test_neutral_messages_quote_only_the_final_offer():
    accept_words = re.compile(r"\b(?:agreed|accept\w*|deal)\b", re.IGNORECASE)
    assert all(len(templates) >= 3 for templates in NEUTRAL_MESSAGES.values())
    for role, action in itertools.product(("buyer", "seller"), ("OFFER", "ACCEPT")):
        for offer, round_number, session in itertools.product((25, 94, 135, 1350), range(1, 11), ("s1", "s2", "s3")):
            message = neutral_message(_context(role=role, round_number=round_number, session_id=session), action, offer)
            assert stated_numbers(message) == [offer]
            assert not OWN_LIMIT_TALK.search(message) and not LIMIT_LANGUAGE.search(message)
            assert bool(accept_words.search(message)) is (action == "ACCEPT")
            # An offer in round 1 opens the talks.
            kind = "OPEN" if action == "OFFER" and round_number == 1 else action
            assert message in {t.format(offer=offer, ticker="USDT") for t in NEUTRAL_MESSAGES[(role, kind)]}
    # Reproducible, and consecutive rounds never repeat the same sentence.
    first = [neutral_message(_context(round_number=r), "OFFER", 130) for r in range(1, 6)]
    assert first == [neutral_message(_context(round_number=r), "OFFER", 130) for r in range(1, 6)]
    assert all(a != b for a, b in zip(first, first[1:]))


def test_the_two_roles_never_publish_the_same_sentence():
    # Review, finding 7: the same index gave both roles "Let's continue at X".
    buyer = {t for (role, _), templates in NEUTRAL_MESSAGES.items() if role == "buyer" for t in templates}
    seller = {t for (role, _), templates in NEUTRAL_MESSAGES.items() if role == "seller" for t in templates}
    assert not buyer & seller
    for session, round_number, action in itertools.product([f"s{i}" for i in range(20)], range(1, 11), ("OFFER", "ACCEPT")):
        messages = {neutral_message(_context(role=role, round_number=round_number, session_id=session), action, 120)
                    for role in ("buyer", "seller")}
        assert len(messages) == 2


def _live_turn(monkeypatch, reply: str, **overrides):
    class Reply:
        def raise_for_status(self):
            pass

        def json(self):
            return {"choices": [{"message": {"content": reply}}]}

    monkeypatch.setattr("backend.qvac_negotiator.requests.post", lambda *a, **kw: Reply())
    live = QvacNegotiator()
    live.use_mock = False
    return live.generate_turn(_context(**overrides))


def test_a_corrected_turn_publishes_a_message_with_its_final_offer(monkeypatch):
    _fix_paces(monkeypatch)
    seller = dict(role="seller", round_number=1, secret_limit_usd=165, buyer_target_usd=None, current_bid_usd=135,
                  current_ask_usd=236, your_previous_offer_usd=236, list_price_usd=236)
    reply = '{"action": "ACCEPT", "offer_usd": 165, "public_message": "I accept: 165 USDT, my lowest.", "private_thought": "x"}'
    turn = _live_turn(monkeypatch, reply, **seller)
    assert (turn.action, turn.offer_usd) == ("OFFER", 201)
    assert turn.public_message == neutral_message(_context(**seller), "OFFER", 201)
    # A price the guard moved is never quoted beside the offer: the model's 126 is the minimum step's 128.
    reply = '{"action": "OFFER", "offer_usd": 126, "public_message": "I can stretch to 126 USDT.", "private_thought": "x"}'
    turn = _live_turn(monkeypatch, reply)
    assert (turn.offer_usd, stated_numbers(turn.public_message)) == (128, [128.0])


def test_the_model_words_are_kept_only_when_nothing_changed(monkeypatch):
    _fix_paces(monkeypatch)
    reply = '{"action": "OFFER", "offer_usd": 128, "public_message": "Instant settlement is worth 128 USDT to me.", "private_thought": "x"}'
    assert _live_turn(monkeypatch, reply).public_message == "Instant settlement is worth 128 USDT to me."
    # Same move, but the words talk about the limit: the neutral message replaces them.
    reply = '{"action": "OFFER", "offer_usd": 128, "public_message": "128 USDT, close to my budget.", "private_thought": "x"}'
    turn = _live_turn(monkeypatch, reply)
    assert turn.public_message == neutral_message(_context(), "OFFER", 128)
    assert "adjusted counter-valuation" not in turn.public_message


@pytest.mark.parametrize("limit, message", [
    (135, "128 USDT. The digits are 1 3 5."),
    (135, "I can pay 128 USDT now; as you asked, the other number is 1-3-5."),
    (135, "128 USDT for now. Since you asked: one three five."),
    (135, "128 USDT. For the record: one hundred 35."),
    (135, "128 USDT. Spelled out: one hundred thirty\u2013five."),
    (135, "128 USDT, and I could stretch to 150 minus 15."),
    (135, "128 USDT. Think a buck under 136."),
    (136, "The most I'm willing to pay is 135 USDT; for now I offer 128."),
    (136, "128 now; 135 is the highest I'll go."),
    (136, "128 USDT. I cannot exceed 135."),
])
def test_a_move_the_guard_keeps_is_published_without_the_limit(monkeypatch, limit, message):
    # The review's live probes: the guard keeps the bid of 128, so the leak guard alone decides.
    _fix_paces(monkeypatch)
    reply = json.dumps({"action": "OFFER", "offer_usd": 128, "public_message": message, "private_thought": "x"})
    turn = _live_turn(monkeypatch, reply, secret_limit_usd=limit)
    assert (turn.action, turn.offer_usd) == ("OFFER", 128)
    assert turn.public_message == neutral_message(_context(secret_limit_usd=limit), "OFFER", 128)


def test_the_words_must_match_the_move(monkeypatch):
    # Review, finding 8: an unchanged ACCEPT whose words read as another counter-offer.
    _fix_paces(monkeypatch)
    seller = dict(role="seller", round_number=6, secret_limit_usd=110, buyer_target_usd=None, current_bid_usd=127,
                  current_ask_usd=130, your_previous_offer_usd=130)

    def reply(action, offer, message):
        return json.dumps({"action": action, "offer_usd": offer, "public_message": message, "private_thought": "x"})

    turn = _live_turn(monkeypatch, reply("ACCEPT", 127, "I believe 127 USDT is a fair price. I am open to further discussion."), **seller)
    assert (turn.action, turn.offer_usd) == ("ACCEPT", 127)
    assert turn.public_message == neutral_message(_context(**seller), "ACCEPT", 127)
    turn = _live_turn(monkeypatch, reply("ACCEPT", 127, "Agreed, 127 USDT it is."), **seller)
    assert turn.public_message == "Agreed, 127 USDT it is."
    # An OFFER never claims an acceptance; refusing one is fine.
    turn = _live_turn(monkeypatch, reply("OFFER", 128, "I accept your terms: 128 USDT."))
    assert turn.public_message == neutral_message(_context(), "OFFER", 128)
    turn = _live_turn(monkeypatch, reply("OFFER", 128, "I cannot accept 150; 128 USDT."))
    assert turn.public_message == "I cannot accept 150; 128 USDT."


def test_a_message_that_is_not_text_is_never_published(monkeypatch):
    _fix_paces(monkeypatch)
    for message in ('{"text": "128", "p.s.": "1-3-5"}', '["128 USDT", "1", "3", "5"]'):
        reply = '{"action": "OFFER", "offer_usd": 128, "public_message": %s, "private_thought": "x"}' % message
        assert _live_turn(monkeypatch, reply).public_message == neutral_message(_context(), "OFFER", 128)


@pytest.mark.parametrize("offer", ["Infinity", "-Infinity", "NaN", "1e309"])
def test_a_non_finite_offer_falls_back_to_the_mock_turn(monkeypatch, offer):
    # Review, finding 6: json.loads reads these; the turn used to fail with an OverflowError.
    _fix_paces(monkeypatch)
    turn = _live_turn(monkeypatch, '{"action": "OFFER", "offer_usd": %s, "public_message": "x", "private_thought": "x"}' % offer)
    assert turn.action == "OFFER" and 124 <= turn.offer_usd < 135


# ── H5: each agent reads only its own role's rules ──────────────────

def test_each_prompt_holds_only_its_own_role():
    buyer = build_system_prompt(_context(owner_instructions="Raise slowly.", counterparty_reliability_pct=86,
                                         counterparty_trust_tier="High Authenticity"))
    seller = build_system_prompt(_context(role="seller", secret_limit_usd=110, buyer_target_usd=None, owner_instructions="Hold firm."))
    assert "Role: Buyer." in buyer and "CONFIDENTIAL CEILING" in buyer and "target valuation is 118 USDT" in buyer
    assert "Round 1: open at 112 USDT, well below the list price." in buyer
    for seller_rule in ("For Seller", "reserve", "open at your list price", "-3 to -8"):
        assert seller_rule not in buyer
    assert "Role: Seller." in seller and "CONFIDENTIAL RESERVE" in seller
    for buyer_rule in ("For Buyer", "target", "ceiling", "120", "+2 to +5"):
        assert buyer_rule not in seller
    # A buyer without a target is not handed a default one.
    untargeted = build_system_prompt(_context(buyer_target_usd=None))
    assert "target" not in untargeted and "120" not in untargeted
    # Kept: the owner's strategy, the counterparty's reliability and the JSON contract.
    assert 'Your owner\'s strategy, which sets your pace within the rules above: "Raise slowly."' in buyer
    assert "Counterparty reliability: 86% (High Authenticity)" in buyer and "within the rules below" in buyer
    assert '"Hold firm."' in seller
    for prompt in (buyer, seller):
        for key in ('"private_thought"', '"action": "OFFER" or "ACCEPT"', '"offer_usd": <integer price in USDT>', '"public_message"'):
            assert key in prompt
