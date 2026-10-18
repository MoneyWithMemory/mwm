"""
MwM - Your AI (the local assistant behind "Ask your AI")
Answers the owner's questions about their own account from the same sources as the Advisor: their
WalletState, their sessions as they see them, and the market. Never the Vault, never a counterparty's
limits. Code computes every fact; the local QVAC model only words the answer, and the Advisor's
numeric and word guard checks every sentence it writes against those facts.

- Presets: "analyze" (the Advisor's signals), "week" (what moved in the last WEEK_DAYS days),
  "vault" (idle funds, with a Move to Vault action when there are some).
- Free text (QUESTION_MAX characters): one model call whose system prompt holds only the computed
  facts; a question about something else gets OFF_TOPIC without asking the model.
- The rules answer, with a short note saying why, whenever the model is busy with a negotiation
  (negotiations have priority on the single local model), does not answer in time, or writes
  something the guard rejects. Model answers are cached per (wallet, question, facts) for CACHE_TTL_S.
"""

import hashlib
import json
import logging
import re
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

from backend import advisor
from backend.config import settings

logger = logging.getLogger("mwm.assistant")

PRESETS = ("analyze", "week", "vault")
QUESTION_MAX = 280
WEEK_DAYS = 7
MAX_FACTS = 4
# A model answer holds the single local model for at most ASK_TIMEOUT_S.
ASK_TIMEOUT_S = 11
ANSWER_MAX = 220
CACHE_TTL_S = 600

MOVE_TO_VAULT = "move_to_vault"
OFF_TOPIC = "I only know your account. Try: Analyze my account."
NOTHING_THIS_WEEK = "Nothing moved in the last 7 days."
NO_IDLE_FUNDS = "No need right now: nothing large sits idle in your wallet."
BUSY_NOTE = "The local model is busy negotiating, here is the quick version."
ANSWERING_NOTE = "The local model is answering another question, here is the quick version."
DOWN_NOTE = "The local model did not answer in time, here is the quick version."
REJECTED_NOTE = "The local model's answer did not match your numbers, here is the quick version."

ASK_SYSTEM_PROMPT = """You are the private assistant of a wallet app, running on its owner's device.
Answer the owner's question in at most 2 short, plain sentences (at most 35 words), for an owner who is not technical.
Rules:
- Use only the facts below. Copy every number exactly as written and add no other number.
- If the facts do not answer the question, say so in one sentence.
- Give no advice that is not already in the facts. No greeting, no list, no markdown.
- Speak to the owner as "you"; their trading agent is "your agent".
Facts:
{facts}
Reply with JSON only: {{"answer": "<your answer>"}}"""

# A question is about the account when it names one of these.
_ON_TOPIC = re.compile(
    r"\b(account|wallet|balances?|money|funds?|cash|vault|deals?|trad\w*|swap\w*|buy\w*|bought|sell\w*|sold|"
    r"prices?|paid|pay\w*|spen[dt]\w*|sav\w*|idle|week\w*|today|yesterday|recent\w*|lately|happened|agents?|"
    r"negotiat\w*|assets?|tokens?|coins?|portfolio|risk\w*|strateg\w*|hold\w*|worth|value|usdt|pepe|btc|"
    r"bitcoin|dollars?|analy[sz]\w*|summar\w*|overview|doing|mov\w*|safe\w*|earn\w*|profit\w*|loss\w*|lost)\b",
    re.IGNORECASE,
)
_ABOUT_VAULT = re.compile(r"\b(vault|idle|safe\w*|mov\w*|protect\w*)\b", re.IGNORECASE)
_ABOUT_WEEK = re.compile(r"\b(week\w*|today|yesterday|recent\w*|lately|happened|last \w+ days)\b", re.IGNORECASE)

_cache: Dict[Tuple[str, str, str], Tuple[str, float]] = {}
# One answer at a time on the single local model.
_model_lock = threading.Lock()
_cache_lock = threading.Lock()


# ── Facts ───────────────────────────────────────────────────────────

def _join(clauses: List[str]) -> str:
    return clauses[0] if len(clauses) == 1 else ", ".join(clauses[:-1]) + " and " + clauses[-1]


