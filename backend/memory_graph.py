"""
MwM - Memory Graph & Trust Engine
Persistent directed multigraph of settled trades. Code computes each wallet's reliability score
and trust tier from it, deterministically (no AI involved and no prompt can change it), and
detects wash-trading rings: the same lot going round a closed trading loop.

Score of a wallet, from its settled trades (reliability_score):
  activity  = 1 - e^(-n/6)                     n = settled trades
  variety   = min(k/5, 1)                      k = distinct counterparties
  quality   = mean reliability of those counterparties, 0..1: a High Authenticity one counts its
              score / 100, an Unverified one 0.3, Low Reliability and rings 0. It looks one level
              deep: each counterparty is scored by the same formula without its own quality term
              (the other weights rescaled to sum to 1), so the score never recurses.
  seniority = min(days since the first settled trade / 30, 1)
  penalty   = min(0.1 x agreed deals walked away from, 0.5)
  score     = 100 x (0.35 activity + 0.25 variety + 0.25 quality + 0.15 seniority) x (1 - penalty),
              rounded half up and clamped to 1..99
A deal is walked away from when the agents reached an agreement (AWAITING_SIGNATURES) and this
party cancelled it, or did not sign before expiry while the other party did (session_store).

Tiers: no settled trade -> "Unverified" (reliability_pct None); a lot it sent coming back to it
(detect_ring) -> "Ring Anomaly Detected" (score capped at 20); score >= 60 -> "High Authenticity";
otherwise "Low Reliability".
Only High Authenticity is trusted: the gate lets any other tier through only when the session's
starter accepts the risk.

Persistence: <MWM_DATA_DIR>/memory_graph.json (trades, labels and walk-aways), loaded at startup and
rewritten atomically after every change. When it is missing, the demo history below is seeded
(declared in the README). Seeded peers and ring nodes (node_*) have no address: never contacts.

Strict Rules:
- Tiers: "High Authenticity" | "Low Reliability" | "Ring Anomaly Detected" | "Unverified"
- reliability_pct: int | None (None indicates Unverified / cold-start)
- NO "loop %" or raw trade counts in assessment_summary or exposed text
- Seeded wallets: wallet_a ("Wallet A"), wallet_b ("Wallet B"), wallet_sybil ("Sybil")
- NEVER use legacy names (Alice/Bob) anywhere in code or text
"""

import json
import logging
import math
import os
import tempfile
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple, Union
from pydantic import BaseModel, Field

from backend.config import settings

logger = logging.getLogger("mwm.memory")

class TrustTier:
    HIGH_AUTHENTICITY = "High Authenticity"
    LOW_RELIABILITY = "Low Reliability"
    RING_ANOMALY = "Ring Anomaly Detected"
    UNVERIFIED = "Unverified"

# Score weights and scales (see the module docstring).
W_ACTIVITY, W_VARIETY, W_QUALITY, W_SENIORITY = 0.35, 0.25, 0.25, 0.15
ACTIVITY_SCALE_TRADES = 6
VARIETY_FULL_COUNTERPARTIES = 5
SENIORITY_FULL_DAYS = 30
PENALTY_PER_WALK_AWAY = 0.1
MAX_PENALTY = 0.5
HIGH_AUTHENTICITY_MIN_SCORE = 60
RING_SCORE_CAP = 20
# Amounts of one asset within this share of each other are the same lot going round a loop.
RING_LOT_TOLERANCE = 0.1
# Weight in a wallet's quality of a counterparty that has no settled trade of its own.
UNVERIFIED_COUNTERPARTY_RELIABILITY = 0.3

# Generic per tier: never a per-wallet description, a loop % or a raw count.
ASSESSMENT_SUMMARY = {
    TrustTier.HIGH_AUTHENTICITY: "Direct counterparties with consistent settlement history and zero circular anomalies.",
    TrustTier.LOW_RELIABILITY: "Settlement history too thin or inconsistent to rely on.",
    TrustTier.RING_ANOMALY: "Circular transaction topology detected. Counterparty activity exhibits wash-trading characteristics.",
    TrustTier.UNVERIFIED: "Insufficient historical transaction record to establish verifiable identity.",
}

