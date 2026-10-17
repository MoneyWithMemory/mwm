"""
MwM - Memory Graph & Trust Engine
Manages historical counterparty interactions, calculates trust tiers,
and performs graph cycle / ring anomaly detection (wash-trading).

Strict Rules:
- Tiers: "High Authenticity" | "Ring Anomaly Detected" | "Unverified"
- reliability_pct: int | None (None indicates Unverified / cold-start)
- NO "loop %" or raw trade counts in assessment_summary or exposed text
- Seeded wallets: wallet_a ("Wallet A"), wallet_b ("Wallet B"), wallet_sybil ("Sybil")
- NEVER use legacy names (Alice/Bob) anywhere in code or text
"""

from typing import Dict, List, Optional, Set
from pydantic import BaseModel, Field

class TrustTier:
    HIGH_AUTHENTICITY = "High Authenticity"
    RING_ANOMALY = "Ring Anomaly Detected"
    UNVERIFIED = "Unverified"

class TradeEdge(BaseModel):
    counterparty: str
    asset_ticker: str
    amount: int
    settled: bool = True
    timestamp: Optional[str] = None

class WalletReputation(BaseModel):
    wallet_id: str
    label: str
    trust_tier: str
    reliability_pct: Optional[int] = None
    assessment_summary: str
    is_trusted: bool

class MemoryGraph:
    """In-memory directed multigraph of historical settled trades."""

    def __init__(self) -> None:
        # Adjacency list: wallet_id -> list of TradeEdge
        self._graph: Dict[str, List[TradeEdge]] = {}
        # Wallet metadata labels
        self._labels: Dict[str, str] = {}
        self._seed_default_graph()

    def _seed_default_graph(self) -> None:
        """Seed clean trade history for Wallet A / Wallet B and a wash-trading ring for Sybil."""
        # Clean wallets
        self._labels["wallet_a"] = "Wallet A"
        self._labels["wallet_b"] = "Wallet B"
        self._labels["wallet_sybil"] = "Sybil"
        self._labels["node_ring_x"] = "Cluster Node X"
        self._labels["node_ring_y"] = "Cluster Node Y"

        # Initialize adjacency
        for w in ["wallet_a", "wallet_b", "wallet_sybil", "node_ring_x", "node_ring_y"]:
            self._graph[w] = []

        # 1. Clean reciprocal trades between Wallet A, Wallet B and external peers
        # Wallet A and Wallet B have verified history of settled swaps
        self._graph["wallet_a"].append(TradeEdge(counterparty="wallet_b", asset_ticker="USDT", amount=150))
        self._graph["wallet_b"].append(TradeEdge(counterparty="wallet_a", asset_ticker="PEPE", amount=1_000_000))

        # 2. Sybil wash-trading ring: wallet_sybil -> node_ring_x -> node_ring_y -> wallet_sybil
        self._graph["wallet_sybil"].append(TradeEdge(counterparty="node_ring_x", asset_ticker="USDT", amount=500))
        self._graph["node_ring_x"].append(TradeEdge(counterparty="node_ring_y", asset_ticker="USDT", amount=500))
        self._graph["node_ring_y"].append(TradeEdge(counterparty="wallet_sybil", asset_ticker="USDT", amount=500))

    def record_trade(self, source_wallet: str, counterparty: str, asset_ticker: str, amount: int) -> None:
        """Record a completed settled swap between two wallets."""
        if source_wallet not in self._graph:
            self._graph[source_wallet] = []
        if counterparty not in self._graph:
            self._graph[counterparty] = []

        self._graph[source_wallet].append(
            TradeEdge(counterparty=counterparty, asset_ticker=asset_ticker, amount=amount, settled=True)
        )

    def register_wallet(self, wallet_id: str, label: Optional[str] = None) -> None:
        """Register a new wallet."""
        if wallet_id not in self._graph:
            self._graph[wallet_id] = []
        if label:
            self._labels[wallet_id] = label
        elif wallet_id not in self._labels:
            self._labels[wallet_id] = f"Wallet {wallet_id[:8]}"

    def detect_ring(self, start_wallet: str, max_depth: int = 4) -> bool:
        """
        Detect whether start_wallet participates in a closed circular trade loop (wash trading ring).
        Uses DFS with depth limit to isolate tight circular loops.
        """
        if start_wallet not in self._graph:
            return False

        def _dfs(current: str, depth: int, visited: Set[str]) -> bool:
            if depth > max_depth:
                return False
            for edge in self._graph.get(current, []):
                target = edge.counterparty
                if target == start_wallet and depth >= 3:
                    return True
                if target not in visited:
                    visited.add(target)
                    if _dfs(target, depth + 1, visited):
                        return True
                    visited.remove(target)
            return False

        return _dfs(start_wallet, 1, set())

    def get_reputation(self, wallet_id: str) -> WalletReputation:
        """
        Calculate trust tier, reliability %, and compliance assessment.
        Adheres strictly to MwM protocol:
        - Never exposes loop % or raw trade count numbers.
        - Returns None for cold start (Unverified).
        """
        label = self._labels.get(wallet_id, f"Wallet {wallet_id[:8]}")

        # Check if wallet has zero history -> Cold Start
        edges = self._graph.get(wallet_id, [])
        if not edges:
            return WalletReputation(
                wallet_id=wallet_id,
                label=label,
                trust_tier=TrustTier.UNVERIFIED,
                reliability_pct=None,
                assessment_summary="Insufficient historical transaction record to establish verifiable identity.",
                is_trusted=False,
            )

        # Check for circular wash-trading ring anomaly
        if self.detect_ring(wallet_id):
            return WalletReputation(
                wallet_id=wallet_id,
                label=label,
                trust_tier=TrustTier.RING_ANOMALY,
                reliability_pct=15,
                assessment_summary="Circular transaction topology detected. Counterparty activity exhibits wash-trading characteristics.",
                is_trusted=False,
            )

        # Verified authentic counterparty
        return WalletReputation(
            wallet_id=wallet_id,
            label=label,
            trust_tier=TrustTier.HIGH_AUTHENTICITY,
            reliability_pct=98,
            assessment_summary="Direct counterparties with consistent settlement history and zero circular anomalies.",
            is_trusted=True,
        )

    def list_contacts_for(self, wallet_id: str) -> List[WalletReputation]:
        """List known counterparties and their reputation from the perspective of wallet_id."""
        contacts: List[WalletReputation] = []
        for peer_id in self._graph.keys():
            if peer_id == wallet_id or peer_id.startswith("node_ring_"):
                continue
            contacts.append(self.get_reputation(peer_id))
        return contacts

# Global singleton memory graph
memory_graph = MemoryGraph()