def week_signals(
    wallet_state: Dict[str, Any],
    sessions: List[Dict[str, Any]],
    market: Dict[str, Any],
    now: float,
) -> List[Dict[str, Any]]:
    """
    What moved in the last WEEK_DAYS days, from the wallet's own activity and sessions: settled swaps
    per asset pair, moves to and from the Vault (as the wallet recorded them), RGB receives (BTC only
    funds the network fees), and the negotiations held.
    """
    since = now - WEEK_DAYS * 86_400
    pegged = {a["asset_id"] for a in market.get("assets", []) if a.get("source") == "fixed_peg"}
    recent = [item for item in wallet_state.get("activity", []) if item.get("t", 0) >= since]

    # A swap is two items (out and in) sharing a session.
    swaps: Dict[str, Dict[str, Dict[str, Any]]] = {}
    for item in recent:
        if item.get("kind") == "swap":
            swaps.setdefault(item.get("session_id") or item.get("txid") or item.get("id"), {})[item["direction"]] = item
    pairs: Dict[Tuple[str, str], Dict[str, Any]] = {}
    for legs in swaps.values():
        if "in" not in legs or "out" not in legs:
            continue
        out, got = legs["out"], legs["in"]
        pair = pairs.setdefault((out["asset"]["asset_id"], got["asset"]["asset_id"]), {"out": out["asset"], "in": got["asset"], "paid": 0, "got": 0, "deals": 0})
        pair["paid"] += int(out["amount"])
        pair["got"] += int(got["amount"])
        pair["deals"] += 1

    signals = []
    for pair in pairs.values():
        paid = advisor._units(pair["paid"], int(pair["out"].get("precision", 0)))
        got = advisor._units(pair["got"], int(pair["in"].get("precision", 0)))
        paid_text, got_text = f"{advisor._fmt(paid)} {pair['out']['ticker']}", f"{advisor._fmt(got)} {pair['in']['ticker']}"
        if pair["out"]["asset_id"] in pegged:
            title = f"Bought {got_text} for {paid_text}"
        elif pair["in"]["asset_id"] in pegged:
            title = f"Sold {paid_text} for {got_text}"
        else:
            title = f"Swapped {paid_text} for {got_text}"
        deals = pair["deals"]
        signals.append(advisor._signal(
            "activity", f"swap:{pair['out']['asset_id']}:{pair['in']['asset_id']}", "info", title,
            f"{deals} deal{'' if deals == 1 else 's'} settled in the last {WEEK_DAYS} days.",
            {"paid_amount": paid, "received_amount": got, "deals": deals, "window_days": WEEK_DAYS},
        ))

    moved: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    for item in recent:
        if item["asset"]["asset_id"] == "btc":
            continue
        if item.get("kind") in ("vault", "receive") and (item["kind"] == "vault" or item.get("direction") == "in"):
            entry = moved.setdefault((item["kind"], item["direction"], item["asset"]["asset_id"]), {"asset": item["asset"], "amount": 0, "count": 0})
            entry["amount"] += int(item["amount"])
            entry["count"] += 1
    for (kind, direction, asset_id), entry in moved.items():
        amount = advisor._units(entry["amount"], int(entry["asset"].get("precision", 0)))
        text = f"{advisor._fmt(amount)} {entry['asset']['ticker']}"
        count = entry["count"]
        if kind == "vault" and direction == "out":
            title, detail = f"Moved {text} to your Vault", "Your agents can't touch it there."
        elif kind == "vault":
            title, detail = f"Moved {text} back from your Vault", "Your agents can trade with it again."
        else:
            title, detail = f"Received {text}", f"{count} transfer{'' if count == 1 else 's'} in."
        signals.append(advisor._signal(
            "activity", f"{kind}_{direction}:{asset_id}", "info", title, detail,
            {"amount": amount, "count": count, "window_days": WEEK_DAYS},
        ))

    held = [s for s in sessions if (s.get("updated_at") or s.get("created_at") or 0) >= since]
    if held:
        deals = sum(1 for s in held if s.get("agreed_price_usd") is not None)
        signals.append(advisor._signal(
            "activity", "negotiations", "info",
            f"Negotiated {len(held)} time{'' if len(held) == 1 else 's'}",
            f"{deals} ended in a deal." if deals else "None ended in a deal yet.",
            {"negotiations": len(held), "deals": deals, "window_days": WEEK_DAYS},
        ))
    return signals[:MAX_FACTS]


def week_text(signals: List[Dict[str, Any]]) -> str:
    """The rules answer for the week: "In the last 7 days you bought ... and moved ... to your Vault." """
    if not signals:
        return NOTHING_THIS_WEEK
    clauses = [s["title"][0].lower() + s["title"][1:] for s in signals]
    return f"In the last {WEEK_DAYS} days you {_join(clauses)}."


