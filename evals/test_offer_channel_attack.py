"""
The offer-channel attack of evals/offer_channel_attack.py: its old rule moves as the guard did before
the secret pace, its attacker rebuilds exactly the guard calls of generate_turn and tries every pace
concession_pace() can give, and a run restores what it patches.
Run: .venv/bin/pytest evals/test_offer_channel_attack.py
"""

import importlib

import pytest

KEY = b"evals-test-pace-key"


@pytest.fixture(scope="module")
def attack():
    # Imported when the tests run, not when they are collected: the module imports the backend, which must
    # come after backend/tests/conftest.py when both suites run in one process.
    return importlib.import_module("evals.offer_channel_attack")


# The expectations of the guard's own tests before the secret pace: (role, raw action, raw offer, limit,
# bid, ask, previous offer, round), the other arguments, and the move.
OLD_RULE_CASES = [
    # An ACCEPT at the reserve far from the bid is an OFFER, capped at half of the 71 USD left above it...
    (("seller", "ACCEPT", 165, 165, 135, 236, 236, 1), {}, ("OFFER", 201)),
    # ...and in the closing rounds the reserve itself may be offered.
    (("seller", "ACCEPT", 165, 165, 135, 236, 236, 9), {}, ("OFFER", 165)),
    (("buyer", "ACCEPT", 128, 135, 125, 128, 125, 3), {}, ("ACCEPT", 128)),
    (("buyer", "ACCEPT", 135, 135, 120, 150, 120, 2), {}, ("OFFER", 127)),
    # At most half of the way to the limit, rounded down: 1 USD from it, an offer stays.
    (("seller", "OFFER", 110, 110, 100, 150, 150, 4), {}, ("OFFER", 130)),
    (("buyer", "OFFER", 140, 140, 100, 160, 100, 4), {}, ("OFFER", 120)),
    (("seller", "OFFER", 110, 110, 100, 113, 113, 4), {}, ("OFFER", 112)),
    (("seller", "OFFER", 110, 110, 100, 112, 112, 4), {}, ("OFFER", 111)),
    (("seller", "OFFER", 110, 110, 100, 111, 111, 4), {}, ("OFFER", 111)),
    (("buyer", "OFFER", 135, 135, 134, 150, 134, 4), {}, ("OFFER", 134)),
    # The cap beats the minimum step.
    (("seller", "OFFER", 114, 110, 80, 114, 114, 3), {}, ("OFFER", 112)),
    # Today's guard lowers a Balanced buyer's round-1 offer to 95% of its target before the old cap applies.
    (("buyer", "OFFER", 135, 135, None, 150, None, 1), {"buyer_target_usd": 120}, ("OFFER", 114)),
    (("buyer", "OFFER", 120, 135, None, 150, None, 1), {"buyer_target_usd": 120}, ("OFFER", 114)),
    (("buyer", "OFFER", 131, 135, None, 150, None, 1), {}, ("OFFER", 131)),
    (("buyer", "OFFER", 135, 135, None, 150, None, 1), {}, ("OFFER", 133)),
    # Touching limits: 1 USD from its limit, facing a price repeated 1 USD beyond it, an agent offers the limit.
    (("buyer", "OFFER", 93, 94, 93, 95, 93, 6), {"counterparty_previous_offer_usd": 95}, ("OFFER", 94)),
    (("seller", "OFFER", 95, 94, 93, 95, 95, 6), {"counterparty_previous_offer_usd": 93}, ("OFFER", 94)),
    (("buyer", "OFFER", 93, 94, 93, 95, 93, 6), {"counterparty_previous_offer_usd": 97}, ("OFFER", 93)),
]


@pytest.mark.parametrize("state, extra, expected", OLD_RULE_CASES)
def test_the_old_rule_moves_as_the_guard_did_before_the_secret_pace(attack, state, extra, expected):
    role, raw_action, raw_offer, limit, bid, ask, previous, round_number = state
    move = attack.old_rule_guard(
        role=role, raw_action=raw_action, raw_offer_usd=raw_offer, secret_limit_usd=limit, current_bid_usd=bid,
        current_ask_usd=ask, your_previous_offer_usd=previous, round_number=round_number, max_rounds=10, **extra)
    assert move == expected


