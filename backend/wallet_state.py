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
    schema_type: str = Field(default="NIA", serialization_alias="schema", alias="schema")
    precision: int

    def model_dump(self, *args, **kwargs) -> Dict[str, Any]:
        kwargs.setdefault("by_alias", True)
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

class PublicDesk(BaseModel):
    asset: AssetRef
    offered_amount: int
    asking_price_usd: int

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

    def model_dump(self, *args, **kwargs) -> Dict[str, Any]:
        kwargs.setdefault("by_alias", True)
        return super().model_dump(*args, **kwargs)

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
            buyer_target_usd=120,
            buyer_ai_prompt="You are an autonomous buyer agent on Bitcoin regtest. Minimize acquisition cost of PEPE-RGB while closing efficiently.",
        )
        self._aliases["wallet_a"] = {}
        self._activities["wallet_a"] = []
        self._history["wallet_a"] = [
            HistoryPoint(
                t=seed_time,
                balances={"btc": 100_000_000, "rgb:usdt_nia": 10_000, "rgb:pepe_nia": 0},
                total_usd=10_000.0,
            )
        ]
        self._cost_basis["wallet_a"] = {"btc": None, "rgb:usdt_nia": 1.0, "rgb:pepe_nia": None}

        # 2. Wallet B (Seller in demo)
        self._profiles["wallet_b"] = AgentProfile(
            seller_active=True,
            offered_asset_id=settings.DEMO_ASSET_ID or "rgb:pepe_nia",
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
                balances={"btc": 100_000_000, "rgb:pepe_nia": 1_000_000, "rgb:usdt_nia": 0},
                total_usd=0.0,
            )
        ]
        self._cost_basis["wallet_b"] = {"btc": None, "rgb:usdt_nia": 1.0, "rgb:pepe_nia": None}

        # 3. Wallet Sybil
        self._profiles["wallet_sybil"] = AgentProfile(
            seller_active=True,
            offered_asset_id=settings.DEMO_ASSET_ID or "rgb:pepe_nia",
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
                balances={"btc": 50_000_000, "rgb:pepe_nia": 0, "rgb:usdt_nia": 0},
                total_usd=0.0,
            )
        ]
        self._cost_basis["wallet_sybil"] = {"btc": None, "rgb:usdt_nia": 1.0, "rgb:pepe_nia": None}

    def sync_demo_assets(self, pepe_id: str, usdt_id: str) -> None:
        """Update demo asset IDs across profiles, cost basis, and history."""
        self._profiles["wallet_b"].offered_asset_id = pepe_id
        self._profiles["wallet_sybil"].offered_asset_id = pepe_id

        # Update initial seed points with real asset IDs and BTC valuation at sats_per_usd
        sats_per_usd = settings.SATS_PER_USD or 1000
        self._history["wallet_a"] = [
            HistoryPoint(
                t=int(time.time()) - 3600,
                balances={"btc": 100_000_000, usdt_id: 10_000, pepe_id: 0},
                total_usd=round(100_000_000 / sats_per_usd + 10_000.0, 2),
            )
        ]
        self._cost_basis["wallet_a"] = {"btc": None, usdt_id: 1.0, pepe_id: None}

        self._history["wallet_b"] = [
            HistoryPoint(
                t=int(time.time()) - 3600,
                balances={"btc": 100_000_000, pepe_id: 1_000_000, usdt_id: 0},
                total_usd=round(100_000_000 / sats_per_usd + 0.0, 2),
            )
        ]
        self._cost_basis["wallet_b"] = {"btc": None, usdt_id: 1.0, pepe_id: None}

        self._history["wallet_sybil"] = [
            HistoryPoint(
                t=int(time.time()) - 3600,
                balances={"btc": 50_000_000, pepe_id: 0, usdt_id: 0},
                total_usd=round(50_000_000 / sats_per_usd + 0.0, 2),
            )
        ]
        self._cost_basis["wallet_sybil"] = {"btc": None, usdt_id: 1.0, pepe_id: None}

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
                HistoryPoint(t=int(time.time()), balances={"btc": 0}, total_usd=0.0)
            ]
        if wallet_id not in self._cost_basis:
            self._cost_basis[wallet_id] = {"btc": None}

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

        # 3. Update market price with unit price (agreed / lot)
        unit_pepe_price = float(agreed_price_usd) / (float(asset_amount) / (10 ** 0))
        market_manager.record_settlement_price(unit_pepe_price)

        # 4. Update avg cost basis
        if buyer_wallet_id not in self._cost_basis:
            self._cost_basis[buyer_wallet_id] = {}
        self._cost_basis[buyer_wallet_id][asset_id] = unit_pepe_price

        # 5. Append new HistoryPoint for Buyer and Seller
        sats_per_usd = settings.SATS_PER_USD or 1000

        # Buyer history point
        if buyer_wallet_id in self._history and self._history[buyer_wallet_id]:
            prev_hp = self._history[buyer_wallet_id][-1]
            b_balances = dict(prev_hp.balances)
            b_balances["btc"] = b_balances.get("btc", 100_000_000)
            b_balances[payment_asset_id] = max(0, b_balances.get(payment_asset_id, 0) - payment_amount)
            b_balances[asset_id] = b_balances.get(asset_id, 0) + asset_amount
            btc_usd = float(b_balances["btc"]) / float(sats_per_usd)
            usdt_usd = float(b_balances.get(payment_asset_id, 0))
            pepe_usd = float(b_balances.get(asset_id, 0)) * unit_pepe_price
            self._history[buyer_wallet_id].append(HistoryPoint(
                t=now,
                balances=b_balances,
                total_usd=round(btc_usd + usdt_usd + pepe_usd, 2)
            ))

        # Seller history point
        if seller_wallet_id in self._history and self._history[seller_wallet_id]:
            prev_hp = self._history[seller_wallet_id][-1]
            s_balances = dict(prev_hp.balances)
            s_balances["btc"] = s_balances.get("btc", 100_000_000)
            s_balances[payment_asset_id] = s_balances.get(payment_asset_id, 0) + payment_amount
            s_balances[asset_id] = max(0, s_balances.get(asset_id, 0) - asset_amount)
            btc_usd = float(s_balances["btc"]) / float(sats_per_usd)
            usdt_usd = float(s_balances.get(payment_asset_id, 0))
            pepe_usd = float(s_balances.get(asset_id, 0)) * unit_pepe_price
            self._history[seller_wallet_id].append(HistoryPoint(
                t=now,
                balances=s_balances,
                total_usd=round(btc_usd + usdt_usd + pepe_usd, 2)
            ))

    def assemble_wallet_state(self, wallet_id: str, balance_data: Dict[str, Any]) -> WalletState:
        address = balance_data.get("address", self._addresses.get(wallet_id, ""))
        label = self._labels.get(wallet_id, f"Wallet {wallet_id[:8]}")

        pepe_id = market_manager.pepe_asset_id or settings.DEMO_ASSET_ID or "rgb:pepe_nia"
        usdt_id = market_manager.usdt_asset_id or settings.PAYMENT_ASSET_ID or "rgb:usdt_nia"
        demo_asset_ids = {pepe_id, usdt_id}

        # Build assets list
        assets: List[AssetBalance] = []
        btc_sats = balance_data.get("btc_sats", 100_000_000)
        assets.append(AssetBalance(
            asset_id="btc",
            ticker="BTC",
            schema="BTC",
            precision=8,
            amount=btc_sats,
        ))

        balances_map: Dict[str, int] = {"btc": btc_sats, usdt_id: 0, pepe_id: 0}
        for nia in balance_data.get("assets", []):
            aid = nia["asset_id"]
            if aid not in demo_asset_ids:
                # Filter out legacy old assets
                continue
            ticker = nia["ticker"]
            amt = nia.get("spendable", nia.get("settled", 0))
            balances_map[aid] = amt
            assets.append(AssetBalance(
                asset_id=aid,
                ticker=ticker,
                schema="NIA",
                precision=0,
                amount=amt,
            ))

        # Total USD: BTC (sats / sats_per_usd) + USDT + PEPE (if settled and priced)
        btc_sats = balances_map.get("btc", 0)
        sats_per_usd = settings.SATS_PER_USD or 1000
        btc_usd = float(btc_sats) / float(sats_per_usd)
        total_usd = btc_usd + float(balances_map.get(usdt_id, 0))
        if market_manager.last_pepe_price_usd and balances_map.get(pepe_id, 0) > 0:
            total_usd += float(market_manager.last_pepe_price_usd) * float(balances_map.get(pepe_id, 0))
        total_usd = round(total_usd, 2)

        # Build history points with asset_id keys
        raw_history = self._history.get(wallet_id, [])
        history_points: List[HistoryPoint] = []
        for hp in raw_history:
            hp_map: Dict[str, int] = {"btc": hp.balances.get("btc", hp.balances.get("BTC", btc_sats))}
            hp_map[usdt_id] = hp.balances.get(usdt_id, hp.balances.get("USDT", 0))
            hp_map[pepe_id] = hp.balances.get(pepe_id, hp.balances.get("PEPE", 0))
            hp_btc_usd = float(hp_map["btc"]) / float(sats_per_usd)
            hp_tot = hp_btc_usd + float(hp_map[usdt_id])
            if market_manager.last_pepe_price_usd and hp_map[pepe_id] > 0:
                hp_tot += float(market_manager.last_pepe_price_usd) * float(hp_map[pepe_id])
            history_points.append(HistoryPoint(t=hp.t, balances=hp_map, total_usd=round(hp_tot, 2)))

        if not history_points:
            now = int(time.time())
            history_points.append(HistoryPoint(t=now - 3600, balances=balances_map, total_usd=total_usd))

        cost_basis = {
            "btc": None,
            usdt_id: 1.0,
            pepe_id: self._cost_basis.get(wallet_id, {}).get(pepe_id),
        }

        return WalletState(
            wallet_id=wallet_id,
            label=label,
            address=address,
            assets=assets,
            avg_cost_basis=cost_basis,
            history_points=history_points,
            activity=self._activities.get(wallet_id, []),
            local_aliases=self.get_aliases(wallet_id),
            agent_profile=self.get_profile(wallet_id),
        )

# Global singleton wallet state manager
wallet_state_manager = WalletStateManager()