def vault_text(signals: List[Dict[str, Any]]) -> str:
    """The rules answer to "Should I move funds to my Vault?", from the idle-funds signals."""
    if not signals:
        return NO_IDLE_FUNDS
    top = signals[0]
    return f"Yes, part of it. {top['title']}, {top['numbers']['share_pct']}% of your wallet: your Vault keeps it where agents can't touch it."


# ── Model ───────────────────────────────────────────────────────────

def _facts(signals: List[Dict[str, Any]]) -> str:
    return "\n".join(f"- {s['title']}. {s['detail']}" for s in signals) or "- Nothing to report."


def _cached(key: Tuple[str, str, str], now: float) -> Optional[str]:
    with _cache_lock:
        entry = _cache.get(key)
        return entry[0] if entry and entry[1] > now else None


def _remember(key: Tuple[str, str, str], text: str, now: float) -> None:
    with _cache_lock:
        for old in [k for k, (_, until) in _cache.items() if until <= now]:
            del _cache[old]
        _cache[key] = (text, now + CACHE_TTL_S)


def _model_answer(
    wallet_id: str,
    topic: str,
    signals: List[Dict[str, Any]],
    question: Optional[str],
    model_busy: Callable[[], bool],
) -> Tuple[Optional[str], Optional[str]]:
    """(text, None) from the local model, or (None, note) saying why the rules answer is shown instead."""
    now = time.time()
    digest = hashlib.sha256(json.dumps(signals, sort_keys=True).encode()).hexdigest()
    key = (wallet_id, topic if question is None else f"q:{question.lower()}", digest)
    cached = _cached(key, now)
    if cached:
        return cached, None
    if model_busy():
        return None, BUSY_NOTE
    if not _model_lock.acquire(blocking=False):
        return None, ANSWERING_NOTE
    try:
        if question is None:
            text = advisor._ask_qvac(signals, timeout=ASK_TIMEOUT_S)
            problem = advisor._rejection(text, signals)
        else:
            system = ASK_SYSTEM_PROMPT.format(facts=_facts(signals))
            text = advisor._ask_qvac(signals, system=system, user=question, key="answer", timeout=ASK_TIMEOUT_S)
            problem = advisor._rejection(text, signals, max_len=ANSWER_MAX)
    except Exception as exc:
        logger.warning(f"Assistant call failed ({exc}); using the rules answer.")
        return None, DOWN_NOTE
    finally:
        _model_lock.release()
    if problem:
        logger.info(f"Assistant discarded the model answer ({problem}): {text!r}")
        return None, REJECTED_NOTE
    _remember(key, text, time.time())
    return text, None


# ── Ask ─────────────────────────────────────────────────────────────

def _topic(question: str) -> str:
    if _ABOUT_VAULT.search(question):
        return "vault"
    if _ABOUT_WEEK.search(question):
        return "week"
    return "analyze"


def ask(
    wallet_id: str,
    wallet_state: Dict[str, Any],
    sessions: List[Dict[str, Any]],
    market: Dict[str, Any],
    preset: Optional[str] = None,
    question: Optional[str] = None,
    model_busy: Callable[[], bool] = lambda: False,
) -> Dict[str, Any]:
    """
    The AskView for POST /api/wallets/{wallet_id}/ask: a preset, else a free question. `model_busy`
    says whether a negotiation is running or queued; it is asked right before any model call.
    """
    question = " ".join((question or "").split())[:QUESTION_MAX] or None
    if preset is None and (question is None or not _ON_TOPIC.search(question)):
        return {"answer": OFF_TOPIC, "generated_by": "rules", "signals": [], "action": None, "note": None}

    now = time.time()
    advice = advisor.compute_signals(wallet_state, sessions, market, now)
    week = week_signals(wallet_state, sessions, market, now)
    topic = preset or _topic(question or "")
    idle = [s for s in advice if s["kind"] == "idle_funds"]
    shown = {"analyze": advice, "week": week, "vault": idle}[topic]
    rules = {"analyze": advisor.template_summary, "week": week_text, "vault": vault_text}[topic](shown)
    action = MOVE_TO_VAULT if idle and topic in ("analyze", "vault") else None

    # A free question sees every fact; a preset only its own. Nothing to say needs no model.
    facts = shown if question is None else advice + [s for s in week if s not in advice]
    text, note = None, None
    if facts and not settings.QVAC_MOCK:
        text, note = _model_answer(wallet_id, topic, facts, question, model_busy)
    return {
        "answer": text or rules,
        "generated_by": "qvac" if text else "rules",
        "signals": shown,
        "action": action,
        "note": note,
    }
