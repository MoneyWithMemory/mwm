"""
MwM - Advisor (the wallet's internal memory)
Reads only what the owner already sees: their WalletState, their sessions as they see them (with the
strategy they gave their own agent in each), and the market. Code computes every number
(deterministic signals); the local QVAC model only phrases them as a sentence, so private financial
data never leaves the device.

- compute_signals(): at most MAX_SIGNALS observations, most severe first.
- phrase(): one QVAC call for a one-sentence summary. A summary that quotes a number, an asset, a
  strategy or an action that is not in the signals, or puts money outside the Vault out of the
  agents' reach, is discarded for the rules template, and so are mock mode, errors and timeouts.
- advise(): the signals at once, with the cached summary for them, else the rules template while a
  background worker phrases them: one call at a time, and never while a negotiation is running or
  queued (negotiations have priority on the single local model). Summaries are cached per
  (wallet_id, signals) for CACHE_TTL_S.
"""

import hashlib
import json
import logging
import math
import re
import threading
import time
import unicodedata
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Tuple

import requests

from backend.config import settings
from backend.qvac_negotiator import parse_llm_json_response

logger = logging.getLogger("mwm.advisor")

MAX_SIGNALS = 4
TITLE_MAX = 40
DETAIL_MAX = 90
SEVERITY_RANK = {"warning": 0, "tip": 1, "info": 2}

# A wallet worth less than this gets no allocation tips (idle funds, concentration).
MIN_WALLET_USD = 100
# Idle funds: an RGB balance worth at least IDLE_MIN_SHARE of the wallet's value, when the trades of
# the last IDLE_WINDOW_DAYS sent out at most IDLE_MAX_SPENT_SHARE of it (the balance plus what they sent).
IDLE_WINDOW_DAYS = 7
IDLE_MIN_SHARE = 0.4
IDLE_MAX_SPENT_SHARE = 0.25
# Concentration: one asset whose price can move holding at least this share of the wallet's value.
# BTC (it pays the network fees) and USD-pegged assets are left out.
CONCENTRATION_SHARE = 0.7
# Pace: how the owner's strategy played out, once they have this many finished negotiations in a role.
PACE_MIN_NEGOTIATIONS = 2

# A phrasing holds the single local model for at most PHRASE_TIMEOUT_S. It is kept for CACHE_TTL_S
# (and still shown while it is phrased again after that); a failed or discarded one is tried again
# after RETRY_AFTER_S, then twice as late each time it fails again, up to CACHE_TTL_S.
PHRASE_TIMEOUT_S = 9
SUMMARY_MAX = 140
CACHE_TTL_S = 600
RETRY_AFTER_S = 60

NO_SIGNALS_SUMMARY = "Nothing needs your attention right now."

PHRASE_SYSTEM_PROMPT = """You write the summary line of a private wallet advisor that runs on its owner's device.
Sum up the first one or two observations in one short, plain sentence of at most 20 words, for an owner who is not technical.
Rules:
- Use only the facts in the observations. Copy every number exactly as written and add no other number.
- Give no advice that is not already in the observations. No greeting, no list, no markdown.
- Speak to the owner as "you"; their trading agent is "your agent".
Reply with JSON only: {"summary": "<your sentence>"}"""

