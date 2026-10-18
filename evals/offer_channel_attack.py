#!/usr/bin/env python3
"""
Offer-channel attack: can a counterparty that knows every rule solve the other agent's secret limit
from the offers it publishes?

The leak guard keeps a limit out of the words (scripts/eval_negotiation.py); this eval tests the
numbers. Before the closing rounds (the last two), the rationality guard of backend/qvac_negotiator.py
caps every concession at a secret pace of each agent in each session (concession_pace(): a move covers
at most 25-50% of the room left to a hold line, which lies 1 USD to 3% inside the limit, both drawn
from an HMAC of the session id and the role under a key of the server process).

Each scenario is negotiated on QvacNegotiator.generate_turn, the product's own turn (rationality guard,
leak guard), in the order and with the stop rules of api_server.run_negotiation_loop. Only the model's
raw reply is simulated, by two deterministic models: one that pushes to its limit (it offers the limit
every turn, so every move it publishes is the guard's cap) and the backend's own mock negotiator.

The attacker knows everything but the pace and the limit: the guard's code, the pace ranges, the
model's reply as a function of the limit, the list price, the round count, every public offer and,
against the buyer, even its target valuation. For every candidate limit and every pace in those ranges
it replays the guard over the moves the target published before the closing rounds (all of them but an
ACCEPT that closed the deal, which leaves nothing to exploit), and keeps the limits that some pace
reproduces exactly. A limit is pinned when a single candidate is left. The counterparty knows more: its
own limit, and that the overlap check let the talks start, so the two limits overlap; its count keeps
only the candidates that also fit that. Before the closing rounds the guard offers a limit openly only
to close limits that nearly touch, the limit being then the one price left that can close (today when
they overlap by less than the two agents' margins): those negotiations are counted apart, and the
pinned counts are over the others.

The same attacks run against the cap the guard had before the secret pace (old_rule_guard()).

Hermetic: no QVAC, no regtest, no network, a throwaway MWM_DATA_DIR. The pace key, drawn at random by
each server process, is fixed by --pace-key, so a run is reproducible. Caveats: the replies come from
two simulated models whose behaviour the attacker knows exactly, not from QVAC, and each negotiation is
attacked on its own (several sessions against the same limit are not combined).

Usage (from the repo root):
  .venv/bin/python evals/offer_channel_attack.py                  # 321 scenarios, about 2 minutes
  .venv/bin/python evals/offer_channel_attack.py --scenarios 40   # a quicker run
Options: --scenarios N (the 21 overlapping scenarios of scripts/eval_negotiation.py, then random ones),
--seed N (the random scenarios, default 7), --pace-key TEXT, --out PATH (default evals/offer_channel_attack.json).
"""

import argparse
import atexit
import contextlib
import functools
import hashlib
import json
import logging
import os
import random
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from collections import Counter
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional, Tuple

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / "evals" / "offer_channel_attack.json"
DEFAULT_SCENARIOS, DEFAULT_SEED, DEFAULT_PACE_KEY = 321, 7, "mwm-offer-channel-attack"
BUYER, SELLER = "wallet_a", "wallet_b"
LABELS = {BUYER: "Wallet A", SELLER: "Wallet B"}
# The product's default (settings.NEGOTIATION_MAX_ROUNDS), fixed so that a run does not depend on the environment.
MAX_ROUNDS = 10
CLOSING_ROUND = MAX_ROUNDS - 1
# The scenarios of scripts/eval_negotiation.py at its defaults (24 runs, seed 2026).
EVAL_RUNS, EVAL_SEED = 24, 2026
OVERLAPS = ("touching", "narrow", "wide")


def isolate_environment() -> None:
    """Throwaway backend settings, set before backend.config is imported (as backend/tests/conftest.py does)."""
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    if "backend.config" in sys.modules:
        return  # imported already, under backend/tests/conftest.py; the negotiator below never calls QVAC anyway
    data_dir = tempfile.mkdtemp(prefix="mwm-attack-")
    atexit.register(shutil.rmtree, data_dir, ignore_errors=True)
    os.environ["MWM_DATA_DIR"] = data_dir
    os.environ["ELECTRUM_URL"] = "127.0.0.1:9"
    os.environ["REGTEST_SCRIPT"] = os.path.join(data_dir, "no-regtest.sh")
    os.environ["QVAC_MOCK"] = "1"
    # The mock never sends the key: a placeholder keeps get_api_key() off ~/.mwm/qvac.key.
    os.environ.setdefault("QVAC_API_KEY", "mwm-eval-placeholder")


