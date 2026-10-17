"""
MwM - Deterministic Pre-Signing Gate
Enforces strict pre-signature checks before any cryptographic or on-chain settlement:
1. Counterparty trust & wash-trading ring anomaly check
2. Secret limit enforcement (buyer ceiling, seller reserve)
3. Positive integer validation
4. Canonical SHA-256 terms_hash generation
"""

import json
import hashlib
from typing import Any, Dict, Optional
from pydantic import BaseModel
from backend.memory_graph import memory_graph, TrustTier

class GateResult(BaseModel):
    passed: bool
    reason: Optional[str] = None
    block_state: Optional[str] = None  # e.g., "BLOCKED_BY_GATE"
    terms: Optional[Dict[str, Any]] = None
    terms_hash: Optional[str] = None

def compute_terms_hash(terms: Dict[str, Any]) -> str:
    """
    Compute canonical SHA-256 hash of agreed terms.
    Must use sorted keys and compact separators to ensure cross-agent deterministic consistency.
    """
    canonical_json = json.dumps(terms, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()

def evaluate_gate(
    buyer_wallet_id: str,
    seller_wallet_id: str,
    active_signer_wallet_id: str,
    agreed_price_usd: int,
    asset_ticker: str,
    asset_amount: int,
    payment_ticker: str,
    payment_amount: int,
    buyer_max_budget_usd: Optional[int] = None,
    seller_min_reserve_usd: Optional[int] = None,
    counterparty_wallet_id: Optional[str] = None,
) -> GateResult:
    """
    Evaluate deterministic safety gate for a proposed agreement.
    Returns GateResult with passed=True and terms_hash if all checks hold.
    """
    # 1. Counterparty Trust Check
    target_peer = counterparty_wallet_id or (
        seller_wallet_id if active_signer_wallet_id == buyer_wallet_id else buyer_wallet_id
    )
    reputation = memory_graph.get_reputation(target_peer)
    if reputation.trust_tier == TrustTier.RING_ANOMALY:
        return GateResult(
            passed=False,
            reason=f"Gate blocked: counterparty {target_peer} is flagged with {TrustTier.RING_ANOMALY}",
            block_state="BLOCKED_BY_GATE",
        )

    # 2. Positive Integer Checks
    if not isinstance(agreed_price_usd, int) or agreed_price_usd <= 0:
        return GateResult(
            passed=False,
            reason="Gate blocked: agreed price must be a strictly positive integer",
            block_state="BLOCKED_BY_GATE",
        )
    if not isinstance(asset_amount, int) or asset_amount <= 0:
        return GateResult(
            passed=False,
            reason="Gate blocked: asset amount must be a strictly positive integer",
            block_state="BLOCKED_BY_GATE",
        )
    if not isinstance(payment_amount, int) or payment_amount <= 0:
        return GateResult(
            passed=False,
            reason="Gate blocked: payment amount must be a strictly positive integer",
            block_state="BLOCKED_BY_GATE",
        )

    # 3. Secret Limit Checks
    if buyer_max_budget_usd is not None and agreed_price_usd > buyer_max_budget_usd:
        return GateResult(
            passed=False,
            reason="Gate blocked: agreed price exceeds buyer secret ceiling",
            block_state="BLOCKED_BY_GATE",
        )
    if seller_min_reserve_usd is not None and agreed_price_usd < seller_min_reserve_usd:
        return GateResult(
            passed=False,
            reason="Gate blocked: agreed price is below seller secret reserve",
            block_state="BLOCKED_BY_GATE",
        )

    # 4. Form canonical terms and calculate terms_hash
    terms: Dict[str, Any] = {
        "asset_amount": asset_amount,
        "asset_ticker": asset_ticker,
        "buyer_wallet_id": buyer_wallet_id,
        "payment_amount": payment_amount,
        "payment_ticker": payment_ticker,
        "price_usd": agreed_price_usd,
        "seller_wallet_id": seller_wallet_id,
    }
    terms_hash = compute_terms_hash(terms)

    return GateResult(
        passed=True,
        reason="Deterministic gate criteria verified successfully",
        terms=terms,
        terms_hash=terms_hash,
    )
