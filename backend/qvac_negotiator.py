"""
MwM - QVAC Local AI Negotiator Engine
Provides game-theoretic autonomous negotiation between Wallet A (Buyer) and Wallet B (Seller).

Features:
1. OpenAI-compatible client targeting local QVAC (Qwen 4B/8B) with 120s timeout.
2. Intelligent mock fallback (QVAC_MOCK=1 or offline resilience).
3. Leak Guard: finds the secret limit (budget/reserve) in a public message, in digits of any format
   (spaced out, marked up or in Unicode look-alikes too), in English words, through a scale or simple
   arithmetic, as a nearby number stated with limit language, or in any talk of the limit.
4. Rationality Guard: strictly guarantees bid/ask convergence within secret boundaries, and caps
   every concession at a secret pace per session, so that before the closing rounds no offer
   publishes a limit, nor lets a counterparty that knows the rules solve for it.
5. Structured JSON output with separate private_thought and public_message; a turn that either
   guard changed, or whose words contradict its move, is published with a neutral message quoting
   only the final offer.
6. Each agent reads only its own role's rules, and sees its counterparty's reliability and tier,
   computed in code from settled trades.
7. Zero usage of legacy names (Alice/Bob).
"""

import hashlib
import hmac
import json
import math
import re
import logging
import secrets
import unicodedata
import zlib
import requests
from typing import Any, Dict, List, NamedTuple, Optional, Tuple, Union
from pydantic import BaseModel, Field
from backend.config import settings

logger = logging.getLogger("mwm.qvac")

# Smallest concession per turn: MIN_STEP_SHARE of the gap to the counterparty, at least
# MIN_STEP_USD. With the pre-negotiation overlap check, offers always converge in a few rounds.
MIN_STEP_USD = 2
MIN_STEP_SHARE = 0.15

# Before the closing rounds each agent concedes at a secret pace of its own (concession_pace): an
# offer covers at most a share in PACE_SHARE_PCT of the room left to a hold line, which lies a secret
# margin inside the limit, from 1 USD to PACE_MARGIN_SHARE of the limit (at least PACE_MARGIN_MIN_USD).
PACE_SHARE_PCT = (25, 50)
PACE_MARGIN_SHARE = 0.03
PACE_MARGIN_MIN_USD = 2
# Drawn once per process, like the sessions it serves: no one outside can compute a session's pace.
_PACE_KEY = secrets.token_bytes(32)

# Longest owner strategy passed to the agent (the frontend caps the field at the same length).
PROMPT_MAX_LENGTH = 500

# A number within this share of the speaker's secret limit, stated with limit language, discloses it.
LEAK_NEAR_SHARE = 0.05

def min_step(previous_offer: int, counter_offer: Optional[int]) -> int:
    if counter_offer is None:
        return MIN_STEP_USD
    return max(MIN_STEP_USD, round(MIN_STEP_SHARE * abs(counter_offer - previous_offer)))

class NegotiationTurn(BaseModel):
    speaker_wallet_id: str
    speaker_label: str
    action: str  # "OFFER" | "ACCEPT"
    offer_usd: int
    public_message: str
    private_thought: str
    round_number: int

class NegotiationContext(BaseModel):
    session_id: str
    round_number: int  # 1 to max_rounds
    role: str  # "buyer" | "seller"
    wallet_id: str
    wallet_label: str
    counterparty_wallet_id: str
    counterparty_label: str
    asset_ticker: str
    asset_amount: int
    payment_ticker: str
    secret_limit_usd: int  # buyer max budget OR seller min reserve
    buyer_target_usd: Optional[int] = None
    current_bid_usd: Optional[int] = None
    current_ask_usd: Optional[int] = None
    your_previous_offer_usd: Optional[int] = None
    history: List[NegotiationTurn] = Field(default_factory=list)
    max_rounds: int = Field(default_factory=lambda: settings.NEGOTIATION_MAX_ROUNDS)
    # The seller's public asking price for the lot: the seller defends it, the buyer works it down.
    list_price_usd: Optional[int] = None
    # The owner's strategy for this agent (a preset or their own words), at most PROMPT_MAX_LENGTH.
    owner_instructions: str = ""
    # The counterparty's public reliability from the memory graph (never its limits or trade counts).
    # The agent may weigh it; blocking an untrusted counterparty stays in code (the gate).
    counterparty_reliability_pct: Optional[int] = None
    counterparty_trust_tier: Optional[str] = None

# ── Leak guard ──────────────────────────────────────────────────────

_LIMIT_NOUN = r"(?:reserve|limit|max|maximum|min|minimum|floor|ceiling|cap|budget|target|bottom[\s-]*line|walk[\s-]*away)s?\b"
# Talk about the speaker's own limit ("my reserve", "our absolute maximum", "my price floor", "my
# lowest price") or about a secret one: the message is rewritten, with a number or without.
_OWN_LIMIT_TALK = (
    r"\b(?:my|our)\s+(?:(?:absolute|actual|confidential|final|firm|hard|internal|lower|own|personal|price|"
    r"private|real|secret|spending|strict|top|total|true|upper)\s+){0,3}" + _LIMIT_NOUN
    + r"|\b(?:my|our)\s+(?:very\s+)?(?:lowest|highest)\s+price\b"
    + r"|\b(?:secret|confidential|private)\s+" + _LIMIT_NOUN
)
OWN_LIMIT_TALK = re.compile(_OWN_LIMIT_TALK, re.IGNORECASE)
_REFUSAL = (r"(?:can(?:not|'t|\s+not)|could(?:n't|\s+not)|won't|will\s+not|wouldn't|would\s+not|unable\s+to|"
            r"not\s+(?:going|willing|able|prepared)(?:\s+to)?|never)")