MEMORY_FILE = "memory_graph.json"
DAY_SECONDS = 86_400
# Seeded peers and ring nodes: graph-only identities with no wallet or address.
SEEDED_NODE_PREFIX = "node_"

SEEDED_LABELS = {
    "wallet_a": "Wallet A",
    "wallet_b": "Wallet B",
    "wallet_sybil": "Sybil",
    "node_peer_pool": "Mining Pool",
    "node_peer_maker": "Market Maker",
    "node_peer_exchange": "Exchange Desk",
    "node_peer_otc": "OTC Partner",
    "node_peer_merchant": "RGB Merchant",
    "node_peer_newcomer": "New Trader",
    "node_ring_x": "Cluster Node X",
    "node_ring_y": "Cluster Node Y",
}

# Seeded demo history, (buyer, seller, days ago, PEPE delivered, USDT paid). PEPE flows from
# Wallet B through the peers to Wallet A and USDT the other way, so no asset returns to its sender.
SEEDED_TRADES: List[Tuple[str, str, float, int, int]] = [
    ("node_peer_pool", "wallet_b", 30, 400_000, 52),
    ("node_peer_maker", "node_peer_pool", 29, 200_000, 27),
    ("wallet_a", "wallet_b", 28, 150_000, 21),
    ("node_peer_exchange", "wallet_b", 27, 300_000, 40),
    ("wallet_a", "node_peer_maker", 26, 100_000, 14),
    ("node_peer_otc", "node_peer_pool", 25, 150_000, 20),
    ("node_peer_merchant", "node_peer_exchange", 24, 120_000, 17),
    ("wallet_a", "node_peer_exchange", 23, 120_000, 16),
    ("node_peer_otc", "wallet_b", 22, 250_000, 33),
    ("node_peer_exchange", "node_peer_maker", 21, 80_000, 11),
    ("wallet_a", "node_peer_otc", 20, 90_000, 12),
    ("node_peer_merchant", "node_peer_otc", 19, 100_000, 14),
    ("node_peer_maker", "wallet_b", 18, 350_000, 46),
    ("wallet_a", "node_peer_merchant", 17, 70_000, 10),
    ("node_peer_exchange", "node_peer_pool", 16, 100_000, 13),
    ("wallet_a", "wallet_b", 15, 200_000, 27),
    ("node_peer_merchant", "wallet_b", 14, 150_000, 20),
    ("wallet_a", "node_peer_exchange", 12, 110_000, 15),
    ("node_peer_otc", "node_peer_maker", 11, 90_000, 12),
    ("wallet_a", "node_peer_otc", 9, 80_000, 11),
    ("node_peer_merchant", "node_peer_maker", 8, 90_000, 12),
    ("node_peer_newcomer", "wallet_b", 7, 50_000, 7),
    ("wallet_a", "node_peer_maker", 6, 100_000, 13),
    ("wallet_a", "node_peer_merchant", 4, 60_000, 8),
    ("node_peer_pool", "wallet_b", 2, 200_000, 26),
    ("wallet_a", "wallet_b", 1, 100_000, 13),
]

# Sybil's wash trading: the same lot keeps going round the loop Sybil -> X -> Y -> Sybil.
SEEDED_RING_TRADES: List[Tuple[str, str, float, int, int]] = [
    (buyer, seller, days, 500_000, 60)
    for days in (20, 13, 6)
    for buyer, seller in (("node_ring_x", "wallet_sybil"), ("node_ring_y", "node_ring_x"), ("wallet_sybil", "node_ring_y"))
]

