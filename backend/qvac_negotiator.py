"""
MwM - QVAC Local AI Negotiator Engine
Provides game-theoretic autonomous negotiation between Wallet A (Buyer) and Wallet B (Seller).

Features:
1. OpenAI-compatible client targeting local QVAC (Qwen 4B/8B) with 120s timeout.
2. Intelligent mock fallback (QVAC_MOCK=1 or offline resilience).
3. Leak Guard: regex-based integer detection ensuring secrets (budget/reserve) are never exposed.
4. Rationality Guard: strictly guarantees bid/ask convergence within secret boundaries.
5. Structured JSON output with separate private_thought and public_message.
6. Zero usage of legacy names (Alice/Bob).
"""

import json
import re
import logging
import requests
from typing import Any, Dict, List, Optional, Tuple
from pydantic import BaseModel, Field
from backend.config import settings

logger = logging.getLogger("mwm.qvac")

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
    round_number: int  # 1 to 4
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

def leak_guard(public_message: str, secret_limit_usd: int) -> Tuple[bool, str]:
    """
    Check if public_message reveals the exact secret integer or critical sensitive phrases.
    Uses regex word boundaries to examine standalone integer numbers.
    Returns (has_leak, sanitized_message).
    """
    # Look for integer numbers in the text
    integers_found = [int(num) for num in re.findall(r"\b\d+\b", public_message)]
    has_leak = secret_limit_usd in integers_found

    # Check for sensitive phrasing
    lower = public_message.lower()
    suspicious_phrases = ["my reserve is", "my budget is", "secret reserve", "secret budget", "my maximum is", "my minimum is"]
    if any(phrase in lower for phrase in suspicious_phrases):
        has_leak = True

    if has_leak:
        logger.warning(f"LeakGuard triggered: secret {secret_limit_usd} or sensitive phrase found in '{public_message}'. Redacting.")
        # Replace with safe generic tactical statement
        sanitized = re.sub(rf"\b{secret_limit_usd}\b", "[REDACTED]", public_message)
        return True, "I propose an adjusted counter-valuation based on current liquidity and instant on-chain settlement."

    return False, public_message

def rationality_guard(
    role: str,
    raw_action: str,
    raw_offer_usd: int,
    secret_limit_usd: int,
    current_bid_usd: Optional[int],
    current_ask_usd: Optional[int],
    your_previous_offer_usd: Optional[int],
    round_number: int,
) -> Tuple[str, int]:
    """
    Enforces game-theoretic rationality and inviolable mathematical bounds:
    - Buyer never bids > max_budget; bids must be monotonic non-decreasing; if bid >= current_ask -> ACCEPT.
    - Seller never asks < min_reserve; asks must be monotonic non-increasing; if ask <= current_bid -> ACCEPT.
    - Intermediate rounds (1-3) cannot REJECT; only OFFER or ACCEPT.
    """
    action = raw_action.upper()
    if action not in ("OFFER", "ACCEPT"):
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

        # Deal zone check: if seller ask meets or is below current bid, accept bid
        if current_bid_usd is not None and offer <= current_bid_usd:
            action = "ACCEPT"
            offer = current_bid_usd

    return action, offer

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