_BEYOND = r"(?:higher|lower|above|below|over|under|beyond|further|more|less|better|exceed\w*)"
# Limit language makes a number near the limit read as the limit ("I can't go below 112", "112 is the
# lowest I'll go", "not a penny more", "a buck under 136"). It is matched on plain_text(), with
# ASCII apostrophes and numbers in digits.
LIMIT_LANGUAGE = re.compile(
    _OWN_LIMIT_TALK
    + r"|\bbottom[\s-]*line\b|\bwalk(?:ing|s)?[\s-]*away\b"
    + rf"|\b{_REFUSAL}\s+(?:\w+\s+){{0,2}}{_BEYOND}\b"
    + r"|\b(?:highest|lowest|most|least|max(?:imum)?|min(?:imum)?)\s+(?:i|we)(?:'ll|'m|'d|'re|\s+(?:can|could|will|would|am|are))\b"
    + r"|\bas\s+(?:high|low|far|much|little)\s+as\s+(?:i|we)\b|\bbest\s+(?:i|we)\s+(?:can|could)\s+(?:do|offer|pay|go)\b"
    + r"|\bexceed\w*|\b(?:anything|nothing)\s+(?:under|below|over|above|less|more|lower|higher)\b"
    + r"|\ba\s+(?:cent|penny|buck|dollar)\s+(?:more|less|over|under|above|below|higher|lower)\b"
    + r"|\b(?:under|below|beneath|over|above|minus|less\s+than|more\s+than|short\s+of|shy\s+of)\s+\d"
    + r"|\b(?:a|the|absolute)\s+(?:maximum|minimum|max|min)\b"
    + r"|\b(?:up\s+to|at\s+most|at\s+least|no\s+(?:more|less|higher|lower)\s+than|tops)\b",
    re.IGNORECASE,
)

# Unicode dashes and the minus sign as "-", typographic apostrophes and primes as "'".
_ASCII_PUNCTUATION = {
    **dict.fromkeys(map(ord, "\u2010\u2011\u2012\u2013\u2014\u2015\u2212"), "-"),
    **dict.fromkeys(map(ord, "\u2018\u2019\u02bc\u2032"), "'"),
}

def plain_text(text: str) -> str:
    """
    A message as its reader sees it, in a form the checks can match: compatibility forms folded
    (superscript, circled and full-width digits), every decimal digit in ASCII, invisible and
    combining marks dropped (a zero-width space inside "135" still reads 135), Unicode dashes, minus
    signs and apostrophes in ASCII, in lower case.
    """
    kept = []
    for char in unicodedata.normalize("NFKC", text):
        category = unicodedata.category(char)
        if category not in ("Cf", "Mn"):
            kept.append(str(unicodedata.decimal(char)) if category == "Nd" else char)
    return "".join(kept).translate(_ASCII_PUNCTUATION).lower()

_UNITS = {w: i for i, w in enumerate(
    "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen "
    "seventeen eighteen nineteen".split())}
_TENS = {w: 10 * i for i, w in enumerate("twenty thirty forty fifty sixty seventy eighty ninety".split(), start=2)}
_THOUSANDS = ("thousand", "grand")
_ORDINALS = {"first": "one", "third": "three", "fifth": "five", "eighth": "eight", "ninth": "nine", "twelfth": "twelve"}
# A word, or a group of digits (with separators, as in 1.35 or 1,350, it is left to the digit scan).
_TOKEN = re.compile(r"[a-z]+|\d+(?:[.,']\d+)*")
# A token of a number phrase: a word, a plain group of digits, or None for digits with separators.
Token = Union[str, int, None]

def _cardinal(word: str) -> str:
    """An ordinal number word as its cardinal ("fifth" -> "five", "thirtieth" -> "thirty"), others as they are."""
    if word in _ORDINALS:
        return _ORDINALS[word]
    if word.endswith("ieth") and word[:-4] + "y" in _TENS:
        return word[:-4] + "y"
    if word.endswith("th") and (word[:-2] in _UNITS or word[:-2] in ("hundred", "thousand")):
        return word[:-2]
    return word

def _phrase_token(token: str) -> Token:
    """A word as its cardinal, a group of up to 6 digits as its value, any other digits as None."""
    if not token[0].isdigit():
        return _cardinal(token)
    return int(token) if token.isdigit() and len(token) <= 6 else None

def _below_hundred(tokens: List[Token], i: int) -> Optional[Tuple[int, int]]:
    """0-99 at tokens[i] ("thirty-five", "twelve", "35"), with the index after it."""
    token = tokens[i] if i < len(tokens) else None
    if isinstance(token, int):
        return (token, i + 1) if token < 100 else None
    if token in _TENS:
        unit = tokens[i + 1] if i + 1 < len(tokens) else None
        unit = _UNITS.get(unit) if isinstance(unit, str) else unit
        return (_TENS[token] + unit, i + 2) if isinstance(unit, int) and 0 < unit < 10 else (_TENS[token], i + 1)
    return (_UNITS[token], i + 1) if token in _UNITS else None

def _below_thousand(tokens: List[Token], i: int) -> Optional[Tuple[int, int]]:
    """0-999 at tokens[i]: "[a | 0-99] hundred [and] [0-99]", 0-99, or a group of 100-999 in digits."""
    token = tokens[i] if i < len(tokens) else None
    if isinstance(token, int) and 100 <= token < 1000:
        return token, i + 1
    head = (1, i + 1) if token == "a" else _below_hundred(tokens, i)
    if head is None:
        return None
    j = head[1]
    if j < len(tokens) and tokens[j] == "hundred":
        k = j + 2 if j + 1 < len(tokens) and tokens[j + 1] == "and" else j + 1
        tail = _below_hundred(tokens, k)
        return (100 * head[0] + tail[0], tail[1]) if tail else (100 * head[0], j + 1)
    return None if token == "a" else head

def _words_number(tokens: List[Token], i: int) -> Optional[Tuple[int, int]]:
    """Up to 999,999 at tokens[i] ("a hundred and thirty-five", "one thousand, three hundred fifty", "1 thousand 350")."""
    if tokens[i] == "a" and i + 1 < len(tokens) and tokens[i + 1] in _THOUSANDS:
        value, j = 1, i + 1
    else:
        first = _below_thousand(tokens, i)
        if first is None:
            return None
        value, j = first
    if j < len(tokens) and tokens[j] in _THOUSANDS:
        value, j = 1000 * value, j + 1
        k = j + 1 if j < len(tokens) and tokens[j] == "and" else j
        rest = _below_thousand(tokens, k)
        if rest:
            value, j = value + rest[0], rest[1]
    return value, j