isolate_environment()

import backend.qvac_negotiator as qn
from backend.qvac_negotiator import ConcessionPace, NegotiationContext, NegotiationTurn, QvacNegotiator
from scripts.eval_negotiation import build_scenarios, load_strategy_presets, overlap_class

# The product's own guard and mock, kept before anything is patched.
CURRENT_GUARD = qn.rationality_guard
MOCK = qn.mock_negotiate

# ── Models: the raw reply, simulated ────────────────────────────────

def pushes_to_limit(ctx: NegotiationContext) -> Dict[str, Any]:
    """A model that offers its own secret limit every turn: every move it publishes is the guard's cap."""
    return {"action": "OFFER", "offer_usd": ctx.secret_limit_usd, "public_message": "", "private_thought": ""}


MODELS: Dict[str, Callable[[NegotiationContext], Dict[str, Any]]] = {"pushes_to_limit": pushes_to_limit, "mock": MOCK}
MODEL_LABELS = {"pushes_to_limit": "pushes to its limit", "mock": "backend mock"}

# ── The old rule ────────────────────────────────────────────────────
# Before the secret pace the cap was one public rule: before the closing rounds a new offer moved at most
# half of the distance from the previous offer to the limit itself, rounded down, so it never reached the
# limit (1 USD from it, the offer stayed). The buyer's first bid was measured from its target valuation,
# and an opening at the limit with nothing to measure from moved MIN_STEP_USD inside it. One exception:
# 1 USD from the limit, facing a counterparty that had repeated a price 1 USD beyond it (touching limits),
# an agent offered the limit. old_rule_guard() runs today's guard with a pace that caps nothing (a hold
# line on the limit itself, all of the room left), then applies that cap. Before the closing rounds, where
# the attack looks, today's other checks are the old guard's, so it moves as the old guard did; in the
# last round the old buyer did not yet bid its ceiling, which changes no move attacked.
UNCAPPED = ConcessionPace(share_pct=100, margin_usd=0)


def old_rule_guard(*, pace: Optional[ConcessionPace] = None, **args: Any) -> Tuple[str, int]:
    """rationality_guard() with the cap it had before the secret pace; `pace` is ignored."""
    action, offer = CURRENT_GUARD(**args, pace=UNCAPPED)
    last_round = args.get("max_rounds") or qn.settings.NEGOTIATION_MAX_ROUNDS
    if action != "OFFER" or args["round_number"] >= max(last_round - 1, 1):
        return action, offer
    role, limit = args["role"], args["secret_limit_usd"]
    inward = 1 if role == "buyer" else -1
    anchor = args.get("your_previous_offer_usd")
    target = args.get("buyer_target_usd")
    if anchor is None and role == "buyer" and target is not None and target < limit:
        anchor = target
    if anchor is None:
        if offer == limit:
            offer = max(1, limit - qn.MIN_STEP_USD) if role == "buyer" else limit + qn.MIN_STEP_USD
        return action, offer
    distance = abs(limit - anchor)
    reach = distance // 2
    counter = args["current_ask_usd"] if role == "buyer" else args["current_bid_usd"]
    if distance == 1 and counter == limit + inward == args.get("counterparty_previous_offer_usd"):
        reach = 1
    return action, min(offer, anchor + reach) if role == "buyer" else max(offer, anchor - reach)


@functools.lru_cache(maxsize=None)
def pace_space(limit: int) -> Tuple[ConcessionPace, ...]:
    """Every pace concession_pace() can give an agent with this limit."""
    low, high = qn.PACE_SHARE_PCT
    widest = max(qn.PACE_MARGIN_MIN_USD, round(qn.PACE_MARGIN_SHARE * limit))
    return tuple(ConcessionPace(share, margin) for share in range(low, high + 1) for margin in range(1, widest + 1))


