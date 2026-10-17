"""
MwM - Wallet State & Profile Manager
Maintains agent profiles, local address aliases, transaction activity, and balance history points.
Follows the exact contract defined in frontend/src/api/types.ts.
"""

import time
import uuid
import logging
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field

from backend.config import settings
from backend.market import market_manager

logger = logging.getLogger("mwm.wallet_state")

class AssetRef(BaseModel):
    model_config = {"populate_by_name": True, "protected_namespaces": ()}
    asset_id: str
    ticker: str
    schema_type: str = Field(default="NIA", alias="schema")
    precision: int

    def model_dump(self, *args, **kwargs) -> Dict[str, Any]:
        data = super().model_dump(*args, **kwargs)
        if "schema_type" in data:
            data["schema"] = data.pop("schema_type")
        return data

class AssetBalance(AssetRef):
    amount: int

class HistoryPoint(BaseModel):
    t: int
    balances: Dict[str, int]
    total_usd: float

class ActivityItem(BaseModel):
    id: str
    t: int
    kind: str  # "swap" | "receive" | "issue"
    direction: str  # "in" | "out"
    asset: AssetRef
    amount: int
    counterparty_address: Optional[str] = None
    txid: Optional[str] = None
    session_id: Optional[str] = None
    status: str = "confirmed"  # "pending" | "confirmed"

class AgentProfile(BaseModel):
    seller_active: bool
    offered_asset_id: Optional[str] = None
    offered_amount: int
    asking_price_usd: int
    secret_min_reserve_usd: int
    seller_ai_prompt: str
    buyer_max_ceiling_usd: int
    buyer_target_usd: int
    buyer_ai_prompt: str

class WalletState(BaseModel):
    wallet_id: str
    label: str
    address: str
    assets: List[AssetBalance]
    avg_cost_basis: Dict[str, Optional[float]]
    history_points: List[HistoryPoint]
    activity: List[ActivityItem]
    local_aliases: Dict[str, str]
    agent_profile: AgentProfile