def with_digits(text: str) -> str:
    """
    plain_text() with each number written in words, alone or with digits, as digits: "one hundred and
    thirty-five" and "one hundred 35" are 135, "a grand" is 1000, "the thirty-fifth" is "the 35". A
    price said aloud keeps its parts ("one thirty-five" is "1 35", "thirteen fifty" is "13 50") and
    the digit scan reads them together, as it reads "one three five" ("1 3 5").
    """
    text = re.sub(r"\ba\s+(?=(?:bucks?|dollars?)\b)", "1 ", text.replace("&", " and "))
    matches = list(_TOKEN.finditer(text))
    pieces, cursor, start = [], 0, 0
    while start < len(matches):
        # A number phrase never crosses anything but spaces, hyphens and commas.
        end = start + 1
        while end < len(matches) and re.fullmatch(r"[\s,-]*", text[matches[end - 1].end():matches[end].start()]):
            end += 1
        run = matches[start:end]
        tokens = [_phrase_token(m.group()) for m in run]
        i = 0
        while i < len(tokens):
            parsed = _words_number(tokens, i)
            if parsed is None:
                i += 1
                continue
            value, j = parsed
            if any(isinstance(token, str) for token in tokens[i:j]):
                pieces += [text[cursor:run[i].start()], str(value)]
                cursor = run[j - 1].end()
            i = j
        start = end
    pieces.append(text[cursor:])
    return "".join(pieces)

# A run of digits with separators; no word boundary, so "135USDT" and "USDT135" hold 135.
_DIGIT_RUN = re.compile(r"\d+(?:[.,'\s]\d+)*")
# Digit groups apart by at most three spaces or marks ("1 3 5", "1-3-5", "1, 3, 5", "1**3**5").
# Numbers match only from their first digit, so a very long run of digits is read in linear time.
_SPACED_RUN = re.compile(r"(?<!\d)\d+(?:[\s.,'/_*`~-]{1,3}\d+)+")
# Two groups that read as a decimal ("1.35", "135.00"), which joined would be another number.
_DECIMAL_PAIR = re.compile(r"\d+[.,]\d{1,2}")

def _thousands(pieces: List[str]) -> bool:
    return len(pieces[0]) <= 3 and all(len(piece) == 3 for piece in pieces[1:])

def _separated_values(part: str) -> List[float]:
    """Digits with ",", "." or "'" separators: decimals (1-2 digits after a final "," or "."), thousands, or apart."""
    pieces = re.split(r"[.,']", part)
    *head, last = pieces
    if head and len(last) <= 2 and part[-len(last) - 1] in ".," and (len(head) == 1 or _thousands(head)):
        return [float("".join(head) + "." + last)]
    if _thousands(pieces):
        return [float("".join(pieces))]
    return [float(piece) for piece in pieces]

def _digit_values(run: str) -> List[float]:
    """What a run of digits can stand for: 1,350 / 1.350 / 1'350 / 1 350 are 1350; 135.00 is 135; "2 135" holds 135."""
    parts = run.split()
    values = [value for part in parts for value in _separated_values(part)]
    if len(parts) > 1 and all(part.isdigit() for part in parts) and _thousands(parts):
        values.append(float("".join(parts)))
    return values

def _joined_values(run: str) -> List[float]:
    """Neighbouring digit groups read as one number, up to 7 digits: "1 3 5" holds 13, 35 and 135. A
    decimal ("1.35") is not joined, and a number in thousands ("1,000,000") is read whole only."""
    pieces = re.split(r"(\D+)", run)
    groups, gaps = pieces[::2], pieces[1::2]
    if _thousands(groups):
        return [float("".join(groups))]
    values = []
    for i in range(len(groups)):
        for j in range(i + 2, len(groups) + 1):
            joined = "".join(groups[i:j])
            if len(joined) > 7:
                break
            if j - i > 2 or not _DECIMAL_PAIR.fullmatch(groups[i] + gaps[i] + groups[i + 1]):
                values.append(float(joined))
    return values

_NUMBER = r"(?<![\d.,'])\d+(?:[.,']\d+)*"
_SCALE = {"k": 1000, "hundred": 100, "thousand": 1000, "grand": 1000}
_SCALED = re.compile(rf"({_NUMBER})\s*(k|hundred|thousand|grand)\b")
_SCIENTIFIC = re.compile(r"(?<![\d.])(\d+(?:\.\d+)?)e(\d{1,2})\b")
_CENTS = re.compile(rf"({_NUMBER})\s*cents?\b")
_SUM = re.compile(rf"({_NUMBER})\s*(\+|plus|-|minus|less)\s*({_NUMBER})")
_OFFSET = re.compile(
    rf"({_NUMBER})\s*(?:bucks?|dollars?|usdt|usd)?\s*(less\s+than|under|below|short\s+of|shy\s+of|more\s+than|over|above)\s*({_NUMBER})")
_HALF = re.compile(rf"\bhalf\s+(?:of\s+)?({_NUMBER})")
_DOUBLE = re.compile(rf"\b(?:twice|double)\s+({_NUMBER})")

def _value(number: str) -> float:
    return _separated_values(number)[0]

def _derived_values(text: str) -> List[float]:
    """Numbers stated through a scale, a unit or simple arithmetic: 1.35k, 1.35 hundred, 1e3, 13,500 cents,
    150 minus 15, 100 + 35, one less than 136, a buck under 136, half of 270."""
    values = [_value(number) * _SCALE[scale] for number, scale in _SCALED.findall(text)]
    values += [float(number) * 10 ** int(exponent) for number, exponent in _SCIENTIFIC.findall(text)]
    values += [_value(number) / 100 for number in _CENTS.findall(text)]
    values += [_value(a) + _value(b) if op in ("+", "plus") else _value(a) - _value(b) for a, op, b in _SUM.findall(text)]
    values += [_value(b) + _value(a) if relation.startswith(("more", "over", "above")) else _value(b) - _value(a)
               for a, relation, b in _OFFSET.findall(text)]
    values += [_value(number) / 2 for number in _HALF.findall(text)]
    values += [_value(number) * 2 for number in _DOUBLE.findall(text)]
    return values