def build_system_prompt(ctx: NegotiationContext) -> str:
    """Generate professional, game-theoretic tactical instructions for local AI."""
    role_desc = "Buyer" if ctx.role == "buyer" else "Seller"
    target_usd = ctx.buyer_target_usd or 120
    action_goal = (
        f"You want to buy {ctx.asset_amount} {ctx.asset_ticker} paying in {ctx.payment_ticker}. "
        f"Your target valuation is {target_usd} {ctx.payment_ticker}. "
        f"Your CONFIDENTIAL CEILING (absolute maximum budget) is {ctx.secret_limit_usd} {ctx.payment_ticker}. NEVER EXCEED IT."
        if ctx.role == "buyer"
        else f"You are selling {ctx.asset_amount} {ctx.asset_ticker} for {ctx.payment_ticker}. "
        f"Your asking price is {ctx.current_ask_usd or 150} {ctx.payment_ticker}. "
        f"Your CONFIDENTIAL RESERVE (absolute minimum price) is {ctx.secret_limit_usd} {ctx.payment_ticker}. NEVER GO BELOW IT."
    )

    return f"""You are {ctx.wallet_label}, an elite autonomous trading agent executing an on-chain RGB peer-to-peer swap.
Role: {role_desc}.
Counterparty: {ctx.counterparty_label}.
Traded Asset: {ctx.asset_amount} {ctx.asset_ticker}.
Payment Asset: {ctx.payment_ticker} (atomic on-chain settlement).
Goal: {action_goal}

CRITICAL RULES:
1. Confidentiality: NEVER disclose your secret budget/reserve limit to the counterparty in your public_message.
2. Strategy: This is Round {ctx.round_number} of 4.
   - For Buyer:
     * Round 1: Open near your target valuation ({target_usd} {ctx.payment_ticker}, e.g. {max(target_usd - 10, 100)} to {target_usd}). NEVER open at your ceiling {ctx.secret_limit_usd}!
     * Round 2-3: Make small, calibrated concessions (e.g. +5 to +10) towards agreement while protecting margin below ceiling {ctx.secret_limit_usd}.
     * Round 4: Final round. Offer up to ceiling {ctx.secret_limit_usd}, or ACCEPT if seller ask is <= {ctx.secret_limit_usd}.
   - For Seller:
     * Round 1: Open near your asking price (e.g. 145-150 {ctx.payment_ticker}).
     * Round 2-3: Concede gradually down towards reserve {ctx.secret_limit_usd}.
     * Round 4: Final round. Offer final price >= reserve {ctx.secret_limit_usd}, or ACCEPT if buyer bid >= {ctx.secret_limit_usd}.
3. You must output ONLY a valid JSON object matching this exact structure:
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

    return f"""Current Round: {ctx.round_number} / 4.
Current Market Spread:
- Current Buyer Bid: {ctx.current_bid_usd if ctx.current_bid_usd is not None else 'None'} {ctx.payment_ticker}
- Current Seller Ask: {ctx.current_ask_usd if ctx.current_ask_usd is not None else 'None'} {ctx.payment_ticker}
- Your Previous Offer: {ctx.your_previous_offer_usd if ctx.your_previous_offer_usd is not None else 'None'} {ctx.payment_ticker}

Negotiation History:
{history_str}