# rule -> (the guard generate_turn runs, the paces the attacker has to try for a limit)
RULES: Dict[str, Tuple[Callable[..., Tuple[str, int]], Callable[[int], Tuple[Any, ...]]]] = {
    "old": (old_rule_guard, lambda limit: (None,)),
    "current": (CURRENT_GUARD, pace_space),
}

# ── Scenarios ───────────────────────────────────────────────────────

def scenarios(count: int, seed: int) -> List[Dict[str, Any]]:
    """The overlapping scenarios of scripts/eval_negotiation.py (without overlap the agents never talk),
    then random overlapping ones: a list price of 60-400 USD, a reserve at 60-85% of it, a ceiling from 0
    USD to 20% of the list price above the reserve, a target 5-30% of the list price below the ceiling."""
    chosen = [
        {"id": f"eval-{sc['index']:02d}-{sc['id']}", "list_price": sc["expected_list_price_usd"],
         "reserve": sc["expected_reserve_usd"], "ceiling": sc["buyer_ceiling_usd"], "target": sc["buyer_target_usd"],
         "amount": sc["rgb_amount"]}
        for sc in build_scenarios(EVAL_RUNS, EVAL_SEED, load_strategy_presets())
        if sc["buyer_ceiling_usd"] >= sc["expected_reserve_usd"]
    ][:count]
    rng = random.Random(seed)
    while len(chosen) < count:
        list_price = rng.randint(60, 400)
        reserve = round(list_price * rng.uniform(0.6, 0.85))
        ceiling = reserve + rng.choice([0, 1, 2, 3, 5, 8, round(0.1 * list_price), round(0.2 * list_price)])
        target = max(1, ceiling - round(list_price * rng.uniform(0.05, 0.3)))
        if ceiling < list_price and 0 < target < ceiling:
            chosen.append({"id": f"random-{len(chosen) + 1:03d}", "list_price": list_price, "reserve": reserve,
                           "ceiling": ceiling, "target": target, "amount": 1_000_000})
    for sc in chosen:
        sc["session_id"] = f"sess_{sc['id']}"
    return chosen

# ── The product's turns ─────────────────────────────────────────────

def context(sc: Dict[str, Any], role: str, round_number: int, history: List[NegotiationTurn], limit: int) -> NegotiationContext:
    """The context run_negotiation_loop gives `role` after `history`, with `limit` as its secret limit."""
    bid = next((t.offer_usd for t in reversed(history) if t.speaker_wallet_id == BUYER), None)
    ask = next((t.offer_usd for t in reversed(history) if t.speaker_wallet_id == SELLER), sc["list_price"])
    me, other = (BUYER, SELLER) if role == "buyer" else (SELLER, BUYER)
    return NegotiationContext(
        session_id=sc["session_id"], round_number=round_number, role=role, wallet_id=me, wallet_label=LABELS[me],
        counterparty_wallet_id=other, counterparty_label=LABELS[other], asset_ticker="PEPE", asset_amount=sc["amount"],
        payment_ticker="USDT", secret_limit_usd=limit, buyer_target_usd=sc["target"] if role == "buyer" else None,
        current_bid_usd=bid, current_ask_usd=ask, your_previous_offer_usd=bid if role == "buyer" else ask,
        history=list(history), max_rounds=MAX_ROUNDS, list_price_usd=sc["list_price"],
    )


def guard_args(ctx: NegotiationContext, reply: Dict[str, Any]) -> Dict[str, Any]:
    """The arguments QvacNegotiator.generate_turn passes to rationality_guard for this reply, but the pace."""
    counterparty_offers = [t.offer_usd for t in ctx.history if t.speaker_wallet_id == ctx.counterparty_wallet_id]
    return dict(
        role=ctx.role, raw_action=str(reply.get("action", "OFFER")), raw_offer_usd=qn.coerce_offer_usd(reply.get("offer_usd")),
        secret_limit_usd=ctx.secret_limit_usd, current_bid_usd=ctx.current_bid_usd, current_ask_usd=ctx.current_ask_usd,
        your_previous_offer_usd=ctx.your_previous_offer_usd, round_number=ctx.round_number, max_rounds=ctx.max_rounds,
        buyer_target_usd=ctx.buyer_target_usd if ctx.role == "buyer" else None,
        counterparty_previous_offer_usd=counterparty_offers[-2] if len(counterparty_offers) > 1 else None,
    )