def _numbers_in(text: str) -> List[float]:
    """The numbers of a text already through plain_text() and with_digits()."""
    values = [value for run in _DIGIT_RUN.findall(text) for value in _digit_values(run)]
    values += [value for run in _SPACED_RUN.findall(text) for value in _joined_values(run)]
    values += _derived_values(text)
    return list(dict.fromkeys(round(value, 6) for value in values))

def stated_numbers(text: str) -> List[float]:
    """
    Every number a message states: in digits of any format (glued to letters or not, spaced out,
    marked up, in Unicode look-alikes), in English words alone or mixed with digits, and through a
    scale, a unit or simple arithmetic. Roman numerals, other bases and longer arithmetic are not read.
    """
    return _numbers_in(with_digits(plain_text(text)))

def leak_guard(public_message: str, secret_limit_usd: int, replacement: str = "") -> Tuple[bool, str]:
    """
    Does a public message reveal the speaker's secret limit? It does when it states the limit (in
    any form stated_numbers() reads, such as 135USDT, $135, 135.00, 1,350, 1 3 5, one hundred 35 or
    150 minus 15), when it states a number within LEAK_NEAR_SHARE of the limit with limit language
    ("I can't go below 112", "112 is the lowest I'll go"), and whenever the speaker talks about its
    own limit at all ("within my reserve limit").
    Returns (has_leak, message to publish): the message itself when it is safe, else `replacement`
    (generate_turn passes a neutral message built from the final offer).
    """
    text = with_digits(plain_text(public_message))
    numbers = _numbers_in(text)
    if secret_limit_usd in numbers:
        reason = "it states the limit"
    elif OWN_LIMIT_TALK.search(text):
        reason = "it talks about the speaker's own limit"
    elif LIMIT_LANGUAGE.search(text) and any(
        abs(number - secret_limit_usd) <= LEAK_NEAR_SHARE * secret_limit_usd for number in numbers
    ):
        reason = "it states a number near the limit with limit language"
    else:
        return False, public_message
    logger.warning(f"LeakGuard triggered: the public message is replaced ({reason}).")
    return True, replacement

# Public messages for a turn that a guard changed. Each quotes only the published offer, so the turn
# reads like any other and never repeats a price or an acceptance the guard overruled; the two roles
# share no sentence, and an offer in round 1 opens the talks.
NEUTRAL_MESSAGES: Dict[Tuple[str, str], Tuple[str, ...]] = {
    ("buyer", "OPEN"): (
        "I open at {offer} {ticker}.",
        "My opening bid is {offer} {ticker}.",
        "To start, I offer {offer} {ticker} for the lot.",
    ),
    ("buyer", "OFFER"): (
        "I can offer {offer} {ticker}.",
        "My bid is {offer} {ticker}.",
        "I propose {offer} {ticker} for the lot.",
        "Let's continue at {offer} {ticker}.",
    ),
    ("buyer", "ACCEPT"): (
        "I accept your ask of {offer} {ticker}.",
        "Agreed: I pay {offer} {ticker}.",
        "{offer} {ticker} works for me: I accept.",
    ),
    ("seller", "OPEN"): (
        "My opening ask is {offer} {ticker}.",
        "I open the lot at {offer} {ticker}.",
        "To start, I ask {offer} {ticker} for the lot.",
    ),
    ("seller", "OFFER"): (
        "I can do {offer} {ticker} for the lot.",
        "My ask is {offer} {ticker}.",
        "I can sell at {offer} {ticker}.",
        "Let's keep talking at {offer} {ticker}.",
    ),
    ("seller", "ACCEPT"): (
        "I accept your bid of {offer} {ticker}.",
        "Agreed: I sell at {offer} {ticker}.",
        "Deal at {offer} {ticker}.",
    ),
}

def neutral_message(ctx: NegotiationContext, action: str, offer_usd: int) -> str:
    """The public message for a guarded move, picked by session, role and round so that a run is reproducible."""
    role = "buyer" if ctx.role == "buyer" else "seller"
    kind = "OPEN" if action == "OFFER" and ctx.round_number == 1 else action
    templates = NEUTRAL_MESSAGES[(role, kind)]
    index = (zlib.crc32(f"{ctx.session_id}:{role}".encode()) + ctx.round_number) % len(templates)
    return templates[index].format(offer=offer_usd, ticker=ctx.payment_ticker)

# An ACCEPT is published with words that accept; an OFFER's words never claim an acceptance
# ("I can't accept 150" is fine, "I accept your terms" is not).
ACCEPT_WORDS = re.compile(r"\b(?:agree\w*|accept\w*|deal)\b", re.IGNORECASE)
CLAIMS_ACCEPTANCE = re.compile(
    r"\b(?:i|we)\s+(?:(?:gladly|happily|hereby)\s+)?(?:accept|agree)\b|\b(?:agreed|accepted)\b|\bit'?s\s+a\s+deal\b",
    re.IGNORECASE,
)

def says_its_move(public_message: str, action: str) -> bool:
    """Do the words match the move: an ACCEPT that says it accepts, an OFFER that does not?"""
    text = plain_text(public_message)
    return bool(ACCEPT_WORDS.search(text)) if action == "ACCEPT" else not CLAIMS_ACCEPTANCE.search(text)

class ConcessionPace(NamedTuple):
    """An agent's secret concession pace in one session (concession_pace)."""
    share_pct: int  # an offer covers at most this share of the room left to the hold line
    margin_usd: int  # the hold line's distance inside the secret limit