class WalletStateManager:
    """In-memory coordinator for wallet states, profiles, and history."""

    def __init__(self) -> None:
        self._labels: Dict[str, str] = {
            "wallet_a": "Wallet A",
            "wallet_b": "Wallet B",
            "wallet_sybil": "Sybil",
        }
        self._addresses: Dict[str, str] = {}
        self._profiles: Dict[str, AgentProfile] = {}
        self._aliases: Dict[str, Dict[str, str]] = {}
        self._activities: Dict[str, List[ActivityItem]] = {}
        self._history: Dict[str, List[HistoryPoint]] = {}
        self._cost_basis: Dict[str, Dict[str, Optional[float]]] = {}
        self._seed_default_states()

    def _seed_default_states(self) -> None:
        now = int(time.time())
        seed_time = now - 3600

        # 1. Wallet A (Buyer in demo)
        self._profiles["wallet_a"] = AgentProfile(
            seller_active=False,
            offered_asset_id=None,
            offered_amount=0,
            asking_price_usd=150,
            secret_min_reserve_usd=110,
            seller_ai_prompt="",
            buyer_max_ceiling_usd=135,
            buyer_target_usd=100,
            buyer_ai_prompt="You are an autonomous buyer agent on Bitcoin regtest. Minimize acquisition cost of PEPE-RGB while closing efficiently.",
        )
        self._aliases["wallet_a"] = {}
        self._activities["wallet_a"] = []
        self._history["wallet_a"] = [
            HistoryPoint(
                t=seed_time,
                balances={"BTC": 100_000_000, "USDT": 10_000, "PEPE": 0},
                total_usd=10_000.0,
            )
        ]
        self._cost_basis["wallet_a"] = {"USDT": 1.0, "PEPE": None, "BTC": 100_000.0}

        # 2. Wallet B (Seller in demo)
        self._profiles["wallet_b"] = AgentProfile(
            seller_active=True,
            offered_asset_id=None,
            offered_amount=1_000_000,
            asking_price_usd=150,
            secret_min_reserve_usd=110,
            seller_ai_prompt="You are an autonomous seller agent on Bitcoin regtest. Protect liquidity and preserve margin above your 110 USD reserve.",
            buyer_max_ceiling_usd=140,
            buyer_target_usd=120,
            buyer_ai_prompt="",
        )
        self._aliases["wallet_b"] = {}
        self._activities["wallet_b"] = []
        self._history["wallet_b"] = [
            HistoryPoint(
                t=seed_time,
                balances={"BTC": 100_000_000, "PEPE": 1_000_000, "USDT": 0},
                total_usd=150.0,
            )
        ]
        self._cost_basis["wallet_b"] = {"USDT": 1.0, "PEPE": 0.00015, "BTC": 100_000.0}

        # 3. Wallet Sybil
        self._profiles["wallet_sybil"] = AgentProfile(
            seller_active=True,
            offered_asset_id=None,
            offered_amount=500_000,
            asking_price_usd=80,
            secret_min_reserve_usd=50,
            seller_ai_prompt="Cluster node agent.",
            buyer_max_ceiling_usd=90,
            buyer_target_usd=60,
            buyer_ai_prompt="",
        )
        self._aliases["wallet_sybil"] = {}
        self._activities["wallet_sybil"] = []
        self._history["wallet_sybil"] = [
            HistoryPoint(
                t=seed_time,
                balances={"BTC": 50_000_000, "PEPE": 0, "USDT": 0},
                total_usd=0.0,
            )
        ]
        self._cost_basis["wallet_sybil"] = {"USDT": 1.0, "PEPE": None, "BTC": 100_000.0}

    def register_wallet(self, wallet_id: str, label: str, address: str) -> None:
        self._labels[wallet_id] = label
        self._addresses[wallet_id] = address
        if wallet_id not in self._profiles:
            self._profiles[wallet_id] = AgentProfile(
                seller_active=False,
                offered_asset_id=None,
                offered_amount=0,
                asking_price_usd=100,
                secret_min_reserve_usd=80,
                seller_ai_prompt="",
                buyer_max_ceiling_usd=100,
                buyer_target_usd=80,
                buyer_ai_prompt="",
            )
        if wallet_id not in self._aliases:
            self._aliases[wallet_id] = {}
        if wallet_id not in self._activities:
            self._activities[wallet_id] = []
        if wallet_id not in self._history:
            self._history[wallet_id] = [
                HistoryPoint(t=int(time.time()), balances={"BTC": 0}, total_usd=0.0)
            ]
        if wallet_id not in self._cost_basis:
            self._cost_basis[wallet_id] = {"USDT": 1.0, "PEPE": None, "BTC": 100_000.0}

    def get_address_to_wallet_map(self) -> Dict[str, str]:
        """Map known addresses to wallet_ids."""
        return {addr: wid for wid, addr in self._addresses.items()}

    def get_wallet_by_address(self, address: str) -> Optional[str]:
        for wid, addr in self._addresses.items():
            if addr == address:
                return wid
        return None

    def get_profile(self, wallet_id: str) -> AgentProfile:
        if wallet_id not in self._profiles:
            self.register_wallet(wallet_id, f"Wallet {wallet_id[:8]}", "")
        return self._profiles[wallet_id]

    def update_profile(self, wallet_id: str, updates: Dict[str, Any]) -> AgentProfile:
        profile = self.get_profile(wallet_id)
        current_data = profile.model_dump()
        for k, v in updates.items():
            if k in current_data and v is not None:
                current_data[k] = v
        updated = AgentProfile(**current_data)
        self._profiles[wallet_id] = updated
        logger.info(f"Updated AgentProfile for {wallet_id}: {updates}")
        return updated

    def get_aliases(self, wallet_id: str) -> Dict[str, str]:
        return self._aliases.get(wallet_id, {})

    def set_alias(self, wallet_id: str, address: str, name: str) -> Dict[str, str]:
        if wallet_id not in self._aliases:
            self._aliases[wallet_id] = {}
        self._aliases[wallet_id][address] = name
        logger.info(f"Set alias for {wallet_id}: {address} -> {name}")
        return self._aliases[wallet_id]

    def record_swap_settlement(
        self,
        buyer_wallet_id: str,
        seller_wallet_id: str,
        session_id: str,
        txid: str,
        asset_id: str,
        asset_ticker: str,
        asset_amount: int,
        payment_asset_id: str,
        payment_ticker: str,
        payment_amount: int,
        agreed_price_usd: int,
    ) -> None:
        now = int(time.time())
        buyer_addr = self._addresses.get(buyer_wallet_id, "buyer_address")
        seller_addr = self._addresses.get(seller_wallet_id, "seller_address")

        pepe_ref = AssetRef(asset_id=asset_id, ticker=asset_ticker, schema="NIA", precision=0)
        usdt_ref = AssetRef(asset_id=payment_asset_id, ticker=payment_ticker, schema="NIA", precision=0)

        # 1. Activities for Buyer
        if buyer_wallet_id in self._activities:
            # Out USDT
            self._activities[buyer_wallet_id].insert(0, ActivityItem(
                id=f"act_{uuid.uuid4().hex[:8]}",
                t=now,
                kind="swap",
                direction="out",
                asset=usdt_ref,
                amount=payment_amount,
                counterparty_address=seller_addr,
                txid=txid,
                session_id=session_id,
                status="confirmed",
            ))
            # In PEPE
            self._activities[buyer_wallet_id].insert(0, ActivityItem(
                id=f"act_{uuid.uuid4().hex[:8]}",
                t=now,
                kind="swap",
                direction="in",
                asset=pepe_ref,
                amount=asset_amount,
                counterparty_address=seller_addr,
                txid=txid,
                session_id=session_id,
                status="confirmed",
            ))

        # 2. Activities for Seller
        if seller_wallet_id in self._activities:
            # Out PEPE
            self._activities[seller_wallet_id].insert(0, ActivityItem(
                id=f"act_{uuid.uuid4().hex[:8]}",
                t=now,
                kind="swap",
                direction="out",
                asset=pepe_ref,
                amount=asset_amount,
                counterparty_address=buyer_addr,
                txid=txid,
                session_id=session_id,
                status="confirmed",
            ))
            # In USDT
            self._activities[seller_wallet_id].insert(0, ActivityItem(
                id=f"act_{uuid.uuid4().hex[:8]}",
                t=now,
                kind="swap",
                direction="in",
                asset=usdt_ref,
                amount=payment_amount,
                counterparty_address=buyer_addr,
                txid=txid,
                session_id=session_id,
                status="confirmed",
            ))

        # 3. Update market price
        market_manager.record_settlement_price(agreed_price_usd)

        # 4. Update avg cost basis
        if buyer_wallet_id in self._cost_basis:
            self._cost_basis[buyer_wallet_id][asset_id] = float(agreed_price_usd)

    def assemble_wallet_state(self, wallet_id: str, balance_data: Dict[str, Any]) -> WalletState:
        address = balance_data.get("address", self._addresses.get(wallet_id, ""))
        label = self._labels.get(wallet_id, f"Wallet {wallet_id[:8]}")

        # Build assets list
        assets: List[AssetBalance] = []
        btc_sats = balance_data.get("btc_sats", 100_000_000)
        assets.append(AssetBalance(
            asset_id="BTC",
            ticker="BTC",
            schema="BTC",
            precision=8,
            amount=btc_sats,
        ))

        balances_map: Dict[str, int] = {"BTC": btc_sats}
        for nia in balance_data.get("assets", []):
            aid = nia["asset_id"]
            ticker = nia["ticker"]
            amt = nia["settled"]
            balances_map[aid] = amt
            balances_map[ticker] = amt
            assets.append(AssetBalance(
                asset_id=aid,
                ticker=ticker,
                schema="NIA",
                precision=0,
                amount=amt,
            ))

        # Update latest history point if needed
        now = int(time.time())
        history = list(self._history.get(wallet_id, []))
        total_usd = float(balances_map.get("USDT", 0))
        if market_manager.last_pepe_price_usd and balances_map.get("PEPE", 0) > 0:
            total_usd += market_manager.last_pepe_price_usd

        # Ensure at least one initial history point exists
        if not history:
            history.append(HistoryPoint(t=now - 3600, balances=balances_map, total_usd=total_usd))

        return WalletState(
            wallet_id=wallet_id,
            label=label,
            address=address,
            assets=assets,
            avg_cost_basis=self._cost_basis.get(wallet_id, {"USDT": 1.0, "PEPE": None}),
            history_points=history,
            activity=self._activities.get(wallet_id, []),
            local_aliases=self.get_aliases(wallet_id),
            agent_profile=self.get_profile(wallet_id),
        )

# Global singleton wallet state manager
wallet_state_manager = WalletStateManager()