Evaluate the state, formulate your private tactical thought, and output your JSON response:"""

def mock_negotiate(ctx: NegotiationContext) -> Dict[str, Any]:
    """
    Intelligent simulated negotiation generator.
    Produces highly realistic, tactical turns for development and tests without requiring a running QVAC daemon.
    """
    if ctx.role == "buyer":
        target = ctx.buyer_target_usd or 120
        open_bid = max(target - 10, 100)
        base_bid = ctx.your_previous_offer_usd or open_bid
        current_ask = ctx.current_ask_usd or 150

        if ctx.round_number == 1:
            offer = open_bid
            thought = f"Opening near target valuation ({target} USD) to anchor the spread conservatively."
            msg = f"Considering secondary market depth, I open with {offer} {ctx.payment_ticker} for immediate atomic settlement."
            action = "OFFER"
        elif ctx.round_number == 2:
            offer = min(base_bid + 10, ctx.secret_limit_usd)
            thought = f"Seller countered at {current_ask}. Raising bid to {offer} to signal constructive intent while holding margin."
            msg = f"I appreciate the counter. I can step up to {offer} {ctx.payment_ticker} given the guaranteed zero-counterparty-risk swap."
            action = "OFFER"
        elif ctx.round_number == 3:
            offer = min(base_bid + 5, ctx.secret_limit_usd)
            if current_ask is not None and offer >= current_ask and current_ask <= ctx.secret_limit_usd:
                action = "ACCEPT"
                offer = current_ask
                thought = f"Seller's ask of {current_ask} is within budget. Executing agreement."
                msg = f"Your ask of {current_ask} {ctx.payment_ticker} is acceptable. Let's proceed to cryptographic signatures."
            else:
                action = "OFFER"
                thought = f"Approaching ceiling limit. Pushing to {offer} as an aggressive closing anchor."
                msg = f"I can offer {offer} {ctx.payment_ticker}. This represents fair value for an illiquid lot."
        else:
            # Round 4: closing
            if current_ask is not None and current_ask <= ctx.secret_limit_usd:
                action = "ACCEPT"
                offer = current_ask
                thought = f"Final round: Seller ask {current_ask} is within ceiling {ctx.secret_limit_usd}. Accepting to avoid breakdown."
                msg = f"Final round agreement confirmed at {offer} {ctx.payment_ticker}."
            else:
                action = "OFFER"
                offer = ctx.secret_limit_usd
                thought = "Final round: Pushing to absolute budget ceiling as take-it-or-leave-it."
                msg = f"This is my final best offer: {offer} {ctx.payment_ticker}."

    else:  # seller
        # Seller: starts ~150, moves down towards reserve 110
        base_ask = ctx.your_previous_offer_usd or 150
        current_bid = ctx.current_bid_usd or 95

        if ctx.round_number == 1:
            offer = 150
            thought = "Establishing public ask at 150 to anchor premium value for the whole lot."
            msg = f"Offering lot of {ctx.asset_amount} {ctx.asset_ticker} at {offer} {ctx.payment_ticker}."
            action = "OFFER"
        elif ctx.round_number == 2:
            offer = max(base_ask - 15, ctx.secret_limit_usd)
            thought = f"Buyer opened at {current_bid}. Conceding down to {offer} to encourage rapid deal closure."
            msg = f"I am willing to meet partway at {offer} {ctx.payment_ticker} for a clean transaction."
            action = "OFFER"
        elif ctx.round_number == 3:
            offer = max(base_ask - 10, ctx.secret_limit_usd)
            if current_bid >= offer:
                action = "ACCEPT"
                offer = current_bid
                thought = f"Buyer bid {current_bid} satisfies minimum reserve. Accepting."
                msg = f"Agreed at {offer} {ctx.payment_ticker}. Locking terms."
            else:
                action = "OFFER"
                thought = f"Narrowing spread to {offer}. Staying safely above reserve {ctx.secret_limit_usd}."
                msg = f"My updated ask is {offer} {ctx.payment_ticker}."
        else:
            # Round 4
            if current_bid >= ctx.secret_limit_usd:
                action = "ACCEPT"
                offer = current_bid
                thought = f"Final round: Buyer bid of {current_bid} exceeds reserve {ctx.secret_limit_usd}. Sealing agreement."
                msg = f"Accepted at {offer} {ctx.payment_ticker} in final round."
            else:
                action = "OFFER"
                offer = ctx.secret_limit_usd
                thought = "Final round: Offering absolute reserve price as last chance."
                msg = f"Final firm ask is {offer} {ctx.payment_ticker}."

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

        # 1. Extract values with fallbacks
        action_candidate = str(raw_result.get("action", "OFFER"))
        offer_candidate = int(raw_result.get("offer_usd", ctx.secret_limit_usd))
        thought_candidate = str(raw_result.get("private_thought", "Strategic concession calculation."))
        message_candidate = str(raw_result.get("public_message", f"I propose {offer_candidate} {ctx.payment_ticker}."))

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
        )

        # 3. Run Leak Guard (privacy & secret integer protection)
        _, sanitized_message = leak_guard(message_candidate, ctx.secret_limit_usd)

        return NegotiationTurn(
            speaker_wallet_id=ctx.wallet_id,
            speaker_label=ctx.wallet_label,
            action=guarded_action,
            offer_usd=guarded_offer,
            public_message=sanitized_message,
            private_thought=thought_candidate,
            round_number=ctx.round_number,
        )

# Global negotiator instance
negotiator = QvacNegotiator()