_DIGITS = re.compile(r"\d+(?:,\d{3})*(?:\.\d+)?")
_SCALE = re.compile(r"\s?(thousand|million|billion|bn|k|m)\b", re.IGNORECASE)
_SCALES = {"thousand": 1e3, "k": 1e3, "million": 1e6, "m": 1e6, "billion": 1e9, "bn": 1e9}
# "one" is left out: it is mostly a pronoun ("one of your deals").
_NUMBER_WORDS = {
    "zero": 0, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "dozen": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40,
    "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90, "hundred": 100, "thousand": 1e3,
    "million": 1e6, "billion": 1e9,
}
_NUMBER_WORD = re.compile(r"\b(" + "|".join(_NUMBER_WORDS) + r")\b", re.IGNORECASE)
# Words a summary may use only when a signal's title or detail says them: amounts the numeric guard
# cannot check, totals and directions that change a fact, actions and urgency the advisor never
# suggests, the strategies and the Vault.
_SIGNAL_ONLY_WORDS = re.compile(
    r"\b(half|halves|thirds?|quarters?|dozens|hundreds|thousands|millions|billions|double[ds]?|twice|triple[ds]?|"
    r"all|every|everything|more than|above|higher|overpaid|buy|sell|withdraw|invest|convert|lose|losing|loss|lost|"
    r"today|immediately|urgent(?:ly)?|vault|strict|balanced|flexible)\b",
    re.IGNORECASE,
)
# Tickers and other acronyms (BTC, PEPE, AI) must come from the signals too.
_ACRONYM = re.compile(r"\b[A-Z][A-Z0-9]+\b")
# The summary speaks to the owner, never as itself.
_FIRST_PERSON = re.compile(r"\b(?:I|[Mm]e|[Mm]y|[Ww]e|[Uu]s|[Oo]ur)\b")
# Out of the agents' reach is true of the Vault only: a summary must name the Vault just before saying it.
_OUT_OF_REACH = re.compile(
    r"\b(?:can['’]?t|cannot|can not|won['’]?t|unable to)\s+(?:\w+\s+)?(?:access|touch|reach|use|spend|move)\b"
    r"|\bout of (?:\S+\s+){0,2}reach\b",
    re.IGNORECASE,
)
_MARKUP = re.compile(r"[<>{}\[\]*#`_|]")
_SENTENCE_END = re.compile(r"[.!?](?=\s|$)")


# ── Formatting ──────────────────────────────────────────────────────

def _round(value: float) -> int:
    """Half up, like Math.round in the frontend mock."""
    return int(math.floor(value + 0.5))


def _units(amount: int, precision: int) -> float:
    """Atomic units to display units: a whole number when it is one, else 2 decimals."""
    value = amount / 10 ** precision
    return int(value) if float(value).is_integer() else round(value, 2)


def _fmt(value: float) -> str:
    """9754 -> '9,754'; 1234.5 -> '1,234.5'."""
    if float(value).is_integer():
        return f"{int(value):,}"
    return f"{value:,.2f}".rstrip("0").rstrip(".")


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _signal(kind: str, key: str, severity: str, title: str, detail: str, numbers: Dict[str, float]) -> Dict[str, Any]:
    return {
        "id": f"{kind}:{key}",
        "kind": kind,
        "severity": severity,
        "title": _clip(title, TITLE_MAX),
        "detail": _clip(detail, DETAIL_MAX),
        "numbers": numbers,
    }


# ── Signals ─────────────────────────────────────────────────────────

