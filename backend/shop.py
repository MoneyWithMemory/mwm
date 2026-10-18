"""
MwM - Shop requests ("want" listings)
Sell listings are the live Seller Desks and are built from the agent profiles in the API layer;
this module only keeps the open requests, in memory like sessions.
"""

import time
import uuid
import threading
from typing import Dict, List, Optional

from pydantic import BaseModel

# External requester of the seeded demo request (same address as the frontend mock fixtures).
NEWCOMER_ADDRESS = "bcrt1q88zjdd99fcucelza8delz78jt89j4kscdp5cva"


class Want(BaseModel):
    want_id: str
    # Wallets rotate addresses on restart, so wallet-owned requests resolve the address at read time.
    owner_wallet_id: Optional[str] = None
    owner_address: Optional[str] = None
    asset_id: str
    amount: int
    target_usd: float
    note: Optional[str] = None
    created_at: int
    closed: bool = False


class ShopStore:
    """Thread-safe in-memory store of open Shop requests."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._wants: Dict[str, Want] = {}

    def create_want(
        self,
        asset_id: str,
        amount: int,
        target_usd: float,
        note: Optional[str] = None,
        owner_wallet_id: Optional[str] = None,
        owner_address: Optional[str] = None,
        created_at: Optional[int] = None,
        want_id: Optional[str] = None,
    ) -> Want:
        want = Want(
            want_id=want_id or f"want_{uuid.uuid4().hex[:8]}",
            owner_wallet_id=owner_wallet_id,
            owner_address=owner_address,
            asset_id=asset_id,
            amount=amount,
            target_usd=target_usd,
            note=(note or "").strip()[:140] or None,
            created_at=created_at if created_at is not None else int(time.time()),
        )
        with self._lock:
            self._wants[want.want_id] = want
        return want

    def get(self, want_id: str) -> Optional[Want]:
        with self._lock:
            return self._wants.get(want_id)

    def close(self, want_id: str) -> Want:
        with self._lock:
            want = self._wants[want_id]
            want.closed = True
            return want

    def list_open(self) -> List[Want]:
        with self._lock:
            wants = [w for w in self._wants.values() if not w.closed]
        return sorted(wants, key=lambda w: w.created_at, reverse=True)

    def seed_demo_wants(self, pepe_asset_id: str) -> None:
        """The two open requests of the frontend mock: one external, one from Wallet A."""
        now = int(time.time())
        self.create_want(
            want_id="want_seed_1",
            owner_address=NEWCOMER_ADDRESS,
            asset_id=pepe_asset_id,
            amount=250_000,
            target_usd=55,
            note="Looking for a clean lot. Can pay in USDT today.",
            created_at=now - 5 * 3600,
        )
        self.create_want(
            want_id="want_seed_2",
            owner_wallet_id="wallet_a",
            asset_id=pepe_asset_id,
            amount=500_000,
            target_usd=70,
            note="A smaller lot is fine too.",
            created_at=now - 26 * 3600,
        )


# Global shop store instance
shop_store = ShopStore()