class TradeEdge(BaseModel):
    """One side of a settled swap: this wallet sent `amount` of `asset_ticker` to `counterparty`."""
    counterparty: str
    asset_ticker: str
    amount: int
    settled: bool = True
    timestamp: int = Field(default_factory=lambda: int(time.time()))
    # The session that settled it; None for the seeded history.
    session_id: Optional[str] = None

class WalkAway(BaseModel):
    """An agreed deal this wallet left: "cancelled_after_agreement" or "unsigned_at_expiry"."""
    session_id: str
    wallet_id: str
    counterparty: str
    reason: str
    timestamp: int = Field(default_factory=lambda: int(time.time()))

class WalletReputation(BaseModel):
    wallet_id: str
    label: str
    trust_tier: str
    reliability_pct: Optional[int] = None
    assessment_summary: str
    is_trusted: bool

def reliability_score(
    trades: int,
    counterparties: int,
    days_since_first_trade: float,
    walk_aways: int,
    quality: Optional[float],
) -> int:
    """
    The reliability score (1..99) of the module docstring. quality None leaves the quality term
    out and rescales the other weights to sum to 1 (how a counterparty is scored inside quality).
    """
    activity = 1 - math.exp(-trades / ACTIVITY_SCALE_TRADES)
    variety = min(counterparties / VARIETY_FULL_COUNTERPARTIES, 1)
    seniority = min(max(days_since_first_trade, 0) / SENIORITY_FULL_DAYS, 1)
    penalty = min(PENALTY_PER_WALK_AWAY * walk_aways, MAX_PENALTY)
    weighted = W_ACTIVITY * activity + W_VARIETY * variety + W_SENIORITY * seniority
    if quality is None:
        weighted /= 1 - W_QUALITY
    else:
        weighted += W_QUALITY * quality
    return min(max(math.floor(100 * weighted * (1 - penalty) + 0.5), 1), 99)

