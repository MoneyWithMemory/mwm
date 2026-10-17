"""
MwM (Money with Memory) - Backend Configuration
All settings loaded from environment variables with safe defaults.
Zero hardcoded personal paths.
"""

import os
from pathlib import Path
from typing import Optional
from pydantic import BaseModel, Field

# Root repository directory
REPO_ROOT = Path(__file__).resolve().parent.parent

class Settings(BaseModel):
    # Network & External Services
    API_HOST: str = Field(default_factory=lambda: os.getenv("API_HOST", "0.0.0.0"))
    API_PORT: int = Field(default_factory=lambda: int(os.getenv("API_PORT", "8000")))

    # QVAC Local AI Inference
    QVAC_BASE_URL: str = Field(default_factory=lambda: os.getenv("QVAC_BASE_URL", "http://192.168.7.184:11435/v1"))
    QVAC_API_KEY: str = Field(default_factory=lambda: os.getenv("QVAC_API_KEY", ""))
    QVAC_MODEL: str = Field(default_factory=lambda: os.getenv("QVAC_MODEL", "buyer-agent"))
    QVAC_TIMEOUT: int = Field(default_factory=lambda: int(os.getenv("QVAC_TIMEOUT", "120")))
    QVAC_MOCK: bool = Field(default_factory=lambda: os.getenv("QVAC_MOCK", "0").lower() in ("1", "true", "yes"))

    # Regtest & Bitcoin / Electrs
    REGTEST_SCRIPT: str = Field(
        default_factory=lambda: os.getenv("REGTEST_SCRIPT", str(REPO_ROOT / "scripts" / "regtest.sh"))
    )
    ELECTRUM_URL: str = Field(default_factory=lambda: os.getenv("ELECTRUM_URL", "127.0.0.1:50001"))
    PROXY_URL: str = Field(default_factory=lambda: os.getenv("PROXY_URL", "http://127.0.0.1:3000/json-rpc"))

    # Storage & Persistence
    MWM_DATA_DIR: str = Field(
        default_factory=lambda: os.getenv("MWM_DATA_DIR", str(Path.home() / ".mwm" / "data"))
    )

    # Market Simulation (1 sat = 0.001 USD -> 1 BTC = $100,000)
    SATS_PER_USD: int = Field(default_factory=lambda: int(os.getenv("SATS_PER_USD", "1000")))

    # Demo Assets (PEPE-RGB NIA <-> USDT-RGB NIA)
    DEMO_ASSET_TICKER: str = "PEPE"
    DEMO_ASSET_NAME: str = "Pepe RGB"
    DEMO_ASSET_SUPPLY: int = 1_000_000
    DEMO_ASSET_PRECISION: int = 0
    DEMO_ASSET_ID: Optional[str] = None

    PAYMENT_ASSET_TICKER: str = "USDT"
    PAYMENT_ASSET_NAME: str = "Tether USD Test"
    PAYMENT_ASSET_SUPPLY: int = 10_000
    PAYMENT_ASSET_PRECISION: int = 0
    PAYMENT_ASSET_ID: Optional[str] = None

    # Demo Target Economy
    DEMO_SELLER_ASK_USD: int = 150
    DEMO_SELLER_MIN_RESERVE_USD: int = 110
    DEMO_BUYER_MAX_BUDGET_USD: int = 135
    DEMO_BUYER_INITIAL_BID_USD: int = 95

    def get_api_key(self) -> str:
        """Retrieve QVAC key from env or fallback to ~/.mwm/qvac.key if present."""
        if self.QVAC_API_KEY:
            return self.QVAC_API_KEY
        key_path = Path.home() / ".mwm" / "qvac.key"
        if key_path.exists():
            try:
                return key_path.read_text().strip()
            except Exception:
                pass
        return ""

    def ensure_data_dir(self) -> Path:
        """Ensure MWM_DATA_DIR exists and return Path object."""
        path = Path(self.MWM_DATA_DIR)
        path.mkdir(parents=True, exist_ok=True)
        return path

settings = Settings()