def concession_pace(session_id: str, role: str, secret_limit_usd: int) -> ConcessionPace:
    """
    The pace of `role` in `session_id`: a share in PACE_SHARE_PCT and a margin of 1 USD up to
    max(PACE_MARGIN_MIN_USD, PACE_MARGIN_SHARE of the limit), keyed by a secret of this process.
    The same agent in the same session always gets the same pace, but nothing public (the session
    id, the rules, the offers) computes it, so a counterparty cannot solve the limit from the offers.
    """
    digest = hmac.new(_PACE_KEY, f"{session_id}:{role}".encode(), hashlib.sha256).digest()
    low, high = PACE_SHARE_PCT
    widest = max(PACE_MARGIN_MIN_USD, round(PACE_MARGIN_SHARE * secret_limit_usd))
    share = low + int.from_bytes(digest[:8], "big") % (high - low + 1)
    return ConcessionPace(share, 1 + int.from_bytes(digest[8:16], "big") % widest)

def rationality_guard(
    role: str,
    raw_action: str,
    raw_offer_usd: int,
    secret_limit_usd: int,
    current_bid_usd: Optional[int],
    current_ask_usd: Optional[int],
    your_previous_offer_usd: Optional[int],
    round_number: int,
    max_rounds: Optional[int] = None,
    buyer_target_usd: Optional[int] = None,
    counterparty_previous_offer_usd: Optional[int] = None,
    *,
    pace: ConcessionPace,
) -> Tuple[str, int]:
    """
    Enforces game-theoretic rationality and inviolable mathematical bounds, deterministically for a
    given pace (generate_turn passes the agent's secret concession_pace()):
    - Buyer never bids > max_budget; bids must be monotonic non-decreasing; if bid >= current_ask -> ACCEPT.
    - Seller never asks < min_reserve; asks must be monotonic non-increasing; if ask <= current_bid -> ACCEPT.
    - After its opening every new offer moves towards the counterparty by at least min_step().
    - ACCEPT takes the counterparty's current price, and only when that price is within the secret
      limit: any other ACCEPT is an OFFER at the model's price and goes through the same checks.
    - Before the closing rounds (the last two), an ACCEPT far from the agent's own last offer
      becomes a counter-offer of a quarter of the gap.
    - Concession cap, before the closing rounds: a hold line lies pace.margin_usd inside the secret
      limit, and a new offer covers at most pace.share_pct (25-50%) of the room left between the
      previous offer and the hold line, rounded down, so it never equals the limit, never concedes
      more than half of the distance to it, and stays put once the room is too small to move. The
      buyer's first bid is measured from its target valuation; an opening with nothing to measure
      from stops at the hold line. The cap beats min_step(): protecting the limit comes before
      speed. The pace is secret, so a counterparty that knows these rules cannot solve the limit
      from the offers: the hold line places it only within the margin's range.
    - At its hold line before the closing rounds, an agent takes the counterparty's price when it
      is within the limit. When it is not and the counterparty repeated it (before the closing
      rounds the guard lets an agent repeat a price only at its own hold line), the limits overlap
      by less than the two margins: the agent offers its limit, the one price left that can close,
      rather than stalling.
    - In the closing rounds the limit itself may be offered. The last round never ends a possible
      deal: the buyer's last turn takes an ask within its ceiling or bids the ceiling, and the
      seller's last turn takes a bid at or above its reserve.
    """
    last_round = max_rounds or settings.NEGOTIATION_MAX_ROUNDS
    closing_round = max(last_round - 1, 1)
    if role == "buyer":
        can_accept = current_ask_usd is not None and current_ask_usd <= secret_limit_usd
        counter_price = current_ask_usd
    else:
        can_accept = current_bid_usd is not None and current_bid_usd >= secret_limit_usd
        counter_price = current_bid_usd
    # An ACCEPT closes the deal at the counterparty's price (contract: the accepting side's offer
    # field holds the agreed price), so it only counts when that price is within the limit.
    wants_accept = raw_action.strip().upper() == "ACCEPT" and can_accept
    action = "OFFER"

    offer = raw_offer_usd

    if role == "buyer":
        # Buyer ceiling limit clamp
        if offer > secret_limit_usd:
            logger.info(f"RationalityGuard: clamping buyer offer {offer} down to ceiling {secret_limit_usd}")
            offer = secret_limit_usd

        # Monotonicity: offer >= previous bid
        if your_previous_offer_usd is not None and offer < your_previous_offer_usd:
            logger.info(f"RationalityGuard: buyer offer {offer} was lower than previous bid {your_previous_offer_usd}. Raising.")
            offer = your_previous_offer_usd
        # Convergence: every new bid moves up by at least min_step(), until the ceiling.
        if your_previous_offer_usd is not None:
            step = min_step(your_previous_offer_usd, current_ask_usd)
            if offer < your_previous_offer_usd + step:
                offer = min(secret_limit_usd, your_previous_offer_usd + step)

        # Deal zone check: if buyer offer meets or exceeds current ask, accept ask
        if current_ask_usd is not None and offer >= current_ask_usd:
            action = "ACCEPT"
            offer = current_ask_usd

    elif role == "seller":
        # Seller floor limit clamp
        if offer < secret_limit_usd:
            logger.info(f"RationalityGuard: clamping seller ask {offer} up to reserve {secret_limit_usd}")
            offer = secret_limit_usd

        # Monotonicity: ask <= previous ask
        if your_previous_offer_usd is not None and offer > your_previous_offer_usd:
            logger.info(f"RationalityGuard: seller ask {offer} was higher than previous ask {your_previous_offer_usd}. Lowering.")
            offer = your_previous_offer_usd
        # Convergence: after its opening at the list price, every new ask moves down by at
        # least min_step(), until the reserve.
        if round_number > 1 and your_previous_offer_usd is not None:
            step = min_step(your_previous_offer_usd, current_bid_usd)
            if offer > your_previous_offer_usd - step:
                offer = max(secret_limit_usd, your_previous_offer_usd - step)

        # Deal zone check: if seller ask meets or is below current bid, accept bid
        if current_bid_usd is not None and offer <= current_bid_usd:
            action = "ACCEPT"
            offer = current_bid_usd

    if action != "ACCEPT":
        # The last round never ends a possible deal: the seller's turn ends the negotiation, so it
        # takes a bid at or above the reserve; the buyer's turn, just before it, takes an ask within
        # the ceiling or bids the ceiling, which the seller's turn then takes.
        final_turn = round_number >= last_round
        if can_accept and (wants_accept or final_turn):
            action = "ACCEPT"
            offer = counter_price
        elif final_turn and role == "buyer":
            offer = secret_limit_usd

    # Before the closing rounds an agent does not jump to a price far from its own last offer:
    # the seller defends its list price, the buyer works it down, so it counters with a measured
    # concession (a quarter of the gap, at least 2 USD, never past its secret limit) instead.
    if action == "ACCEPT" and round_number < closing_round and your_previous_offer_usd is not None:
        gap = abs(offer - your_previous_offer_usd)
        if gap > max(3, round(0.03 * your_previous_offer_usd)):
            step = max(2, round(gap / 4))
            if role == "seller":
                offer = max(secret_limit_usd, your_previous_offer_usd - step)
            else:
                offer = min(secret_limit_usd, your_previous_offer_usd + step)
            action = "OFFER"

    # Concession cap: before the closing rounds no offer reaches the hold line, a secret margin inside
    # the limit, so the price neither publishes the limit nor solves for it. Taking the counterparty's
    # own price (ACCEPT above) stays possible.
    if action == "OFFER" and round_number < closing_round:
        inward = 1 if role == "buyer" else -1
        hold_line = secret_limit_usd - inward * pace.margin_usd
        anchor = your_previous_offer_usd
        if anchor is None and role == "buyer" and buyer_target_usd is not None and buyer_target_usd < hold_line:
            anchor = buyer_target_usd
        if anchor is None:
            capped = max(1, min(offer, hold_line)) if role == "buyer" else max(offer, hold_line)
            reach = None
        else:
            reach = max(0, inward * (hold_line - anchor)) * pace.share_pct // 100
            capped = min(offer, anchor + reach) if role == "buyer" else max(offer, anchor - reach)
        if capped != offer:
            logger.info(f"RationalityGuard: {role} offer {offer} capped at {capped}, at its secret pace.")
        offer = capped
        if reach == 0 and your_previous_offer_usd is not None:
            # At the hold line: take a price within the limit; facing a counterparty that holds a
            # price beyond it too, offer the limit, the one price left that can close.
            if can_accept:
                action, offer = "ACCEPT", counter_price
            elif counter_price is not None and counter_price == counterparty_previous_offer_usd:
                logger.info(f"RationalityGuard: both sides hold; {role} offers its limit to close.")
                offer = secret_limit_usd

    return action, offer