def _savings(sessions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Settled deals against the desk's public list price, one signal per role (never a secret limit)."""
    signals = []
    for role in ("buyer", "seller"):
        deals = [
            s for s in sessions
            if s.get("my_role") == role and s.get("state") == "SETTLED"
            and s.get("agreed_price_usd") is not None and (s.get("list_price_usd") or 0) > 0
        ]
        if not deals:
            continue
        paid = sum(int(s["agreed_price_usd"]) for s in deals)
        asks = sum(int(s["list_price_usd"]) for s in deals)
        pct = max(_round((asks - paid) / asks * 100), 0)
        buyer = role == "buyer"
        if pct > 0:
            title = f"Paid {pct}% below the list price" if buyer else f"Sold {pct}% below your asking price"
        else:
            title = "Paid the full list price" if buyer else "Sold at your asking price"
        numbers: Dict[str, float] = {
            "paid_usd" if buyer else "received_usd": paid,
            "ask_usd": asks,
            "saved_usd" if buyer else "below_ask_usd": max(asks - paid, 0),
            "pct_below": pct,
            "deals": len(deals),
        }
        if len(deals) == 1:
            asset = deals[0]["asset"]
            amount = _units(int(deals[0]["rgb_amount"]), int(asset.get("precision", 0)))
            numbers["amount"] = amount
            detail = f"${paid:,} for {_fmt(amount)} {asset['ticker']}, listed at ${asks:,}."
        else:
            detail = f"${paid:,} for ${asks:,} listed, over {len(deals)} {'buys' if buyer else 'sales'}."
        signals.append(_signal("negotiation_savings", role, "info", title, detail, numbers))
    return signals


def _holdings(wallet_state: Dict[str, Any], market: Dict[str, Any]) -> List[Tuple[Dict[str, Any], Optional[float]]]:
    """Each balance with its USD value, None while its asset has no price (e.g. PEPE before a trade)."""
    prices = {a["asset_id"]: a.get("price_usd") for a in market.get("assets", [])}
    sats_per_usd = market.get("sats_per_usd") or settings.SATS_PER_USD
    holdings = []
    for asset in wallet_state.get("assets", []):
        if asset["asset_id"] == "btc":
            value: Optional[float] = asset["amount"] / sats_per_usd
        else:
            price = prices.get(asset["asset_id"])
            value = None if price is None else asset["amount"] / 10 ** asset["precision"] * price
        holdings.append((asset, value))
    return holdings


def _idle_funds(wallet_state: Dict[str, Any], holdings, total_usd: float, now: float) -> List[Dict[str, Any]]:
    """
    A large RGB balance that trades barely used lately: a Vault tip. The amount and the share are the
    balance's own, as the wallet's Assets and Allocation show them.
    """
    since = now - IDLE_WINDOW_DAYS * 86_400
    signals = []
    for asset, value in holdings:
        if asset["asset_id"] == "btc" or not value or asset["amount"] <= 0:
            continue
        spent = sum(
            int(item["amount"]) for item in wallet_state.get("activity", [])
            if item.get("kind") == "swap" and item.get("direction") == "out"
            and item["asset"]["asset_id"] == asset["asset_id"] and item["t"] >= since
        )
        share = value / total_usd
        if share < IDLE_MIN_SHARE or spent > IDLE_MAX_SPENT_SHARE * (asset["amount"] + spent):
            continue
        amount = _units(asset["amount"], asset["precision"])
        share_pct = _round(share * 100)
        signals.append(_signal(
            "idle_funds", asset["asset_id"], "tip",
            f"{_fmt(amount)} {asset['ticker']} sits idle",
            f"{share_pct}% of your wallet. Move part to your Vault, where agents can't touch it.",
            {
                "idle_amount": amount,
                "share_pct": share_pct,
                "spent_amount": _units(spent, asset["precision"]),
                "window_days": IDLE_WINDOW_DAYS,
            },
        ))
    return signals


def _concentration(holdings, total_usd: float, pegged: set) -> List[Dict[str, Any]]:
    signals = []
    for asset, value in holdings:
        if asset["asset_id"] == "btc" or asset["asset_id"] in pegged or not value:
            continue
        share = value / total_usd
        if share < CONCENTRATION_SHARE:
            continue
        share_pct = _round(share * 100)
        signals.append(_signal(
            "concentration", asset["asset_id"], "warning",
            f"{share_pct}% of your wallet is {asset['ticker']}",
            "If its price drops, most of your wallet's value drops with it.",
            {"share_pct": share_pct, "value_usd": _round(value)},
        ))
    return signals


def _strategy_label(prompt: str) -> str:
    """The owner's strategy preset (the frontend's Strict / Balanced / Flexible), else their own words."""
    text = (prompt or "").strip()
    if not text:
        return "Balanced"
    for preset in ("Strict", "Flexible"):
        if text.startswith(f"{preset}:"):
            return preset
    return "Your own"


def _pace(sessions: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """
    Deals and no-deals of the owner's finished negotiations in each role, with the strategy the owner
    gave their agent in them (`my_ai_prompt`, fixed when each session started). Sessions blocked
    before the agents spoke (trust gate, no overlap) and talks cancelled before an agreement say
    nothing about the strategy.
    """
    signals = []
    for role in ("buyer", "seller"):
        mine = [s for s in sessions if s.get("my_role") == role]
        deals = [s for s in mine if s.get("agreed_price_usd") is not None]
        no_deals = [s for s in mine if s.get("state") == "BLOCKED_BY_GATE" and s.get("rounds") and s.get("agreed_price_usd") is None]
        talks = len(deals) + len(no_deals)
        if talks < PACE_MIN_NEGOTIATIONS:
            continue
        buyer = role == "buyer"
        used = {_strategy_label(s.get("my_ai_prompt", "")) for s in deals + no_deals}
        # A strategy is named only when every negotiation counted here ran with it.
        context = f"{next(iter(used))} {'buying' if buyer else 'selling'} strategy" if len(used) == 1 else f"As a {role}"
        numbers: Dict[str, float] = {"negotiations": talks, "deals": len(deals), "no_deals": len(no_deals)}
        # A deal is an agreement: it may still wait for signatures, or have been cancelled after it.
        if deals:
            title = f"Agreed in {len(deals)} of {talks} negotiations"
            numbers["avg_rounds"] = _round(sum(len(s.get("rounds") or []) for s in deals) / len(deals))
        else:
            title = f"No deal in {talks} negotiations"
        severity = "tip" if len(no_deals) > len(deals) else "info"
        if severity == "tip":
            detail = f"{context}: {len(no_deals)} ended with no deal."
            if "Flexible" not in used:
                detail += " Flexible may close more."
        else:
            rounds = numbers["avg_rounds"]
            detail = f"{context}, about {rounds} round{'' if rounds == 1 else 's'} per deal."
        signals.append(_signal("pace", role, severity, title, detail, numbers))
    return signals


def compute_signals(
    wallet_state: Dict[str, Any],
    sessions: List[Dict[str, Any]],
    market: Dict[str, Any],
    now: float,
) -> List[Dict[str, Any]]:
    """
    Observations from the owner's own WalletState, their sessions as they see them (SessionView, which
    never carries the counterparty's limits, plus `my_ai_prompt`: the owner's own strategy in that
    session) and the market, most severe first.
    """
    holdings = _holdings(wallet_state, market)
    total_usd = sum(value for _, value in holdings if value)
    pegged = {a["asset_id"] for a in market.get("assets", []) if a.get("source") == "fixed_peg"}
    signals = _savings(sessions)
    if total_usd >= MIN_WALLET_USD:
        signals += _idle_funds(wallet_state, holdings, total_usd, now) + _concentration(holdings, total_usd, pegged)
    signals += _pace(sessions)
    signals.sort(key=lambda s: SEVERITY_RANK[s["severity"]])
    return signals[:MAX_SIGNALS]


# ── Summary ─────────────────────────────────────────────────────────

def _clause(signal: Dict[str, Any]) -> str:
    """A signal's title as part of a sentence: "your agent paid 18% below the list price"."""
    title = signal["title"]
    if signal["kind"] in ("idle_funds", "concentration"):
        return title
    lowered = title[0].lower() + title[1:]
    return f"your agent made {lowered}" if title.startswith("No ") else f"your agent {lowered}"


def template_summary(signals: List[Dict[str, Any]]) -> str:
    """The rules summary: the top one or two signals in one sentence."""
    if not signals:
        return NO_SIGNALS_SUMMARY
    clauses = [_clause(s) for s in signals[:2]]
    subject = "your agent "
    if len(clauses) == 2 and all(c.startswith(subject) for c in clauses):
        clauses[1] = clauses[1][len(subject):]
    text = ", and ".join(clauses)
    return text[0].upper() + text[1:] + "."


def invented_numbers(text: str, signals: List[Dict[str, Any]]) -> List[str]:
    """
    Every number in `text` (digits with a sign, $, %, thousands separators or a scale like "1.5
    million", and number words) that is not one of the signals' numbers or their count. Zero never
    is: no signal shows one.
    """
    allowed = ({float(v) for s in signals for v in s["numbers"].values()} | {float(len(signals))}) - {0.0}

    def known(value: float) -> bool:
        return any(math.isclose(value, a, rel_tol=1e-9, abs_tol=1e-9) for a in allowed)

    invented: List[str] = []
    words_only = text
    for match in _DIGITS.finditer(text):
        start, end = match.start(), match.end()
        value = float(match.group(0).replace(",", ""))
        if start and text[start - 1] in "-−–":
            start, value = start - 1, -value
        scale = _SCALE.match(text, end)
        if scale:
            value *= _SCALES[scale.group(1).lower()]
            end = scale.end()
        if not known(value):
            invented.append(text[start:end].strip())
        words_only = words_only[:start] + " " * (end - start) + words_only[end:]
    for match in _NUMBER_WORD.finditer(words_only):
        if not known(_NUMBER_WORDS[match.group(1).lower()]):
            invented.append(match.group(1))
    return invented


def unsupported_words(text: str, signals: List[Dict[str, Any]]) -> List[str]:
    """
    Words in `text` that only a signal can justify (approximations, directions, actions, urgency,
    strategies, the Vault, tickers) when no signal's title or detail says them, and first-person words.
    """
    said = " ".join(f"{s['title']} {s['detail']}" for s in signals)
    found = [m.group(0) for m in _SIGNAL_ONLY_WORDS.finditer(text)] + _ACRONYM.findall(text)
    unsupported = [w for w in found if not re.search(rf"\b{re.escape(w)}\b", said, re.IGNORECASE)]
    return unsupported + _FIRST_PERSON.findall(text)


def _rejection(text: str, signals: List[Dict[str, Any]], max_len: int = SUMMARY_MAX) -> Optional[str]:
    """Why a model text (at most `max_len` characters, two sentences) cannot be shown, or None when it can."""
    if not text:
        return "empty"
    if len(text) > max_len or len(_SENTENCE_END.findall(text)) > 2:
        return "not a short sentence"
    # Markup, and numbers the guard cannot read (½, superscripts).
    if _MARKUP.search(text) or any(unicodedata.category(ch) == "No" for ch in text):
        return "not plain text"
    invented = invented_numbers(text, signals)
    if invented:
        return f"numbers not in the signals: {', '.join(invented)}"
    unsupported = unsupported_words(text, signals)
    if unsupported:
        return f"words not in the signals: {', '.join(unsupported)}"
    if any("vault" not in text[max(m.start() - 40, 0):m.start()].lower() for m in _OUT_OF_REACH.finditer(text)):
        return "money outside the Vault said to be out of the agents' reach"
    return None


def _observations(signals: List[Dict[str, Any]]) -> str:
    lines = "\n".join(f"- {s['title']}. {s['detail']}" for s in signals)
    return f"Observations:\n{lines}"


def _ask_qvac(
    signals: List[Dict[str, Any]],
    system: str = PHRASE_SYSTEM_PROMPT,
    user: Optional[str] = None,
    key: str = "summary",
    timeout: float = PHRASE_TIMEOUT_S,
) -> str:
    """
    One chat call to the local model (the negotiator's client settings), returning the reply's `key`.
    By default the system prompt is the summary one and the user message the signals.
    """
    headers = {"Content-Type": "application/json", "Authorization": f"Bearer {settings.get_api_key()}"}
    payload = {
        "model": settings.QVAC_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": _observations(signals) if user is None else user},
        ],
        "temperature": 0.3,
        "max_tokens": 160,
        "reasoning_budget": 0,
        "response_format": {"type": "json_object"},
    }
    url = f"{settings.QVAC_BASE_URL.rstrip('/')}/chat/completions"
    resp = requests.post(url, json=payload, headers=headers, timeout=min(settings.QVAC_TIMEOUT, timeout))
    resp.raise_for_status()
    content = resp.json()["choices"][0]["message"]["content"]
    try:
        text = parse_llm_json_response(content).get(key)
    except (ValueError, AttributeError):
        # Not JSON: the reply itself, without a <think> block.
        text = re.sub(r"<think>.*?</think>", "", content, flags=re.DOTALL)
    if not isinstance(text, str):
        raise ValueError(f"the reply has no {key}")
    return " ".join(text.split()).strip('"').strip()


def phrase(signals: List[Dict[str, Any]]) -> Tuple[str, str]:
    """(summary, generated_by): the local model's sentence ("qvac"), or the rules template ("rules")."""
    rules = template_summary(signals)
    if not signals or settings.QVAC_MOCK:
        return rules, "rules"
    try:
        text = _ask_qvac(signals)
    except Exception as exc:
        logger.warning(f"Advisor phrasing failed ({exc}); using the rules summary.")
        return rules, "rules"
    problem = _rejection(text, signals)
    if problem:
        logger.info(f"Advisor discarded the model summary ({problem}): {text!r}")
        return rules, "rules"
    return text, "qvac"


# ── Cache & background phrasing ─────────────────────────────────────

class _Phrasing(NamedTuple):
    summary: str
    generated_by: str
    # Until then nothing asks the model again for these signals.
    fresh_until: float
    # Failed or discarded phrasings in a row, for the retry backoff.
    failures: int


_Key = Tuple[str, str]
_Job = Tuple[_Key, List[Dict[str, Any]], Callable[[], bool]]

_cache: Dict[_Key, _Phrasing] = {}
# The latest signals of each wallet waiting for a phrasing.
_jobs: Dict[str, _Job] = {}
# The signals being phrased right now, if any.
_in_progress: Optional[_Key] = None
_worker_running = False
_lock = threading.Lock()


def _signals_hash(signals: List[Dict[str, Any]]) -> str:
    return hashlib.sha256(json.dumps(signals, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _store(key: _Key, summary: str, generated_by: str, now: float) -> None:
    """A new phrasing; after a failure, the last good one for these signals (if any), with a backoff."""
    with _lock:
        for old in [k for k, entry in _cache.items() if entry.fresh_until + CACHE_TTL_S <= now]:
            del _cache[old]
        if generated_by == "qvac":
            _cache[key] = _Phrasing(summary, generated_by, now + CACHE_TTL_S, 0)
            return
        previous = _cache.get(key) or _Phrasing(summary, generated_by, now, 0)
        failures = previous.failures + 1
        retry_after = min(RETRY_AFTER_S * 2 ** (failures - 1), CACHE_TTL_S)
        _cache[key] = previous._replace(fresh_until=now + retry_after, failures=failures)


def _next_job() -> Optional[_Job]:
    """The next signals that still need a phrasing, or None, and then the worker stops."""
    global _in_progress, _worker_running
    with _lock:
        while _jobs:
            job = _jobs.pop(next(iter(_jobs)))
            entry = _cache.get(job[0])
            if entry is None or entry.fresh_until <= time.time():
                _in_progress = job[0]
                return job
        _in_progress = None
        _worker_running = False
        return None


def _work() -> None:
    """Phrases the waiting signals one at a time: one advisor call at a time on the single local model."""
    global _in_progress, _worker_running
    try:
        while (job := _next_job()) is not None:
            key, signals, model_busy = job
            # Asked again right before the call: a negotiation may have been queued since the request.
            if not model_busy():
                _store(key, *phrase(signals), time.time())
    except Exception:
        logger.exception("Advisor phrasing stopped")
        with _lock:
            _in_progress = None
            _worker_running = False


def _spawn(target: Callable[[], None]) -> None:
    threading.Thread(target=target, name="advisor-phrasing", daemon=True).start()


def _queue(wallet_id: str, job: _Job) -> None:
    """Hands signals to the worker; a newer request from the same wallet replaces its waiting one."""
    global _worker_running
    with _lock:
        _jobs[wallet_id] = job
        if _worker_running:
            return
        _worker_running = True
    _spawn(_work)


def _summary(wallet_id: str, signals: List[Dict[str, Any]], model_busy: Callable[[], bool]) -> Tuple[str, str, bool]:
    """(summary, generated_by, phrasing): the phrasing cached for these signals, else the template."""
    if not signals or settings.QVAC_MOCK:
        return template_summary(signals), "rules", False
    key = (wallet_id, _signals_hash(signals))
    with _lock:
        entry = _cache.get(key)
    if (entry is None or entry.fresh_until <= time.time()) and not model_busy():
        _queue(wallet_id, (key, signals, model_busy))
    # Read again: the worker may have answered already.
    with _lock:
        entry = _cache.get(key)
        waiting = _jobs.get(wallet_id)
        phrasing = _in_progress == key or (waiting is not None and waiting[0] == key)
    if entry and entry.generated_by == "qvac":
        return entry.summary, "qvac", phrasing
    return template_summary(signals), "rules", phrasing


def advise(
    wallet_id: str,
    wallet_state: Dict[str, Any],
    sessions: List[Dict[str, Any]],
    market: Dict[str, Any],
    model_busy: Callable[[], bool] = lambda: False,
) -> Dict[str, Any]:
    """
    The AdviceView for GET /api/wallets/{wallet_id}/advice. `model_busy` says whether a negotiation is
    running or queued; it is asked again right before any call to the model.
    """
    now = time.time()
    signals = compute_signals(wallet_state, sessions, market, now)
    summary, generated_by, phrasing = _summary(wallet_id, signals, model_busy)
    return {
        "wallet_id": wallet_id,
        "generated_at": int(now),
        "generated_by": generated_by,
        "phrasing": phrasing,
        "summary": summary,
        "signals": signals,
    }
