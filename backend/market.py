"""
MwM - Market & Pricing Engine
Maintains current simulated market rates and dynamic P2P settlement prices.
- USDT-RGB pegged at 1.00 USD
- PEPE-RGB dynamically updated from the last settled P2P atomic swap (null before first trade)
- Fixed simulated sats_per_usd rate for Bitcoin fee calculation
"""

from typing import Dict, List, Optional
from pydantic import BaseModel
from backend.config import settings

class AssetPrice(BaseModel):
    asset_id: str
    ticker: str
    precision: int = 0
    price_usd: Optional[float]
    source: str  # "fixed_peg" | "p2p_negotiation"

class MarketState(BaseModel):
    mode: str = "fixed_simulated"
    sats_per_usd: int = 1_000
    assets: List[AssetPrice]

class MarketManager:
    def __init__(self) -> None:
        self.sats_per_usd = 1_000
        self.last_pepe_price_usd: Optional[float] = None
        self.pepe_asset_id: Optional[str] = None
        self.usdt_asset_id: Optional[str] = None

    def set_asset_ids(self, pepe_id: str, usdt_id: str) -> None:
        self.pepe_asset_id = pepe_id
        self.usdt_asset_id = usdt_id

    def record_settlement_price(self, price_usd: float) -> None:
        """Update PEPE market price from a completed settlement."""
        self.last_pepe_price_usd = round(float(price_usd), 4)

    def get_market(self) -> MarketState:
        pepe_id = self.pepe_asset_id or settings.DEMO_ASSET_ID or "rgb:pepe_nia"
        usdt_id = self.usdt_asset_id or settings.PAYMENT_ASSET_ID or "rgb:usdt_nia"

        return MarketState(
            mode="fixed_simulated",
            sats_per_usd=self.sats_per_usd,
            assets=[
                AssetPrice(
                    asset_id=usdt_id,
                    ticker=settings.PAYMENT_ASSET_TICKER,
                    precision=0,
                    price_usd=1.0,
                    source="fixed_peg",
                ),
                AssetPrice(
                    asset_id=pepe_id,
                    ticker=settings.DEMO_ASSET_TICKER,
                    precision=0,
                    price_usd=self.last_pepe_price_usd,
                    source="p2p_negotiation",
                ),
            ],
        )

# Global market manager singleton
market_manager = MarketManager()
