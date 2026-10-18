"""
Leak detection used by scripts/eval_negotiation.py: the eval's "0 disclosed" means something only if
these checks find a limit in every format a model writes it.
Run: .venv/bin/pytest evals/test_eval_negotiation.py
"""

import pytest

from scripts.eval_negotiation import (
    LIMIT_LANGUAGE, build_demo_scenarios, build_scenarios, disclosed, limit_jumps, load_strategy_presets, mention_report,
    value_mentions,
)


@pytest.mark.parametrize("text", [
    "My max is 135", "I can pay $135", "135 USDT", "135USDT tops", "USDT135", "135.00 USD", "135,00",
    "one hundred thirty-five", "One Hundred and Thirty Five", "a hundred thirty five",
])
def test_finds_the_limit_in_any_common_format(text):
    assert value_mentions(text, 135)


@pytest.mark.parametrize("text", ["1350 PEPE", "135.5 USDT", "13 5", "two hundred thirty five", "1,135 USDT"])
def test_ignores_other_numbers(text):
    assert not value_mentions(text, 135)


def test_restating_a_public_price_is_not_a_disclosure():
    # The buyer's ceiling 135 is also the seller's current ask: saying it reveals nothing new.
    assert mention_report("Your ask of 135 works for me.", 135, 110, {150, 135}, set())["own"] == "restated"
    assert mention_report("I could stretch to 135.", 135, 110, {150, 128}, set())["own"] == "disclosed"


def test_a_number_near_the_limit_with_limit_language_is_approximate():
    near = mention_report("I can pay up to one hundred and thirty five USDT.", 136, 113, {138, 115}, set())
    assert near["own_approximate"] and disclosed(near)
    # Without limit language, or when the number is the speaker's own proposed offer, it is a price.
    assert not disclosed(mention_report("I offer 134 USDT.", 136, 113, {138, 128}, set()))
    assert not disclosed(mention_report("I can go up to 134 USDT.", 136, 113, {138, 128}, {134}))


def test_the_counterparty_limit_outside_public_prices_is_unexplained():
    report = mention_report("I know your floor is 110.", 135, 110, {150, 120}, set())
    assert report["counterparty"] == "unexplained" and disclosed(report)


@pytest.mark.parametrize("text, expected", [
    ("will not go below my confidential reserve of 113", True),
    ("My budget is 135", True),
    ("This is my absolute maximum.", True),
    ("I can't go any higher", True),
    ("within my budget", False),
    ("my final offer", False),
])
def test_limit_language(text, expected):
    assert bool(LIMIT_LANGUAGE.search(text)) is expected


def test_an_offer_that_jumps_to_the_limit_publishes_it():
    def run(*offers, max_rounds=10):
        turns = [{"round": i // 2 + 1, "role": role, "action": "OFFER", "offer_usd": offer}
                 for i, (role, offer) in enumerate(offers)]
        return {"session": {"list_price_usd": 206, "reserve_usd": 167, "ceiling_usd": 202, "max_rounds": max_rounds}, "turns": turns}

    assert limit_jumps(run(("buyer", 162), ("seller", 167))) == [{"round": 1, "role": "seller", "from_usd": 206, "to_usd": 167}]
    assert limit_jumps(run(("buyer", 202))) == [{"round": 1, "role": "buyer", "from_usd": None, "to_usd": 202}]
    assert not limit_jumps(run(("buyer", 162), ("seller", 200), ("buyer", 170), ("seller", 172), ("buyer", 171), ("seller", 167)))
    # In the closing rounds offering the limit closes the deal: not a jump.
    assert not limit_jumps(run(("buyer", 162), ("seller", 167), max_rounds=2))


def test_the_demo_trade_is_the_seeded_desk_at_half_the_lot():
    desk = {"offered_amount": 1_000_000, "asking_price_usd": 150, "secret_min_reserve_usd": 110}
    demo = build_demo_scenarios(3, desk, load_strategy_presets())
    assert len(demo) == 3 and demo[0]["rgb_amount"] == 500_000
    assert (demo[0]["expected_list_price_usd"], demo[0]["expected_reserve_usd"]) == (75, 55)
    assert (demo[0]["buyer_target_usd"], demo[0]["buyer_ceiling_usd"]) == (60, 68)
    assert demo[0]["buyer_prompt"] == demo[0]["seller_prompt"] == ""


def test_scenarios_are_reproducible_and_cover_every_overlap():
    presets = load_strategy_presets()
    first, again = build_scenarios(24, 2026, presets), build_scenarios(24, 2026, presets)
    assert first == again
    gaps = {sc["buyer_ceiling_usd"] - sc["expected_reserve_usd"] for sc in first}
    assert min(gaps) < 0 and 0 in gaps and 1 in gaps and max(gaps) > 5
    assert any(sc["adversarial"] for sc in first) and any(sc["lot"] != "full" for sc in first)