def coerce_offer_usd(value: Any) -> Optional[int]:
    """Integer USD price from model output (130, 130.0, "130", "$130", "130 USDT"); None if unusable (also NaN or infinite)."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value if value > 0 else None
    if isinstance(value, float):
        number = value
    else:
        match = re.fullmatch(r"\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:usdt|usd)?\s*", str(value), flags=re.IGNORECASE)
        if not match:
            return None
        number = float(match.group(1))
    if not math.isfinite(number):
        return None
    offer = int(round(number))
    return offer if offer > 0 else None

def parse_llm_json_response(raw_text: str) -> Dict[str, Any]:
    """Robustly extract the JSON payload, stripping <think> blocks and code fences."""
    # Strip <think>...</think> if emitted by reasoning models
    cleaned = re.sub(r"<think>.*?</think>", "", raw_text, flags=re.DOTALL).strip()

    # Look for ```json ... ``` or first { ... }
    fence_match = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, flags=re.DOTALL)
    if fence_match:
        json_str = fence_match.group(1)
    else:
        obj_match = re.search(r"(\{.*\})", cleaned, flags=re.DOTALL)
        json_str = obj_match.group(1) if obj_match else cleaned

    return json.loads(json_str)

def counterparty_reliability_line(ctx: NegotiationContext) -> str:
    """e.g. "Counterparty reliability: 92% (High Authenticity), computed from settled trades." """
    if ctx.counterparty_trust_tier is None:
        return ""
    score = "not scored yet" if ctx.counterparty_reliability_pct is None else f"{ctx.counterparty_reliability_pct}%"
    return f"Counterparty reliability: {score} ({ctx.counterparty_trust_tier}), computed from settled trades."

def build_system_prompt(ctx: NegotiationContext) -> str:
    """Game-theoretic instructions for the local AI: its own role's goal, limit and rules only."""
    pay = ctx.payment_ticker
    closing_round = max(ctx.max_rounds - 1, 1)
    list_price = ctx.list_price_usd or ctx.current_ask_usd or 150
    if ctx.role == "buyer":
        role_desc, limit_name = "Buyer", "ceiling"
        target = ctx.buyer_target_usd
        private = "your ceiling, budget or target valuation" if target else "your ceiling or budget"
        action_goal = (
            f"You want to buy {ctx.asset_amount} {ctx.asset_ticker} paying in {pay}. "
            f"The seller's public list price is {list_price} {pay}; you do not know how low the seller will go. "
            f"Your goal is to pay as little as possible. "
            + (f"Your target valuation is {target} {pay}. " if target else "")
            + f"Your CONFIDENTIAL CEILING (absolute maximum budget) is {ctx.secret_limit_usd} {pay}. NEVER EXCEED IT."
        )
        opening = f", near your target valuation ({target} {pay})" if target else ""
        rules = [
            f"Round 1: open well below the list price{opening}. NEVER open at your ceiling {ctx.secret_limit_usd}!",
            f"Following rounds: concede gradually (by default +2 to +5 {pay} per round); each new offer must be higher than your previous one. Do NOT jump to your ceiling.",
            f"Before round {closing_round}, never ACCEPT an ask far above your own last offer: counter with a small step instead.",
            f"From round {closing_round}: work to close: ACCEPT the seller's ask if it is within your ceiling, otherwise make your best closing offer.",
        ]
    else:
        role_desc, limit_name, private = "Seller", "reserve", "your reserve or minimum price"
        action_goal = (
            f"You are selling {ctx.asset_amount} {ctx.asset_ticker} for {pay}. "
            f"Your public list price is {list_price} {pay} and every buyer can see it. "
            f"Your goal is a final price as near to your list price as possible. "
            f"Your CONFIDENTIAL RESERVE (absolute minimum price) is {ctx.secret_limit_usd} {pay}. NEVER GO BELOW IT."
        )
        rules = [
            f"Round 1: open at your list price ({list_price} {pay}).",
            f"Following rounds: concede gradually towards the buyer (by default -3 to -8 {pay} per round); each new offer must be lower than your previous one. Aim to finish as near to your list price as the buyer allows.",
            f"Before round {closing_round}, never ACCEPT a bid far below your own last offer: counter with a small step instead.",
            f"From round {closing_round}: work to close: ACCEPT the buyer's bid if it is at or above your reserve {ctx.secret_limit_usd}, otherwise make your best closing offer.",
        ]

    instructions = " ".join(ctx.owner_instructions.split())[:PROMPT_MAX_LENGTH]
    if instructions:
        rules.append(f"Your owner's strategy, which sets your pace within the rules above: \"{instructions}\"")
    strategy = "\n".join(f"   - {rule}" for rule in rules)

    reliability = counterparty_reliability_line(ctx)
    reliability_rule = (
        f"\n{reliability} You may be more cautious with a less reliable counterparty, within the rules below."
        if reliability
        else ""
    )

    return f"""You are {ctx.wallet_label}, an elite autonomous trading agent executing an on-chain RGB peer-to-peer swap.
Role: {role_desc}.
Counterparty: {ctx.counterparty_label}.{reliability_rule}
Traded Asset: {ctx.asset_amount} {ctx.asset_ticker}.
Payment Asset: {pay} (atomic on-chain settlement).
Goal: {action_goal}

CRITICAL RULES:
1. Confidentiality: NEVER disclose your {limit_name} to the counterparty in your public_message, in digits or in words, and never mention {private} at all. Quote no price other than your offer_usd.
2. Strategy: this is round {ctx.round_number} of at most {ctx.max_rounds}. The negotiation ends without a deal after round {ctx.max_rounds}, or earlier if both sides stop moving.
{strategy}
3. ACCEPT takes the counterparty's current price (offer_usd is then that price); OFFER proposes your own price in offer_usd. You must output ONLY a valid JSON object matching this exact structure:
{{
  "private_thought": "<1-2 sentences of cold strategic assessment: estimated counterparty stance and rationale>",
  "action": "OFFER" or "ACCEPT",
  "offer_usd": <integer price in {ctx.payment_ticker}>,
  "public_message": "<diplomatic, persuasive, professional message explaining your position to the counterparty>"
}}"""

