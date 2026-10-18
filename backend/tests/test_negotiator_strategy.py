"""
The owner's strategy sets its agent's pace: a Strict buyer opens well below its target and raises in
small steps, a Balanced one opens somewhat below it, a Flexible one near it and raises faster; the
seller mirrors it from its list price. The secret pace, the hold line, the closing rounds and the
leak guard keep their guarantees at every strategy, and overlapping limits still close.
"""

import itertools
import statistics

import pytest

from backend.qvac_negotiator import (
    STRATEGIES,
    ConcessionPace,
    QvacNegotiator,
    build_system_prompt,
    concession_pace,
    leak_guard,
    mock_negotiate,
    opening_bid,
    rationality_guard,
    strategy_of,
)
from backend.tests.test_negotiator_hardening import _context, _negotiate, _overlapping_eval_scenarios
from scripts.eval_negotiation import load_strategy_presets

PRESETS = load_strategy_presets()
ORDER = ("strict", "balanced", "flexible")


def _pace(strategy):
    return ConcessionPace(share_pct=50, margin_usd=1, strategy=strategy)


def test_the_presets_and_the_owners_own_words_read_as_a_strategy():
    for role, presets in PRESETS.items():
        assert {name: strategy_of(prompt) for name, prompt in presets.items()} == {name: name for name in ORDER}, role
    assert strategy_of("  strict:  defend your list price.") == "strict"
    for words, expected in [
        ("Be aggressive and lowball them.", "strict"), ("Drive a hard bargain.", "strict"), ("Play it tough.", "strict"),
        ("I want to sell tonight: close quickly.", "flexible"), ("Be fast, close soon.", "flexible"),
        ("Be warm and brief.", "balanced"), ("Raise slowly.", "balanced"), ("", "balanced"),
        # Tough and quick at once is no clear ask: Balanced.
        ("Be tough but quick.", "balanced"),
    ]:
        assert strategy_of(words) == expected, words


@pytest.mark.parametrize("target, ceiling, expected", [
    (120, 135, (84, 114, 120)),
    (60, 68, (42, 57, 60)),  # the demo trade
    (9, 9, (6, 8, 8)),  # never at the ceiling
    (1, 2, (1, 1, 1)),  # at least 1 USD
])
def test_the_opening_bid_is_a_share_of_the_target(target, ceiling, expected):
    assert tuple(opening_bid(target, ceiling, strategy) for strategy in ORDER) == expected


@pytest.mark.parametrize("strategy", ORDER)
def test_the_buyer_opens_below_its_target_at_every_strategy(strategy):
    target, ceiling = 120, 135
    opening = opening_bid(target, ceiling, strategy)
    for raw, round_one_pace in itertools.product((ceiling, 200, target, opening + 1), (_pace(strategy), ConcessionPace(25, 4, strategy))):
        action, offer = rationality_guard("buyer", "OFFER", raw, ceiling, None, 150, None, 1, max_rounds=10,
                                          buyer_target_usd=target, pace=round_one_pace)
        assert (action, offer) == ("OFFER", opening)
    # The mock buyer, like a model that follows its prompt, opens there too.
    ctx = _context(round_number=1, current_bid_usd=None, your_previous_offer_usd=None, buyer_target_usd=target,
                   owner_instructions=PRESETS["buyer"][strategy])
    assert (mock_negotiate(ctx)["action"], mock_negotiate(ctx)["offer_usd"]) == ("OFFER", opening)
    # The prompt names the opening, never at the ceiling, and the strategy's steps.
    prompt = build_system_prompt(ctx)
    low, high = STRATEGIES[strategy].raise_usd
    assert f"Round 1: open at {opening} USDT, well below the list price." in prompt
    assert f"+{low} to +{high} USDT per round" in prompt and opening != ceiling
    # A normal opening message is no leak.
    assert leak_guard(f"I open at {opening} USDT for the lot, settled at once.", ceiling)[0] is False