@contextlib.contextmanager
def product_patched(model: Callable[..., Dict[str, Any]], guard: Callable[..., Tuple[str, int]], pace_key: bytes) -> Iterator[None]:
    """generate_turn with `model` as the model's reply, `guard` as its rationality guard and a fixed pace
    key (backend.qvac_negotiator._PACE_KEY, random per process in the product); all restored on exit."""
    saved = qn.mock_negotiate, qn.rationality_guard, qn._PACE_KEY
    qn.mock_negotiate, qn.rationality_guard, qn._PACE_KEY = model, guard, pace_key
    try:
        yield
    finally:
        qn.mock_negotiate, qn.rationality_guard, qn._PACE_KEY = saved


def negotiate(sc: Dict[str, Any], model: Callable[..., Dict[str, Any]], rule: str,
              pace_key: bytes) -> Tuple[str, Optional[int], List[NegotiationTurn]]:
    """
    One negotiation on QvacNegotiator.generate_turn, with the turn order and stop rules of
    api_server.run_negotiation_loop: the buyer then the seller each round, a deal as soon as one side
    takes the other's price within its limit, a stop when the offers do not move for two rounds.
    Returns (outcome, agreed price, turns).
    """
    negotiator = QvacNegotiator()
    negotiator.use_mock = True  # the reply comes from `model`, never from QVAC
    history: List[NegotiationTurn] = []
    pairs: List[Tuple[int, int]] = []
    with product_patched(model, RULES[rule][0], pace_key):
        for round_number in range(1, MAX_ROUNDS + 1):
            ctx = context(sc, "buyer", round_number, history, sc["ceiling"])
            buyer = negotiator.generate_turn(ctx)
            history.append(buyer)
            ask = ctx.current_ask_usd
            if ask <= sc["ceiling"] and (buyer.action == "ACCEPT" or buyer.offer_usd >= ask):
                return "deal", ask, history
            ctx = context(sc, "seller", round_number, history, sc["reserve"])
            seller = negotiator.generate_turn(ctx)
            history.append(seller)
            bid = ctx.current_bid_usd
            if bid >= sc["reserve"] and (seller.action == "ACCEPT" or seller.offer_usd <= bid):
                return "deal", bid, history
            pairs.append((buyer.offer_usd, seller.offer_usd))
            if len(pairs) >= 3 and len(set(pairs[-3:])) == 1:
                return "stalled", None, history
    return "no_deal", None, history

# ── The attacker ────────────────────────────────────────────────────

def attacked_moves(role: str, turns: List[NegotiationTurn]) -> List[int]:
    """Indexes of the moves of `role` the attacker uses: those before the closing rounds, but an ACCEPT
    that closed the deal (an ACCEPT always does)."""
    me = BUYER if role == "buyer" else SELLER
    moves = [i for i, t in enumerate(turns) if t.speaker_wallet_id == me and t.round_number < CLOSING_ROUND]
    if moves and turns[moves[-1]].action == "ACCEPT":
        moves.pop()
    return moves


def candidate_limits(sc: Dict[str, Any], role: str) -> range:
    """The limits possible before any offer: a reserve is at most the list price (the backend refuses a
    higher one); a ceiling above twice the list price moves like one at twice the list price for both models."""
    return range(1, sc["list_price"] + 1) if role == "seller" else range(1, 2 * sc["list_price"] + 1)


def counterparty_allows(sc: Dict[str, Any], role: str, limit: int) -> bool:
    """Does `limit` fit what the counterparty knows besides the offers: its own limit, and that the two overlap?"""
    return limit <= sc["ceiling"] if role == "seller" else limit >= sc["reserve"]