def build_user_prompt(ctx: NegotiationContext) -> str:
    """Provide structured round state and past history."""
    history_lines = []
    for turn in ctx.history:
        history_lines.append(
            f"Round {turn.round_number} [{turn.speaker_label}]: {turn.action} {turn.offer_usd} {ctx.payment_ticker} - \"{turn.public_message}\""
        )
    history_str = "\n".join(history_lines) if history_lines else "No previous rounds."

    return f"""Current Round: {ctx.round_number} / {ctx.max_rounds}.
Current Market Spread:
- Current Buyer Bid: {ctx.current_bid_usd if ctx.current_bid_usd is not None else 'None'} {ctx.payment_ticker}
- Current Seller Ask: {ctx.current_ask_usd if ctx.current_ask_usd is not None else 'None'} {ctx.payment_ticker}
- Seller's Public List Price: {ctx.list_price_usd if ctx.list_price_usd is not None else 'None'} {ctx.payment_ticker}
- Your Previous Offer: {ctx.your_previous_offer_usd if ctx.your_previous_offer_usd is not None else 'None'} {ctx.payment_ticker}

Negotiation History:
{history_str}

Evaluate the state, formulate your private tactical thought, and output your JSON response:"""

def mock_negotiate(ctx: NegotiationContext) -> Dict[str, Any]:
    """
    Intelligent simulated negotiation generator for development and tests without a QVAC daemon:
    opens in round 1, concedes every round and closes in the last round (ctx.max_rounds).
    """
    final_round = ctx.round_number >= ctx.max_rounds
    if ctx.role == "buyer":
        target = ctx.buyer_target_usd or 120
        current_ask = ctx.current_ask_usd or 150
        if ctx.round_number == 1 and current_ask <= min(target, ctx.secret_limit_usd):
            # A part of a lot can list at or below the target: take the ask, never quote the target.
            action, offer = "ACCEPT", current_ask
            thought = f"The ask of {current_ask} is within my target ({target} USD). Accepting it. {counterparty_reliability_line(ctx)}".strip()
            msg = f"Your ask of {current_ask} {ctx.payment_ticker} is acceptable."
        elif ctx.round_number == 1:
            action, offer = "OFFER", target
            thought = f"Opening near target valuation ({target} USD) to anchor the spread conservatively. {counterparty_reliability_line(ctx)}".strip()
            msg = f"Considering secondary market depth, I open with {offer} {ctx.payment_ticker} for immediate atomic settlement."
        elif final_round:
            if current_ask <= ctx.secret_limit_usd:
                action, offer = "ACCEPT", current_ask
                thought = f"Final round: seller ask {current_ask} is within ceiling {ctx.secret_limit_usd}. Accepting to avoid breakdown."
                msg = f"Final round agreement confirmed at {offer} {ctx.payment_ticker}."
            else:
                action, offer = "OFFER", ctx.secret_limit_usd
                thought = "Final round: pushing to absolute budget ceiling as take-it-or-leave-it."
                msg = f"This is my final best offer: {offer} {ctx.payment_ticker}."
        else:
            offer = min((ctx.your_previous_offer_usd or target) + 5, ctx.secret_limit_usd)
            if offer >= current_ask and current_ask <= ctx.secret_limit_usd:
                action, offer = "ACCEPT", current_ask
                thought = f"Seller's ask of {current_ask} is within budget. Executing agreement."
                msg = f"Your ask of {current_ask} {ctx.payment_ticker} is acceptable. Let's proceed to cryptographic signatures."
            else:
                action = "OFFER"
                thought = f"Seller countered at {current_ask}. Raising bid to {offer} to signal constructive intent while holding margin."
                msg = f"I appreciate the counter. I can step up to {offer} {ctx.payment_ticker} given the guaranteed zero-counterparty-risk swap."

    else:  # seller
        current_bid = ctx.current_bid_usd or 95
        if ctx.round_number == 1:
            action, offer = "OFFER", ctx.current_ask_usd or 150
            thought = f"Establishing public ask at {offer} to anchor premium value for the whole lot. {counterparty_reliability_line(ctx)}".strip()
            msg = f"Offering lot of {ctx.asset_amount} {ctx.asset_ticker} at {offer} {ctx.payment_ticker}."
        elif final_round:
            if current_bid >= ctx.secret_limit_usd:
                action, offer = "ACCEPT", current_bid
                thought = f"Final round: Buyer bid of {current_bid} meets reserve {ctx.secret_limit_usd}. Sealing agreement."
                msg = f"Accepted at {offer} {ctx.payment_ticker} in final round."
            else:
                action, offer = "OFFER", ctx.secret_limit_usd
                thought = "Final round: Offering absolute reserve price as last chance."
                msg = f"Final firm ask is {offer} {ctx.payment_ticker}."
        else:
            offer = max((ctx.your_previous_offer_usd or ctx.current_ask_usd or 150) - 10, ctx.secret_limit_usd)
            if current_bid >= offer:
                action, offer = "ACCEPT", current_bid
                thought = f"Buyer bid {current_bid} satisfies minimum reserve. Accepting."
                msg = f"Agreed at {offer} {ctx.payment_ticker}. Locking terms."
            else:
                action = "OFFER"
                thought = f"Buyer is at {current_bid}. Narrowing spread to {offer} while staying above reserve."
                msg = f"My updated ask is {offer} {ctx.payment_ticker}."

    return {
        "private_thought": thought,
        "action": action,
        "offer_usd": offer,
        "public_message": msg,
    }