def test_the_opening_is_lower_the_stricter_the_owner():
    openings = []
    for strategy in ORDER:
        negotiator = QvacNegotiator()
        negotiator.use_mock = True
        turn = negotiator.generate_turn(_context(round_number=1, current_bid_usd=None, your_previous_offer_usd=None,
                                                 owner_instructions=PRESETS["buyer"][strategy]))
        openings.append(turn.offer_usd)
    assert openings == [83, 112, 118]  # target 118: Strict well below it, Flexible at it, never above


@pytest.mark.parametrize("role, previous, counter", [("buyer", 100, 150), ("seller", 150, 100)])
def test_a_stricter_owner_concedes_less_per_round(role, previous, counter):
    # A model that repeats its last offer is moved by the strategy's minimum step: 7%, 15% or 25% of the 50 USD gap.
    limit = 135 if role == "buyer" else 110
    bid, ask = (previous, counter) if role == "buyer" else (counter, previous)
    steps = [abs(rationality_guard(role, "OFFER", previous, limit, bid, ask, previous, 3, max_rounds=10, pace=_pace(s))[1] - previous)
             for s in ORDER]
    assert steps == [4, 8, 12]
    # The prompt's suggested step follows the strategy too.
    ranges = [STRATEGIES[s].raise_usd if role == "buyer" else STRATEGIES[s].cut_usd for s in ORDER]
    assert ranges == sorted(ranges) and len(set(ranges)) == 3


def test_the_strategy_never_lifts_the_secret_cap():
    # The cap beats the minimum step at every strategy: 3 USD above the hold line (111) the seller moves 1.
    for strategy in ORDER:
        assert rationality_guard("seller", "OFFER", 114, 110, 80, 114, 114, 3, max_rounds=10, pace=_pace(strategy)) == ("OFFER", 113)
    # The pace's strategy is the owner's; the secret share and margin do not depend on it.
    paces = {concession_pace("sess_x", "buyer", 135, strategy) for strategy in ORDER}
    assert {(p.share_pct, p.margin_usd) for p in paces} == {tuple(concession_pace("sess_x", "buyer", 135))[:2]}
    assert {p.strategy for p in paces} == set(ORDER)


def _concessions(turns, wallet_id):
    offers = [t.offer_usd for t in turns if t.speaker_wallet_id == wallet_id and t.action == "OFFER" and t.round_number < 9]
    return [abs(b - a) for a, b in zip(offers, offers[1:])]


def test_full_negotiations_concede_at_the_owner_pace_and_still_close(monkeypatch):
    monkeypatch.setattr("backend.qvac_negotiator.concession_pace",
                        lambda session_id, role, limit, strategy="balanced": ConcessionPace(50, 1, strategy))
    steps = {}
    for buyer, seller in itertools.product(ORDER, ORDER):
        buyer_steps, seller_steps = [], []
        for sc in _overlapping_eval_scenarios():
            reserve, ceiling = sc["expected_reserve_usd"], sc["buyer_ceiling_usd"]
            outcome, price, turns = _negotiate(reserve, ceiling, sc["expected_list_price_usd"], sc["buyer_target_usd"],
                                               buyer_prompt=PRESETS["buyer"][buyer], seller_prompt=PRESETS["seller"][seller])
            assert outcome == "deal" and reserve <= price <= ceiling, (sc["id"], buyer, seller)
            opening = next(t for t in turns if t.speaker_wallet_id == "wallet_a")
            assert opening.action == "ACCEPT" or opening.offer_usd <= opening_bid(sc["buyer_target_usd"], ceiling, buyer)
            buyer_steps += _concessions(turns, "wallet_a")
            seller_steps += _concessions(turns, "wallet_b")
        steps[buyer, seller] = statistics.mean(buyer_steps or [0]), statistics.mean(seller_steps or [0])
    # Against the same counterparty, a stricter owner concedes less per round, on both sides.
    for other in ORDER:
        assert steps["strict", other][0] < steps["balanced", other][0] < steps["flexible", other][0], other
        assert steps[other, "strict"][1] < steps[other, "balanced"][1] < steps[other, "flexible"][1], other