def surviving_limits(sc: Dict[str, Any], model: Callable[..., Dict[str, Any]], rule: str, role: str,
                     turns: List[NegotiationTurn]) -> List[int]:
    """The candidate limits of `role` for which some pace makes the rule's guard publish exactly the
    target's attacked moves, given the public history before each of them."""
    guard, paces_for = RULES[rule]
    public = [t.model_copy(update={"private_thought": ""}) for t in turns]
    moves = attacked_moves(role, turns)
    survivors = []
    for limit in candidate_limits(sc, role):
        paces = paces_for(limit)
        for i in moves:
            # The reply and the guard's inputs do not depend on the pace: only the cap does.
            ctx = context(sc, role, turns[i].round_number, public[:i], limit)
            args = guard_args(ctx, model(ctx))
            published = (turns[i].action, turns[i].offer_usd)
            paces = [pace for pace in paces if guard(**args, pace=pace) == published]
            if not paces:
                break
        if paces:
            survivors.append(limit)
    return survivors

# ── Run, summary ────────────────────────────────────────────────────

def run(scenario_list: List[Dict[str, Any]], pace_key: bytes) -> List[Dict[str, Any]]:
    """Every scenario under both rules and both models, each side attacked: one record per negotiation."""
    records = []
    for rule in RULES:
        for model_name, model in MODELS.items():
            for sc in scenario_list:
                outcome, price, turns = negotiate(sc, model, rule, pace_key)
                record: Dict[str, Any] = {"rule": rule, "model": model_name, "scenario": sc, "outcome": outcome, "price": price}
                for role, limit in (("buyer", sc["ceiling"]), ("seller", sc["reserve"])):
                    from_offers = surviving_limits(sc, model, rule, role, turns)
                    if limit not in from_offers:
                        raise RuntimeError(f"replay bug: the true {role} limit of {sc['id']} ({rule}, {model_name}) did not survive")
                    moves = [turns[i] for i in attacked_moves(role, turns)]
                    record[role] = {
                        "limit": limit,
                        "from_offers": from_offers,
                        "by_counterparty": [c for c in from_offers if counterparty_allows(sc, role, c)],
                        "moves": [(t.round_number, t.action, t.offer_usd) for t in moves],
                        "offered_limit": any(t.action == "OFFER" and t.offer_usd == limit for t in moves),
                    }
                records.append(record)
    return records


def _overlap(record: Dict[str, Any]) -> str:
    return overlap_class(record["scenario"]["reserve"], record["scenario"]["ceiling"])


