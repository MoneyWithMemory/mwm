"""
MwM - Market & Pricing Engine
Maintains current simulated market rates and dynamic P2P settlement prices.
- USDT-RGB pegged at 1.00 USD
- PEPE-RGB dynamically updated from the last settled P2P atomic swap (null before first trade)
- Fixed simulated sats_per_usd rate (settings.SATS_PER_USD) for every BTC valuation
"""

import json
import logging
import os
from pathlib import Path
from typing import Dict, List, Optional
from pydantic import BaseModel
from backend.config import settings

logger = logging.getLogger("mwm.market")

class AssetPrice(BaseModel):
    asset_id: str
    ticker: str
    precision: int = 0
    price_usd: Optional[float]
    source: str  # "fixed_peg" | "p2p_negotiation"

class MarketState(BaseModel):
    mode: str = "fixed_simulated"
    sats_per_usd: int
    assets: List[AssetPrice]

class MarketManager:
    def __init__(self, state_file: Optional[Path] = None) -> None:
        # The last settled PEPE price is kept on disk next to the wallets, so a backend restart
        # does not value everyone's PEPE at zero until the next trade (a full reset deletes it).
        self._state_file = state_file or Path(settings.MWM_DATA_DIR) / "market.json"
        self.last_pepe_price_usd: Optional[float] = self._load_price()
        self.pepe_asset_id: Optional[str] = None
        self.usdt_asset_id: Optional[str] = None

    def _load_price(self) -> Optional[float]:
        try:
            price = json.loads(self._state_file.read_text()).get("last_pepe_price_usd")
            return float(price) if price is not None else None
        except FileNotFoundError:
            return None
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            logger.warning(f"Ignoring an unreadable {self._state_file}: {exc}")
            return None

    def _save_price(self) -> None:
        try:
            self._state_file.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._state_file.with_suffix(".json.tmp")
            tmp.write_text(json.dumps({"last_pepe_price_usd": self.last_pepe_price_usd}))
            os.replace(tmp, self._state_file)
        except OSError as exc:
            logger.warning(f"Could not save the PEPE price to {self._state_file}: {exc}")

    @property
    def sats_per_usd(self) -> int:
        """The one BTC rate: the market shows it and every total_usd uses it."""
        return settings.SATS_PER_USD

    def set_asset_ids(self, pepe_id: str, usdt_id: str) -> None:
        self.pepe_asset_id = pepe_id
        self.usdt_asset_id = usdt_id

    def record_settlement_price(self, price_usd: float) -> None:
        """Update PEPE market price from a completed settlement, and keep it across restarts."""
        self.last_pepe_price_usd = float(price_usd)
        self._save_price()

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
