"""
MwM - Deterministic Pre-Signing Gate & Canonical Swap Terms
Enforces strict pre-signature checks before any cryptographic or on-chain settlement:
1. Counterparty trust & wash-trading ring anomaly check
2. Secret limit enforcement (buyer ceiling, seller reserve)
3. Positive integer validation
4. Canonical SHA-256 terms_hash generation matching Drop 1 contract
"""

import json
import hashlib
from typing import Any, Dict, Optional, Union
from pydantic import BaseModel, Field
from backend.memory_graph import memory_graph, TrustTier

class CanonicalSwapTerms(BaseModel):
    session_id: str
    asset_id: str
    rgb_amount: int
    payment_asset_id: str
    payment_amount: int
    agreed_price_usd: int
    network_fee_sat: int
    buyer_address: str
    seller_address: str
    expiry_unix: int

class GateResult(BaseModel):
    passed: bool
    reason: Optional[str] = None
    block_state: Optional[str] = None  # e.g., "BLOCKED_BY_GATE"
    terms: Optional[Dict[str, Any]] = None
    terms_hash: Optional[str] = None

def compute_terms_hash(terms: Union[CanonicalSwapTerms, Dict[str, Any]]) -> str:
    """
    Compute canonical SHA-256 hash of agreed terms.
    Must use sorted keys and compact separators (',', ':') to ensure cross-agent deterministic consistency.
    """
    raw_dict = terms.model_dump() if isinstance(terms, CanonicalSwapTerms) else dict(terms)
    canonical_json = json.dumps(raw_dict, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical_json.encode("utf-8")).hexdigest()

def evaluate_gate(
    session_id: str,
    asset_id: str,
    rgb_amount: int,
    payment_asset_id: str,
    payment_amount: int,
    agreed_price_usd: int,
    network_fee_sat: int,
    buyer_address: str,
    seller_address: str,
    expiry_unix: int,
    active_signer_address: str,
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
        seller_address if active_signer_address == buyer_address else buyer_address
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
    if not isinstance(rgb_amount, int) or rgb_amount <= 0:
        return GateResult(
            passed=False,
            reason="Gate blocked: rgb_amount must be a strictly positive integer",
            block_state="BLOCKED_BY_GATE",
        )
    if not isinstance(payment_amount, int) or payment_amount <= 0:
        return GateResult(
            passed=False,
            reason="Gate blocked: payment_amount must be a strictly positive integer",
            block_state="BLOCKED_BY_GATE",
        )
    if not isinstance(network_fee_sat, int) or network_fee_sat <= 0:
        return GateResult(
            passed=False,
            reason="Gate blocked: network_fee_sat must be a strictly positive integer",
            block_state="BLOCKED_BY_GATE",
        )
    if not isinstance(expiry_unix, int) or expiry_unix <= 0:
        return GateResult(
            passed=False,
            reason="Gate blocked: expiry_unix must be a strictly positive integer timestamp",
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
    canonical_terms = CanonicalSwapTerms(
        session_id=session_id,
        asset_id=asset_id,
        rgb_amount=rgb_amount,
        payment_asset_id=payment_asset_id,
        payment_amount=payment_amount,
        agreed_price_usd=agreed_price_usd,
        network_fee_sat=network_fee_sat,
        buyer_address=buyer_address,
        seller_address=seller_address,
        expiry_unix=expiry_unix,
    )
    terms_dict = canonical_terms.model_dump()
    terms_hash = compute_terms_hash(canonical_terms)

    return GateResult(
        passed=True,
        reason="Deterministic gate criteria verified successfully",
        terms=terms_dict,
        terms_hash=terms_hash,
    )