class MemoryGraph:
    """Directed multigraph of settled trades, persisted in data_dir (None keeps it in memory only)."""

    def __init__(self, data_dir: Optional[Union[str, Path]] = None) -> None:
        self._lock = threading.RLock()
        # Adjacency list: wallet_id -> list of TradeEdge
        self._graph: Dict[str, List[TradeEdge]] = {}
        # Wallet metadata labels
        self._labels: Dict[str, str] = {}
        self._walk_aways: List[WalkAway] = []
        self._path = Path(data_dir) / MEMORY_FILE if data_dir is not None else None
        if self._path is not None and self._path.exists() and self._load():
            logger.info(f"Memory graph loaded from {self._path}")
            return
        self._seed_default_graph()
        self._save()

    # ── Persistence ─────────────────────────────────────────────────

    def _load(self) -> bool:
        """Read the persisted graph; an unreadable file is kept aside and the demo history reseeded."""
        try:
            data = json.loads(self._path.read_text())
            graph = {wid: [TradeEdge(**e) for e in edges] for wid, edges in data["edges"].items()}
            labels = {str(wid): str(label) for wid, label in data["labels"].items()}
            walk_aways = [WalkAway(**w) for w in data["walk_aways"]]
        except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
            kept = self._path.with_name(f"{self._path.name}.unreadable-{int(time.time())}")
            logger.error(f"Could not read {self._path} ({exc}): kept as {kept.name}, reseeding the demo history.")
            os.replace(self._path, kept)
            return False
        self._graph, self._labels, self._walk_aways = graph, labels, walk_aways
        return True

    def _save(self) -> None:
        """Atomic write (temp file + os.replace). A failure is logged: the graph stays in memory and
        the next successful write persists it whole."""
        if self._path is None:
            return
        data = {
            "edges": {wid: [e.model_dump() for e in edges] for wid, edges in self._graph.items()},
            "labels": self._labels,
            "walk_aways": [w.model_dump() for w in self._walk_aways],
        }
        tmp_path = None
        try:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_path = tempfile.mkstemp(dir=self._path.parent, prefix=f".{MEMORY_FILE}.", suffix=".tmp")
            with os.fdopen(fd, "w") as fh:
                json.dump(data, fh, indent=1)
                fh.flush()
                os.fsync(fh.fileno())
            os.replace(tmp_path, self._path)
        except OSError as exc:
            logger.error(f"Could not persist the memory graph to {self._path}: {exc}")
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)

    # ── Writes ──────────────────────────────────────────────────────

    def _seed_default_graph(self) -> None:
        """Seed the demo history: Wallet A / Wallet B with independent peers, Sybil inside a ring."""
        now = int(time.time())
        self._labels.update(SEEDED_LABELS)
        for wallet_id in SEEDED_LABELS:
            self._graph.setdefault(wallet_id, [])
        for buyer, seller, days_ago, pepe, usdt in SEEDED_TRADES + SEEDED_RING_TRADES:
            self._add_swap(buyer, seller, "PEPE", pepe, "USDT", usdt, int(now - days_ago * DAY_SECONDS), None)

    def _add_swap(
        self,
        buyer_wallet_id: str,
        seller_wallet_id: str,
        asset_ticker: str,
        asset_amount: int,
        payment_ticker: str,
        payment_amount: int,
        timestamp: int,
        session_id: Optional[str],
    ) -> None:
        self._graph.setdefault(buyer_wallet_id, []).append(TradeEdge(
            counterparty=seller_wallet_id, asset_ticker=payment_ticker, amount=payment_amount,
            timestamp=timestamp, session_id=session_id,
        ))
        self._graph.setdefault(seller_wallet_id, []).append(TradeEdge(
            counterparty=buyer_wallet_id, asset_ticker=asset_ticker, amount=asset_amount,
            timestamp=timestamp, session_id=session_id,
        ))

    def record_swap(
        self,
        buyer_wallet_id: str,
        seller_wallet_id: str,
        asset_ticker: str,
        asset_amount: int,
        payment_ticker: str,
        payment_amount: int,
        session_id: Optional[str] = None,
        timestamp: Optional[int] = None,
    ) -> None:
        """Record a settled swap, both directions: the seller delivered the asset, the buyer paid."""
        with self._lock:
            self._add_swap(
                buyer_wallet_id, seller_wallet_id, asset_ticker, asset_amount, payment_ticker, payment_amount,
                int(time.time()) if timestamp is None else timestamp, session_id,
            )
            self._save()

    def record_walk_away(self, session_id: str, wallet_id: str, counterparty: str, reason: str) -> None:
        """Record that wallet_id left the agreed deal of session_id (at most once per session)."""
        with self._lock:
            if any(w.session_id == session_id for w in self._walk_aways):
                return
            self._walk_aways.append(WalkAway(session_id=session_id, wallet_id=wallet_id, counterparty=counterparty, reason=reason))
            self._save()
        logger.info(f"Session {session_id}: {wallet_id} walked away from the agreed deal ({reason})")

    def register_wallet(self, wallet_id: str, label: Optional[str] = None) -> None:
        """Register a new wallet."""
        with self._lock:
            before = (wallet_id in self._graph, self._labels.get(wallet_id))
            self._graph.setdefault(wallet_id, [])
            if label:
                self._labels[wallet_id] = label
            elif wallet_id not in self._labels:
                self._labels[wallet_id] = f"Wallet {wallet_id[:8]}"
            if (True, self._labels[wallet_id]) != before:
                self._save()

    # ── Reads ───────────────────────────────────────────────────────

    def detect_ring(self, start_wallet: str, max_depth: int = 4) -> bool:
        """
        Detect whether start_wallet participates in a wash trading ring: a lot it sent comes back to
        it, the same asset in about the same amount (within RING_LOT_TOLERANCE) at every hop, through
        at least two other wallets, within max_depth hops. Following one lot around the loop keeps
        ordinary trading from looking like a loop: paying USDT and receiving PEPE, or selling some
        PEPE back to its seller, closes a loop only through other trades of other amounts. Uses DFS
        with depth limit to isolate tight circular loops.
        """
        def _same_lot(amount: int, lot: int) -> bool:
            return abs(amount - lot) <= RING_LOT_TOLERANCE * max(amount, lot)

        def _dfs(current: str, asset: str, lot: int, depth: int, visited: Set[str]) -> bool:
            if depth > max_depth:
                return False
            # Repeated trades between the same two wallets are one hop.
            targets = {
                edge.counterparty for edge in self._graph.get(current, [])
                if edge.asset_ticker == asset and _same_lot(edge.amount, lot)
            }
            for target in targets:
                if target == start_wallet:
                    if depth >= 3:
                        return True
                    continue
                if target not in visited:
                    visited.add(target)
                    if _dfs(target, asset, lot, depth + 1, visited):
                        return True
                    visited.remove(target)
            return False

        with self._lock:
            lots = sorted({(edge.asset_ticker, edge.amount) for edge in self._graph.get(start_wallet, [])})
            return any(_dfs(start_wallet, asset, lot, 1, set()) for asset, lot in lots)

    def _assess(self, wallet_id: str, now: float, with_quality: bool = True) -> Tuple[str, Optional[int]]:
        """(trust tier, reliability_pct) of wallet_id; without quality inside another's quality term."""
        trades = [edge for edge in self._graph.get(wallet_id, []) if edge.settled]
        if not trades:
            return TrustTier.UNVERIFIED, None
        counterparties = sorted({edge.counterparty for edge in trades})
        score = reliability_score(
            trades=len(trades),
            counterparties=len(counterparties),
            days_since_first_trade=(now - min(edge.timestamp for edge in trades)) / DAY_SECONDS,
            walk_aways=sum(1 for w in self._walk_aways if w.wallet_id == wallet_id),
            quality=self._quality(counterparties, now) if with_quality else None,
        )
        if self.detect_ring(wallet_id):
            return TrustTier.RING_ANOMALY, min(score, RING_SCORE_CAP)
        if score >= HIGH_AUTHENTICITY_MIN_SCORE:
            return TrustTier.HIGH_AUTHENTICITY, score
        return TrustTier.LOW_RELIABILITY, score

    def _quality(self, counterparties: List[str], now: float) -> float:
        """Mean reliability (0..1) of the counterparties, each scored one level deep (Low Reliability and rings add 0)."""
        total = 0.0
        for peer in counterparties:
            tier, pct = self._assess(peer, now, with_quality=False)
            if tier == TrustTier.HIGH_AUTHENTICITY:
                total += pct / 100
            elif tier == TrustTier.UNVERIFIED:
                total += UNVERIFIED_COUNTERPARTY_RELIABILITY
        return total / len(counterparties)

    def get_reputation(self, wallet_id: str, now: Optional[float] = None) -> WalletReputation:
        """
        Calculate trust tier, reliability %, and compliance assessment.
        Adheres strictly to MwM protocol:
        - Never exposes loop % or raw trade count numbers.
        - Returns None for cold start (Unverified).
        """
        with self._lock:
            tier, pct = self._assess(wallet_id, time.time() if now is None else now)
            label = self._labels.get(wallet_id, f"Wallet {wallet_id[:8]}")
        return WalletReputation(
            wallet_id=wallet_id,
            label=label,
            trust_tier=tier,
            reliability_pct=pct,
            assessment_summary=ASSESSMENT_SUMMARY[tier],
            is_trusted=tier == TrustTier.HIGH_AUTHENTICITY,
        )

    def list_contacts_for(self, wallet_id: str) -> List[WalletReputation]:
        """List known counterparties and their reputation from the perspective of wallet_id."""
        with self._lock:
            peers = [p for p in self._graph if p != wallet_id and not p.startswith(SEEDED_NODE_PREFIX)]
        return [self.get_reputation(peer_id) for peer_id in peers]

# Global singleton memory graph, persisted in the data dir
memory_graph = MemoryGraph(settings.MWM_DATA_DIR)