def summarize(records: List[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Per rule and model: the outcomes, and per side how often the limit was offered openly before the
    closing rounds (the guard does it only to close limits that nearly touch, the limit being the one
    price left) and, over the other negotiations, how often each attacker
    pinned it, with the counterparty's pins and the limits it has left (median) per overlap class.
    """
    summary: Dict[str, Any] = {}
    for rule in RULES:
        summary[rule] = {}
        for model_name in MODELS:
            rows = [r for r in records if r["rule"] == rule and r["model"] == model_name]
            entry: Dict[str, Any] = {
                "negotiations": len(rows),
                "outcomes": dict(sorted(Counter(r["outcome"] for r in rows).items())),
                "deals_within_both_limits": sum(r["outcome"] == "deal" and r["scenario"]["reserve"] <= r["price"] <= r["scenario"]["ceiling"]
                                                for r in rows),
            }
            for role in ("buyer", "seller"):
                kept = [r for r in rows if not r[role]["offered_limit"]]
                per_overlap = {}
                for overlap in OVERLAPS:
                    left = [len(r[role]["by_counterparty"]) for r in kept if _overlap(r) == overlap]
                    per_overlap[overlap] = {"limit_not_offered": len(left), "pinned": left.count(1),
                                            "limits_left_median": statistics.median(left) if left else None}
                entry[role] = {
                    "limit_offered_openly": len(rows) - len(kept),
                    "limit_not_offered": len(kept),
                    "pinned_from_offers": sum(len(r[role]["from_offers"]) == 1 for r in kept),
                    "pinned_by_counterparty": sum(len(r[role]["by_counterparty"]) == 1 for r in kept),
                    "by_counterparty_per_overlap": per_overlap,
                }
            summary[rule][model_name] = entry
    return summary


def wide_overlap_pins(records: List[Dict[str, Any]], rule: str) -> List[Dict[str, Any]]:
    """The limits the counterparty pinned under `rule` although the limits overlap widely and the limit was
    never offered, with the moves it used."""
    return [
        {"model": r["model"], "scenario": r["scenario"]["id"], "role": role, "limit_usd": r[role]["limit"],
         "list_price_usd": r["scenario"]["list_price"], "overlap_usd": r["scenario"]["ceiling"] - r["scenario"]["reserve"],
         "pinned_from_offers": len(r[role]["from_offers"]) == 1, "moves": r[role]["moves"]}
        for r in records if r["rule"] == rule for role in ("buyer", "seller")
        if not r[role]["offered_limit"] and len(r[role]["by_counterparty"]) == 1 and _overlap(r) == "wide"
    ]


def example(records: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The first buyer whose ceiling the old rule gave away from the offers alone, and the same negotiation today."""
    def side(rule: str, scenario_id: str) -> Dict[str, Any]:
        return next(r for r in records if r["rule"] == rule and r["model"] == "pushes_to_limit" and r["scenario"]["id"] == scenario_id)["buyer"]

    old = next((r for r in records if r["rule"] == "old" and r["model"] == "pushes_to_limit"
                and not r["buyer"]["offered_limit"] and len(r["buyer"]["from_offers"]) == 1), None)
    if old is None:
        return None
    sc, now = old["scenario"], side("current", old["scenario"]["id"])
    return {
        "model": "pushes_to_limit", "scenario": sc["id"], "list_price_usd": sc["list_price"], "buyer_target_usd": sc["target"],
        "buyer_ceiling_usd": sc["ceiling"],
        "old_rule": {"bids": [m[2] for m in old["buyer"]["moves"]], "ceilings_left": old["buyer"]["from_offers"]},
        "current_rule": {"bids": [m[2] for m in now["moves"]], "ceilings_left": now["from_offers"]},
    }


def _share(part: int, whole: int) -> str:
    return f"{part}/{whole} ({100 * part / whole:.0f}%)" if whole else "-"


def markdown(summary: Dict[str, Any], scenario_count: int, eval_count: int, seed: int, pace_key: str) -> str:
    """The table: limits pinned before the closing rounds, over the negotiations where the limit was not offered openly."""
    lines = [
        f"Offer-channel attack: {scenario_count} scenarios ({eval_count} from scripts/eval_negotiation.py, "
        f"{scenario_count - eval_count} random, seed {seed}), pace key {pace_key!r}. Exact limits pinned before the "
        "closing rounds, over the negotiations where the limit was not offered openly:",
        "",
        "| Model | Secret limit | Old rule (public halving) | Current rule (secret pace) "
        "| Current rule, by the counterparty | Offered openly to close, old / current |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    for model_name in MODELS:
        old, now = summary["old"][model_name], summary["current"][model_name]
        for role, label in (("buyer", "buyer's ceiling"), ("seller", "seller's reserve")):
            before, today = old[role], now[role]
            wide = today["by_counterparty_per_overlap"]["wide"]
            lines.append(
                f"| {MODEL_LABELS[model_name]} | {label} | {_share(before['pinned_from_offers'], before['limit_not_offered'])} "
                f"| {_share(today['pinned_from_offers'], today['limit_not_offered'])} "
                f"| {_share(today['pinned_by_counterparty'], today['limit_not_offered'])}; wide overlaps {wide['pinned']}/{wide['limit_not_offered']} "
                f"| {before['limit_offered_openly']} / {today['limit_offered_openly']} |")
    lines += [
        "",
        "The attacker knows every rule, the model's behaviour, every offer and, against the buyer, its target; the "
        "counterparty also knows its own limit, so that the two overlap. Wide overlaps: more than 5 USD.",
    ]
    for model_name in MODELS:
        old, now = summary["old"][model_name], summary["current"][model_name]
        left = {role: " / ".join("-" if group["limits_left_median"] is None else f"{group['limits_left_median']:g}"
                                 for group in now[role]["by_counterparty_per_overlap"].values()) for role in ("buyer", "seller")}
        lines.append(
            f"- {MODEL_LABELS[model_name]}: deals within both limits {old['deals_within_both_limits']}/{old['negotiations']} (old rule) "
            f"and {now['deals_within_both_limits']}/{now['negotiations']} (current); limits left to the counterparty today, "
            f"median for touching / narrow / wide overlaps: ceiling {left['buyer']}, reserve {left['seller']}.")
    return "\n".join(lines)


def _git(*cmd: str) -> str:
    try:
        return subprocess.run(["git", *cmd], capture_output=True, text=True, timeout=10, cwd=REPO_ROOT).stdout.strip()
    except Exception:
        return ""


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--scenarios", type=int, default=DEFAULT_SCENARIOS, help=f"number of scenarios (default {DEFAULT_SCENARIOS})")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help=f"seed of the random scenarios (default {DEFAULT_SEED})")
    parser.add_argument("--pace-key", default=DEFAULT_PACE_KEY, help="key of the secret paces in this run (default %(default)r)")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help=f"results JSON (default {DEFAULT_OUT.relative_to(REPO_ROOT)})")
    args = parser.parse_args()
    if args.scenarios < 1:
        parser.error("--scenarios must be at least 1")
    # The guards log every correction, and the leak guard warns on each message it rewrites.
    logging.getLogger("mwm").setLevel(logging.ERROR)

    started = time.perf_counter()
    scenario_list = scenarios(args.scenarios, args.seed)
    eval_count = sum(sc["id"].startswith("eval-") for sc in scenario_list)
    records = run(scenario_list, args.pace_key.encode())
    summary = summarize(records)
    runtime = round(time.perf_counter() - started, 1)
    table = markdown(summary, len(scenario_list), eval_count, args.seed, args.pace_key)
    result = {
        "meta": {
            "script": "evals/offer_channel_attack.py",
            "command": " ".join([".venv/bin/python", "evals/offer_channel_attack.py", *sys.argv[1:]]),
            "scenarios": len(scenario_list), "eval_scenarios": eval_count, "seed": args.seed, "pace_key": args.pace_key,
            "max_rounds": MAX_ROUNDS, "closing_rounds": [CLOSING_ROUND, MAX_ROUNDS],
            "pace_ranges": {"share_pct": list(qn.PACE_SHARE_PCT),
                            "margin_usd": f"1 to max({qn.PACE_MARGIN_MIN_USD}, round({qn.PACE_MARGIN_SHARE} x limit))"},
            "candidate_limits": {"buyer": "1 to 2 x list price", "seller": "1 to list price"},
            "attacker_knows": ["the guard's code", "the pace ranges", "the model's reply as a function of the limit",
                               "the list price", "the round count", "every public offer",
                               "the buyer's target valuation (against the buyer)"],
            "counterparty_also_knows": ["its own limit", "that the two limits overlap (the overlap check let the talks start)"],
            "pinned": "a single candidate limit reproduces every move the target published before the closing "
                      "rounds (but an ACCEPT that closed the deal), for some pace; counted over the negotiations "
                      "where the target did not offer its limit openly before the closing rounds",
            "old_rule": "today's guard with the cap it had before the secret pace (old_rule_guard)",
            "overlaps": "touching: ceiling = reserve; narrow: 1-5 USD apart; wide: more",
            "not_exercised": ["QVAC (the replies come from two simulated models)", "several sessions against the same limit"],
            "git_commit": _git("rev-parse", "HEAD"),
            "code_sha256_12": {"backend/qvac_negotiator.py": hashlib.sha256((REPO_ROOT / "backend" / "qvac_negotiator.py").read_bytes()).hexdigest()[:12]},
            "runtime_s": runtime,
        },
        "summary": summary,
        "wide_overlap_pins_current_rule": wide_overlap_pins(records, "current"),
        "example": example(records),
        "summary_markdown": table,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + "\n")
    print(table)
    print(f"\nruntime {runtime} s; results: {args.out}")


if __name__ == "__main__":
    main()
