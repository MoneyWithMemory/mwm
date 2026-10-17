"""
MwM - Seed Identities & Initial State
Defines the seeded demo wallets and baseline parameters.

Rules:
- Seeded wallets: wallet_a ("Wallet A"), wallet_b ("Wallet B"), wallet_sybil ("Sybil")
- Zero usage of legacy names (Alice / Bob) in code, labels, or documentation.
"""

from typing import Dict, List
from pydantic import BaseModel, Field
from backend.config import settings
from backend.memory_graph import memory_graph

class SeedWalletInfo(BaseModel):
    wallet_id: str
    label: str
    role: str
    initial_btc_sats: int = 100_000_000  # 1.0 BTC on regtest for fees
    initial_assets: Dict[str, int] = Field(default_factory=dict)
    description: str

SEED_WALLETS: Dict[str, SeedWalletInfo] = {
    "wallet_a": SeedWalletInfo(
        wallet_id="wallet_a",
        label="Wallet A",
        role="buyer",
        initial_btc_sats=100_000_000,
        initial_assets={settings.PAYMENT_ASSET_TICKER: settings.PAYMENT_ASSET_SUPPLY},
        description="Buyer in primary demo. Liquid USDT balance, seeking to acquire PEPE-RGB.",
    ),
    "wallet_b": SeedWalletInfo(
        wallet_id="wallet_b",
        label="Wallet B",
        role="seller",
        initial_btc_sats=100_000_000,
        initial_assets={settings.DEMO_ASSET_TICKER: settings.DEMO_ASSET_SUPPLY},
        description="Seller in primary demo. Issuer/holder of 1,000,000 PEPE-RGB.",
    ),
    "wallet_sybil": SeedWalletInfo(
        wallet_id="wallet_sybil",
        label="Sybil",
        role="sybil",
        initial_btc_sats=50_000_000,
        initial_assets={},
        description="Malicious counterparty embedded in a wash-trading cluster. Trigger for BLOCKED_BY_GATE.",
    ),
}

def init_seed_state() -> List[SeedWalletInfo]:
    """Ensure all seed wallets are registered into the memory graph."""
    for info in SEED_WALLETS.values():
        memory_graph.register_wallet(info.wallet_id, info.label)
    return list(SEED_WALLETS.values())

def get_seed_wallet(wallet_id: str) -> SeedWalletInfo:
    """Retrieve seed info or raise KeyError."""
    return SEED_WALLETS[wallet_id]