class QvacNegotiator:
    """Negotiation client coordinating local QVAC AI inference, mock fallback, and safety guards."""

    def __init__(self) -> None:
        self.base_url = settings.QVAC_BASE_URL
        self.api_key = settings.get_api_key()
        self.model = settings.QVAC_MODEL
        self.timeout = settings.QVAC_TIMEOUT
        self.use_mock = settings.QVAC_MOCK

    def generate_turn(self, ctx: NegotiationContext) -> NegotiationTurn:
        """Execute one negotiation round turn, validating through leak_guard and rationality_guard."""
        raw_result: Dict[str, Any] = {}

        if self.use_mock:
            raw_result = mock_negotiate(ctx)
        else:
            try:
                api_key = self.api_key or settings.get_api_key()
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}",
                }
                payload = {
                    "model": self.model,
                    "messages": [
                        {"role": "system", "content": build_system_prompt(ctx)},
                        {"role": "user", "content": build_user_prompt(ctx)},
                    ],
                    "temperature": 0.4,
                    # reasoning_budget: 0 to ensure fast inference and JSON private_thought
                    "reasoning_budget": 0,
                    "response_format": {"type": "json_object"},
                }
                url = f"{self.base_url.rstrip('/')}/chat/completions"
                resp = requests.post(url, json=payload, headers=headers, timeout=self.timeout)
                resp.raise_for_status()
                data = resp.json()
                content = data["choices"][0]["message"]["content"]
                raw_result = parse_llm_json_response(content)
            except Exception as exc:
                logger.warning(f"QVAC live call failed ({exc}). Falling back to internal mock.")
                raw_result = mock_negotiate(ctx)

        # 1. Extract values. A missing or unparseable offer must never default to the secret
        # limit (that would publish it as the offer): fall back to the mock turn instead.
        offer_candidate = coerce_offer_usd(raw_result.get("offer_usd"))
        if offer_candidate is None:
            logger.warning(f"Model returned no usable offer_usd ({raw_result.get('offer_usd')!r}); using the mock turn.")
            raw_result = mock_negotiate(ctx)
            offer_candidate = int(raw_result["offer_usd"])
        action_candidate = str(raw_result.get("action", "OFFER"))
        thought_candidate = str(raw_result.get("private_thought", "Strategic concession calculation."))
        # Only a string is a message: anything else would publish its Python form.
        message_candidate = raw_result.get("public_message")
        message_candidate = message_candidate if isinstance(message_candidate, str) else ""
        counterparty_offers = [t.offer_usd for t in ctx.history if t.speaker_wallet_id == ctx.counterparty_wallet_id]

        # 2. Run Rationality Guard (mathematical safety & boundary enforcement)
        guarded_action, guarded_offer = rationality_guard(
            role=ctx.role,
            raw_action=action_candidate,
            raw_offer_usd=offer_candidate,
            secret_limit_usd=ctx.secret_limit_usd,
            current_bid_usd=ctx.current_bid_usd,
            current_ask_usd=ctx.current_ask_usd,
            your_previous_offer_usd=ctx.your_previous_offer_usd,
            round_number=ctx.round_number,
            max_rounds=ctx.max_rounds,
            buyer_target_usd=ctx.buyer_target_usd if ctx.role == "buyer" else None,
            counterparty_previous_offer_usd=counterparty_offers[-2] if len(counterparty_offers) > 1 else None,
            pace=concession_pace(ctx.session_id, ctx.role, ctx.secret_limit_usd),
        )

        # 3. Run Leak Guard (privacy & secret limit protection). The model's own words are published
        # only when neither guard changed anything and they say what the move does; otherwise a
        # neutral message with the final offer.
        neutral = neutral_message(ctx, guarded_action, guarded_offer)
        _, public_message = leak_guard(message_candidate, ctx.secret_limit_usd, replacement=neutral)
        unchanged = (guarded_action, guarded_offer) == (action_candidate.strip().upper(), offer_candidate)
        if not (unchanged and public_message.strip() and says_its_move(public_message, guarded_action)):
            public_message = neutral

        return NegotiationTurn(
            speaker_wallet_id=ctx.wallet_id,
            speaker_label=ctx.wallet_label,
            action=guarded_action,
            offer_usd=guarded_offer,
            public_message=public_message,
            private_thought=thought_candidate,
            round_number=ctx.round_number,
        )

# Global negotiator instance
negotiator = QvacNegotiator()