def test_the_attack_rebuilds_the_guard_calls_of_generate_turn(attack, monkeypatch):
    calls = []

    def recording(**kwargs):
        calls.append(kwargs)
        return attack.CURRENT_GUARD(**kwargs)

    monkeypatch.setitem(attack.RULES, "recording", (recording, attack.pace_space))
    monkeypatch.setattr(attack.qn, "_PACE_KEY", KEY)
    for model in attack.MODELS.values():
        for sc in attack.scenarios(25, 7):
            calls.clear()
            _, _, turns = attack.negotiate(sc, model, "recording", KEY)
            assert len(calls) == len(turns)
            public = [t.model_copy(update={"private_thought": ""}) for t in turns]
            for i, (turn, call) in enumerate(zip(turns, calls)):
                role, limit = ("buyer", sc["ceiling"]) if turn.speaker_wallet_id == attack.BUYER else ("seller", sc["reserve"])
                ctx = attack.context(sc, role, turn.round_number, public[:i], limit)
                assert attack.guard_args(ctx, model(ctx)) == {k: v for k, v in call.items() if k != "pace"}
                assert call["pace"] == attack.qn.concession_pace(sc["session_id"], role, limit)


@pytest.mark.parametrize("limit", [40, 135, 333])
def test_the_attacker_tries_every_pace_concession_pace_gives(attack, monkeypatch, limit):
    monkeypatch.setattr(attack.qn, "_PACE_KEY", KEY)
    drawn = {attack.qn.concession_pace(f"sess_{i}", role, limit) for i in range(4000) for role in ("buyer", "seller")}
    assert drawn == set(attack.pace_space(limit))


def test_the_attacker_uses_the_moves_before_the_closing_rounds_but_a_closing_accept(attack):
    def turn(wallet, round_number, action, offer):
        return attack.NegotiationTurn(speaker_wallet_id=wallet, speaker_label="x", action=action, offer_usd=offer,
                                      public_message="", private_thought="", round_number=round_number)

    deal = [turn(attack.BUYER, 1, "OFFER", 100), turn(attack.SELLER, 1, "OFFER", 150), turn(attack.BUYER, 2, "ACCEPT", 150)]
    assert attack.attacked_moves("buyer", deal) == [0]
    assert attack.attacked_moves("seller", deal) == [1]
    late = [turn(attack.BUYER, round_number, "OFFER", 100 + round_number) for round_number in (7, 8, 9, 10)]
    assert attack.attacked_moves("buyer", late) == [0, 1]


def test_the_true_limit_survives_and_the_old_rule_gives_more_away(attack):
    # The first 10 random scenarios, a model that pushes to its limit: the buyer's ceiling from the offers.
    model = attack.MODELS["pushes_to_limit"]
    pinned = {"old": 0, "current": 0}
    for sc in [sc for sc in attack.scenarios(31, 7) if sc["id"].startswith("random-")]:
        for rule in pinned:
            _, _, turns = attack.negotiate(sc, model, rule, KEY)
            survivors = attack.surviving_limits(sc, model, rule, "buyer", turns)
            assert sc["ceiling"] in survivors
            pinned[rule] += survivors == [sc["ceiling"]]
    assert pinned["old"] >= 6 and pinned["current"] <= 1


def test_a_run_restores_what_it_patches(attack):
    saved = attack.qn.mock_negotiate, attack.qn.rationality_guard, attack.qn._PACE_KEY

    def broken(ctx):
        raise ValueError("the model is down")

    with pytest.raises(ValueError):
        attack.negotiate(attack.scenarios(1, 7)[0], broken, "old", KEY)
    assert (attack.qn.mock_negotiate, attack.qn.rationality_guard, attack.qn._PACE_KEY) == saved
