"""
Trust score tests: the deterministic formula, the tiers and the ring cap, the walk-away penalty the
session store records, persistence across restarts, the gate, the seeded demo history and the
counterparty reliability each negotiating agent receives.
"""

import json
import time
from pathlib import Path

import pytest

from backend.config import settings
from backend.deterministic_gate import CanonicalSwapTerms, compute_terms_hash, evaluate_gate
from backend.memory_graph import MEMORY_FILE, SEEDED_LABELS, MemoryGraph, TrustTier, reliability_score
from backend.qvac_negotiator import NegotiationContext, build_system_prompt, mock_negotiate
from backend.session_store import SessionStatus, SessionStore

DAY = 86_400


def _trade(graph: MemoryGraph, buyer: str, seller: str, days_ago: float) -> None:
    graph.record_swap(buyer, seller, "PEPE", 100_000, "USDT", 13, timestamp=int(time.time() - days_ago * DAY))


def _hub_graph(data_dir=None) -> MemoryGraph:
    """
    t_hub bought from five sellers, and each seller also sold to the same four other buyers, all
    40 days ago. Every seller and buyer then scores 80 without its quality term:
    (0.35 (1 - e^(-5/6)) + 0.25 + 0.15) / 0.75 = 0.797, so t_hub's quality is 0.80.
    """
    graph = MemoryGraph(data_dir)
    for i in range(1, 6):
        _trade(graph, "t_hub", f"t_seller{i}", 40)
        for j in range(1, 5):
            _trade(graph, f"t_buyer{j}", f"t_seller{i}", 40)
    return graph


def _standing(graph: MemoryGraph, wallet_id: str):
    rep = graph.get_reputation(wallet_id)
    return rep.trust_tier, rep.reliability_pct


# ── The formula ─────────────────────────────────────────────────────

@pytest.mark.parametrize("trades, counterparties, days, walk_aways, quality, expected", [
    # 100 x (0.35 (1 - e^-1) + 0.25 + 0.25 + 0.15) = 87.12
    (6, 5, 30, 0, 1.0, 87),
    # x (1 - 0.2) = 69.70
    (6, 5, 30, 2, 1.0, 70),
    # the penalty stops at 0.5: 43.56
    (6, 5, 30, 7, 1.0, 44),
    # one trade today with an Unverified counterparty: 0.35 (1 - e^(-1/6)) + 0.25 x 0.2 + 0.25 x 0.3 = 17.87
    (1, 1, 0, 0, 0.3, 18),
    # without the quality term the other weights are rescaled: (0.35 (1 - e^-1) + 0.25 + 0.15) / 0.75 = 82.83
    (6, 5, 30, 0, None, 83),
    # never 100
    (1000, 10, 100, 0, 1.0, 99),
])
def test_reliability_score_formula(trades, counterparties, days, walk_aways, quality, expected):
    assert reliability_score(trades, counterparties, days, walk_aways, quality) == expected


def test_quality_scores_each_counterparty_one_level_deep():
    graph = _hub_graph()
    # 100 x (0.35 (1 - e^(-5/6)) + 0.25 + 0.25 x 0.80 + 0.15) = 79.79
    assert _standing(graph, "t_hub") == (TrustTier.HIGH_AUTHENTICITY, 80)
    assert graph.get_reputation("t_hub").is_trusted is True

    # Three trades with a single good seller (8 trades with 6 wallets: 88 without quality) are
    # too little: 100 x (0.35 (1 - e^(-1/2)) + 0.25 x 0.2 + 0.25 x 0.88 + 0.15) = 55.77.
    for days_ago in (40, 30, 20):
        _trade(graph, "t_solo", "t_seller1", days_ago)
    assert _standing(graph, "t_solo") == (TrustTier.LOW_RELIABILITY, 56)
    assert graph.get_reputation("t_solo").is_trusted is False


def test_unverified_counterparty_counts_three_tenths(tmp_path):
    # A one-sided edge (hand-written file): its counterparty has no settled trade of its own.
    edge = {"counterparty": "t_ghost", "asset_ticker": "USDT", "amount": 5, "settled": True,
            "timestamp": int(time.time() - 40 * DAY), "session_id": None}
    (tmp_path / MEMORY_FILE).write_text(json.dumps({"edges": {"t_one": [edge]}, "labels": {}, "walk_aways": []}))
    graph = MemoryGraph(tmp_path)
    # 100 x (0.35 (1 - e^(-1/6)) + 0.25 x 0.2 + 0.25 x 0.3 + 0.15) = 32.87
    assert _standing(graph, "t_one") == (TrustTier.LOW_RELIABILITY, 33)
    assert _standing(graph, "t_ghost") == (TrustTier.UNVERIFIED, None)


def test_no_history_is_unverified():
    graph = MemoryGraph()
    graph.register_wallet("t_new", "New wallet")
    for wallet_id in ("t_new", "t_never_seen"):
        rep = graph.get_reputation(wallet_id)
        assert (rep.trust_tier, rep.reliability_pct, rep.is_trusted) == (TrustTier.UNVERIFIED, None, False)


def test_ring_is_capped_and_ordinary_trading_is_not_a_ring():
    graph = MemoryGraph()
    # The same lot goes round t_ring1 -> t_ring2 -> t_ring3 -> t_ring1, four times: without the cap
    # the volume would score 100 x (0.35 (1 - e^(-8/6)) + 0.25 x 0.4 + 0.15) = 50.77.
    for lap in range(4):
        _trade(graph, "t_ring2", "t_ring1", 40 - lap)
        _trade(graph, "t_ring3", "t_ring2", 40 - lap)
        _trade(graph, "t_ring1", "t_ring3", 40 - lap)
    for wallet_id in ("t_ring1", "t_ring2", "t_ring3"):
        assert _standing(graph, wallet_id) == (TrustTier.RING_ANOMALY, 20)
    assert graph.get_reputation("t_ring1").is_trusted is False

    # A triangle of ordinary trades: t_c buys from t_b and sells to t_a, who also buys from t_b.
    # Assets flow one way (PEPE from t_b towards t_a, USDT back), so nothing comes back to its sender.
    _trade(graph, "t_a", "t_b", 10)
    _trade(graph, "t_a", "t_c", 9)
    _trade(graph, "t_c", "t_b", 8)
    assert not any(graph.detect_ring(w) for w in ("t_a", "t_b", "t_c", "wallet_a", "wallet_b"))


def test_only_the_same_lot_going_round_is_a_ring():
    # Wallet B buying PEPE back from Wallet A closes loops through the seeded peers, such as
    # Wallet B -> Market Maker -> Wallet A -> Wallet B, but of other amounts: both stay trusted.
    for demo_buy_first in (False, True):
        graph = MemoryGraph()
        if demo_buy_first:
            graph.record_swap("wallet_a", "wallet_b", "PEPE", 500_000, "USDT", 70)
        graph.record_swap("wallet_b", "wallet_a", "PEPE", 100_000, "USDT", 15)
        for wallet_id in ("wallet_a", "wallet_b"):
            assert _standing(graph, wallet_id)[0] == TrustTier.HIGH_AUTHENTICITY

    # PEPE goes round t_p1 -> t_p2 -> t_p3 -> t_p1 and USDT the other way, in different amounts.
    graph = MemoryGraph()
    for buyer, seller, pepe, usdt in (("t_p2", "t_p1", 100_000, 13), ("t_p3", "t_p2", 300_000, 40), ("t_p1", "t_p3", 100_000, 13)):
        graph.record_swap(buyer, seller, "PEPE", pepe, "USDT", usdt)
    assert not any(graph.detect_ring(w) for w in ("t_p1", "t_p2", "t_p3"))
    # The same round with one lot, within 10% at every hop, is wash trading.
    for buyer, seller, pepe, usdt in (("t_q2", "t_q1", 100_000, 13), ("t_q3", "t_q2", 95_000, 13), ("t_q1", "t_q3", 92_000, 12)):
        graph.record_swap(buyer, seller, "PEPE", pepe, "USDT", usdt)
    for wallet_id in ("t_q1", "t_q2", "t_q3"):
        assert _standing(graph, wallet_id)[0] == TrustTier.RING_ANOMALY


def test_low_reliability_threshold_and_penalty_cap():
    graph = _hub_graph()
    # Each walked-away deal takes 10% off (79.79 x 0.9, x 0.8, x 0.7), down to half at most.
    expected = [
        (TrustTier.HIGH_AUTHENTICITY, 80),
        (TrustTier.HIGH_AUTHENTICITY, 72),
        (TrustTier.HIGH_AUTHENTICITY, 64),
        (TrustTier.LOW_RELIABILITY, 56),
        (TrustTier.LOW_RELIABILITY, 48),
        (TrustTier.LOW_RELIABILITY, 40),
        (TrustTier.LOW_RELIABILITY, 40),
    ]
    for walk_aways, standing in enumerate(expected):
        if walk_aways:
            graph.record_walk_away(f"sess_{walk_aways}", "t_hub", "t_seller1", "cancelled_after_agreement")
        assert _standing(graph, "t_hub") == standing


# ── Walk-aways recorded by the session store ────────────────────────

def _agreed(store: SessionStore, session_id: str, buyer: str = "t_hub", seller: str = "t_seller1", agree: bool = True) -> str:
    store.create_session(
        session_id=session_id, asset_id="rgb:pepe", asset_ticker="PEPE", asset_amount=100_000,
        payment_asset_id="rgb:usdt", payment_ticker="USDT", buyer_wallet_id=buyer, seller_wallet_id=seller,
        buyer_address=f"bcrt1q{buyer}", seller_address=f"bcrt1q{seller}", asking_price_usd=15,
        buyer_max_budget_usd=14, seller_min_reserve_usd=12,
    )
    terms = CanonicalSwapTerms(
        session_id=session_id, asset_id="rgb:pepe", rgb_amount=100_000, payment_asset_id="rgb:usdt",
        payment_amount=13, agreed_price_usd=13, network_fee_sat=2000, buyer_address=f"bcrt1q{buyer}",
        seller_address=f"bcrt1q{seller}", expiry_unix=int(time.time()) + 600,
    )
    terms_hash = compute_terms_hash(terms)
    if agree:
        store.set_awaiting_signatures(session_id, 13, 13, terms, terms_hash)
    return terms_hash


def test_cancelling_an_agreed_deal_is_a_walk_away():
    graph = _hub_graph()
    store = SessionStore(graph)

    # Cancelling while the agents still negotiate costs nothing.
    _agreed(store, "sess_talks", agree=False)
    store.cancel_session("sess_talks", cancelled_by="t_hub")
    assert _standing(graph, "t_hub") == (TrustTier.HIGH_AUTHENTICITY, 80)

    _agreed(store, "sess_deal")
    store.cancel_session("sess_deal", cancelled_by="t_hub")
    assert store.get_session("sess_deal").status == SessionStatus.CANCELLED_BY_USER
    assert _standing(graph, "t_hub") == (TrustTier.HIGH_AUTHENTICITY, 72)
    # The seller is not penalized; only its quality dips, as t_hub now scores 72 without quality:
    # 100 x (0.35 (1 - e^(-5/6)) + 0.25 + 0.25 x (0.72 + 4 x 0.80) / 5 + 0.15) = 79.39.
    assert _standing(graph, "t_seller1") == (TrustTier.HIGH_AUTHENTICITY, 79)

    # The seller cancelling by address after the buyer signed: the seller walked away (79.39 x 0.9).
    terms_hash = _agreed(store, "sess_seller")
    store.sign_session("sess_seller", "t_hub", terms_hash)
    store.cancel_session("sess_seller", cancelled_by="bcrt1qt_seller1")
    assert _standing(graph, "t_seller1") == (TrustTier.HIGH_AUTHENTICITY, 71)


def test_leaving_terms_unsigned_until_expiry_is_a_walk_away():
    graph = _hub_graph()
    store = SessionStore(graph)

    # Nobody signed: nobody walked away.
    _agreed(store, "sess_nobody")
    store.get_session("sess_nobody").expiry_unix = int(time.time()) - 1
    assert store.get_session("sess_nobody").status == SessionStatus.EXPIRED
    assert _standing(graph, "t_hub")[1] == 80 and _standing(graph, "t_seller2")[1] == 80

    # The seller signed and the buyer let the terms expire, seen through the session list.
    terms_hash = _agreed(store, "sess_unsigned", seller="t_seller2")
    store.sign_session("sess_unsigned", "t_seller2", terms_hash)
    store.get_session("sess_unsigned").expiry_unix = int(time.time()) - 1
    listed = store.list_sessions_for("t_seller2")
    assert next(s for s in listed if s.session_id == "sess_unsigned").status == SessionStatus.EXPIRED
    assert _standing(graph, "t_hub") == (TrustTier.HIGH_AUTHENTICITY, 72)
    assert _standing(graph, "t_seller2") == (TrustTier.HIGH_AUTHENTICITY, 79)
    # Reading it again does not count it twice.
    store.get_session("sess_unsigned")
    assert _standing(graph, "t_hub")[1] == 72


def test_declining_a_deal_with_a_risky_counterparty_is_not_a_walk_away():
    graph = _hub_graph()
    store = SessionStore(graph)

    # The buyer took the risk of a wallet with no history (t_stranger), then cancelled the agreed deal.
    _agreed(store, "sess_risky_seller", seller="t_stranger")
    store.cancel_session("sess_risky_seller", cancelled_by="t_hub")
    # A seller left unsigned the terms a new buyer (t_newbie) signed.
    terms_hash = _agreed(store, "sess_risky_buyer", buyer="t_newbie", seller="t_seller1")
    store.sign_session("sess_risky_buyer", "t_newbie", terms_hash)
    store.get_session("sess_risky_buyer").expiry_unix = int(time.time()) - 1
    assert store.get_session("sess_risky_buyer").status == SessionStatus.EXPIRED

    assert _standing(graph, "t_hub") == (TrustTier.HIGH_AUTHENTICITY, 80)
    assert _standing(graph, "t_seller1") == (TrustTier.HIGH_AUTHENTICITY, 80)


# ── Persistence ─────────────────────────────────────────────────────

def test_memory_survives_a_restart_and_a_missing_file_reseeds(tmp_path):
    graph = _hub_graph(tmp_path)
    graph.record_walk_away("sess_left", "t_hub", "t_seller1", "cancelled_after_agreement")
    now = time.time()
    wallets = ("t_hub", "t_seller1", "wallet_a", "wallet_b", "wallet_sybil")
    before = [graph.get_reputation(w, now) for w in wallets]

    restarted = MemoryGraph(tmp_path)
    assert [restarted.get_reputation(w, now) for w in wallets] == before
    assert restarted.get_reputation("t_hub", now).reliability_pct == 72
    restarted.record_walk_away("sess_left", "t_hub", "t_seller1", "cancelled_after_agreement")
    assert restarted.get_reputation("t_hub", now).reliability_pct == 72  # once per session
    assert list(tmp_path.glob(f".{MEMORY_FILE}.*")) == []  # atomic writes leave no temp file

    (tmp_path / MEMORY_FILE).unlink()
    reseeded = MemoryGraph(tmp_path)
    assert (tmp_path / MEMORY_FILE).exists()
    assert reseeded.get_reputation("t_hub").trust_tier == TrustTier.UNVERIFIED
    assert reseeded.get_reputation("wallet_a").trust_tier == TrustTier.HIGH_AUTHENTICITY


def test_unreadable_memory_file_is_kept_aside_and_reseeded(tmp_path):
    (tmp_path / MEMORY_FILE).write_text("{not json")
    graph = MemoryGraph(tmp_path)
    assert graph.get_reputation("wallet_b").trust_tier == TrustTier.HIGH_AUTHENTICITY
    assert len(list(tmp_path.glob(f"{MEMORY_FILE}.unreadable-*"))) == 1


# ── Seeded demo history ─────────────────────────────────────────────

def test_seeded_history_scores_and_shape(tmp_path):
    graph = MemoryGraph(tmp_path)
    a, b = graph.get_reputation("wallet_a"), graph.get_reputation("wallet_b")
    assert 85 <= a.reliability_pct <= 92 and 85 <= b.reliability_pct <= 92
    assert a.reliability_pct != b.reliability_pct
    assert a.trust_tier == b.trust_tier == TrustTier.HIGH_AUTHENTICITY
    sybil = graph.get_reputation("wallet_sybil")
    assert (sybil.trust_tier, sybil.is_trusted) == (TrustTier.RING_ANOMALY, False) and sybil.reliability_pct <= 20

    edges = json.loads((tmp_path / MEMORY_FILE).read_text())["edges"]
    oldest = time.time() - 31 * DAY
    for wallet_id in ("wallet_a", "wallet_b"):
        trades = edges[wallet_id]
        assert 9 <= len(trades) <= 12 and len({t["counterparty"] for t in trades}) >= 5
        assert all(t["timestamp"] >= oldest and t["session_id"] is None for t in trades)
    # Seeded peers have histories of their own, so quality means something.
    peers = [w for w in edges if w.startswith("node_peer_")]
    assert len(peers) >= 5 and all(edges[p] for p in peers)

    # Peers and ring nodes have no address: never contacts.
    for wallet_id in ("wallet_a", "wallet_b", "wallet_sybil"):
        assert {c.wallet_id for c in graph.list_contacts_for(wallet_id)} <= {"wallet_a", "wallet_b", "wallet_sybil"}


def test_sybil_stays_in_its_ring_however_much_it_trades():
    graph = MemoryGraph()
    for lap in range(10):
        _trade(graph, "node_ring_x", "wallet_sybil", 5 - lap / 4)
        _trade(graph, "node_ring_y", "node_ring_x", 5 - lap / 4)
        _trade(graph, "wallet_sybil", "node_ring_y", 5 - lap / 4)
    sybil = graph.get_reputation("wallet_sybil")
    assert (sybil.trust_tier, sybil.is_trusted) == (TrustTier.RING_ANOMALY, False) and sybil.reliability_pct <= 20


# ── Gate (global seeded memory graph) ───────────────────────────────

def _gate(counterparty: str):
    return evaluate_gate(
        session_id="sess_trust", asset_id="rgb:pepe", rgb_amount=1_000_000, payment_asset_id="rgb:usdt",
        payment_amount=125, agreed_price_usd=125, network_fee_sat=2000, buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller", expiry_unix=1700000000, active_signer_address="bcrt1qbuyer",
        buyer_max_budget_usd=135, seller_min_reserve_usd=110, counterparty_wallet_id=counterparty,
    )


@pytest.mark.parametrize("counterparty, tier", [
    ("node_peer_newcomer", TrustTier.LOW_RELIABILITY),
    ("wallet_never_seen", TrustTier.UNVERIFIED),
    ("wallet_sybil", TrustTier.RING_ANOMALY),
])
def test_gate_blocks_every_untrusted_tier(counterparty, tier):
    res = _gate(counterparty)
    assert (res.passed, res.block_state, res.trust_tier) == (False, "BLOCKED_BY_GATE", tier)
    assert tier in res.reason


@pytest.mark.parametrize("counterparty", ["node_peer_newcomer", "wallet_never_seen", "wallet_sybil"])
def test_gate_honours_consent_for_every_untrusted_tier(counterparty):
    res = evaluate_gate(
        session_id="sess_trust", asset_id="rgb:pepe", rgb_amount=1_000_000, payment_asset_id="rgb:usdt",
        payment_amount=125, agreed_price_usd=125, network_fee_sat=2000, buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller", expiry_unix=1700000000, active_signer_address="bcrt1qbuyer",
        buyer_max_budget_usd=135, seller_min_reserve_usd=110, counterparty_wallet_id=counterparty, risk_accepted=True,
    )
    assert res.passed is True


def test_gate_passes_seeded_wallets_both_ways():
    for counterparty in ("wallet_a", "wallet_b"):
        res = _gate(counterparty)
        assert res.passed is True and res.trust_tier is None and len(res.terms_hash) == 64


# ── API (global state) ──────────────────────────────────────────────

def test_low_reliability_asks_for_consent_and_the_agent_skips_it(monkeypatch):
    from fastapi.testclient import TestClient
    from backend.api_server import app, finalize_agreement
    from backend.memory_graph import memory_graph
    from backend.negotiation_queue import NegotiationQueue

    client = TestClient(app)
    monkeypatch.setattr("backend.api_server._spendable", lambda wallet_id, asset_id: 10**9)
    monkeypatch.setattr("backend.api_server.negotiation_queue", NegotiationQueue(lambda sid: None))
    wallets = {w["wallet_id"]: w for w in client.get("/api/wallets").json()}
    pepe = client.get("/api/wallets/wallet_b").json()["agent_profile"]["offered_asset_id"]
    client.put("/api/wallets/wallet_b/agent_profile", json={"seller_active": True, "offered_amount": 1_000_000, "asking_price_usd": 150, "secret_min_reserve_usd": 110})

    # A real history, too thin to rely on: one settled trade with a graph-only peer.
    thin = client.post("/api/wallets/create", json={"label": "Thin history"}).json()
    memory_graph.record_swap(thin["wallet_id"], "node_peer_test", "PEPE", 10_000, "USDT", 2)
    trust = client.get(f"/api/wallets/{thin['wallet_id']}").json()["trust"]
    assert (trust["trust_tier"], trust["trusted"], trust["sybil_ring_detected"]) == ("Low Reliability", False, False)
    assert trust["reliability_pct"] < 60

    # As the starter, its own tier no longer blocks it: it can trade and rebuild its score.
    request = {"asset_id": pepe, "rgb_amount": 1_000_000, "buyer_max_ceiling_usd": 135, "buyer_target_usd": 120, "buyer_ai_prompt": ""}
    as_buyer = client.post("/api/sessions", json={**request, "buyer_wallet_id": thin["wallet_id"], "seller_address": wallets["wallet_b"]["address"]}).json()
    assert (as_buyer["state"], as_buyer["gate"], as_buyer["risk_accepted"]) == ("NEGOTIATING", None, False)
    client.post(f"/api/sessions/{as_buyer['session_id']}/cancel", json={"wallet_id": thin["wallet_id"]})

    # Its desk is the cheapest, yet the agent skips it (and Sybil's) and picks Wallet B.
    client.put(f"/api/wallets/{thin['wallet_id']}/agent_profile", json={"seller_active": True, "offered_asset_id": pepe, "offered_amount": 1_000_000, "asking_price_usd": 40, "secret_min_reserve_usd": 30})
    found = client.post("/api/shop/agent_search", json={**request, "buyer_wallet_id": "wallet_a"}).json()
    assert found["listing"]["listing_id"] == "desk_wallet_b"
    client.post(f"/api/sessions/{found['session']['session_id']}/cancel", json={"wallet_id": "wallet_a"})

    # Buying from it without consent: 409 confirm_risk, and nothing is created.
    to_thin = {**request, "buyer_wallet_id": "wallet_a", "seller_address": thin["address"]}
    before = len(client.get("/api/sessions?wallet_id=wallet_a").json())
    refused = client.post("/api/sessions", json=to_thin)
    assert refused.status_code == 409
    assert refused.json() == {"code": "confirm_risk", "message": "Thin history has low reliability: trading with it is a risk."}
    assert len(client.get("/api/sessions?wallet_id=wallet_a").json()) == before

    # With consent the agents negotiate, and the check after the agreement honours it.
    as_seller = client.post("/api/sessions", json={**to_thin, "accept_risk": True}).json()
    assert (as_seller["state"], as_seller["risk_accepted"]) == ("NEGOTIATING", True)
    assert as_seller["counterparty_trust"]["trust_tier"] == "Low Reliability"
    finalize_agreement(as_seller["session_id"], 120)
    agreed = client.get(f"/api/sessions/{as_seller['session_id']}?wallet_id=wallet_a").json()
    assert agreed["state"] == "AWAITING_SIGNATURES"
    assert agreed["gate"] == {"passed": True, "trust_tier": "Low Reliability", "reasons": []}

    # Declining the risky deal after the agreement is not a walk-away.
    client.post(f"/api/sessions/{as_seller['session_id']}/cancel", json={"wallet_id": "wallet_a"})
    assert not any(w.session_id == as_seller["session_id"] for w in memory_graph._walk_aways)
    client.put(f"/api/wallets/{thin['wallet_id']}/agent_profile", json={"seller_active": False})

    # A wallet with no history yet asks the same, in its own words.
    fresh = client.post("/api/wallets/create", json={"label": "Fresh"}).json()
    client.put(f"/api/wallets/{fresh['wallet_id']}/agent_profile", json={"seller_active": True, "offered_asset_id": pepe, "offered_amount": 1_000_000, "asking_price_usd": 150, "secret_min_reserve_usd": 110})
    unverified = client.post("/api/sessions", json={**to_thin, "seller_address": fresh["address"]})
    assert (unverified.status_code, unverified.json()["message"]) == (409, "Fresh has no trade history yet: trading with it is a risk.")
    client.put(f"/api/wallets/{fresh['wallet_id']}/agent_profile", json={"seller_active": False})

def test_contacts_never_show_seeded_peers():
    from fastapi.testclient import TestClient
    from backend.api_server import app

    client = TestClient(app)
    seeded_names = {label for wid, label in SEEDED_LABELS.items() if wid.startswith("node_")}
    for wallet_id in ("wallet_a", "wallet_b", "wallet_sybil"):
        contacts = client.get(f"/api/wallets/{wallet_id}/contacts").json()
        assert not seeded_names & {c["alias"] for c in contacts}
        assert all(c["address"].startswith("bcrt1") for c in contacts)
    # No wallet was ever opened for a graph-only identity.
    assert not [p.name for p in Path(settings.MWM_DATA_DIR).iterdir() if p.name.startswith("node_")]


def test_graph_identities_never_become_wallets(monkeypatch):
    from fastapi.testclient import TestClient
    from backend import api_server

    client = TestClient(api_server.app)
    # A wallet created before a restart: the saved memory knows it, the wallets of this process do not.
    graph = MemoryGraph()
    graph.register_wallet("wallet_judge01", "Judge Wallet")
    graph.record_swap("wallet_judge01", "wallet_b", "PEPE", 100_000, "USDT", 13)
    monkeypatch.setattr(api_server, "memory_graph", graph)
    monkeypatch.setitem(api_server.wallet_state_manager._addresses, "wallet_judge01", "bcrt1qjudge01")

    contact = next(c for c in client.get("/api/wallets/wallet_a/contacts").json() if c["address"] == "bcrt1qjudge01")
    assert (contact["alias"], contact["desk"]) == ("Judge Wallet", None)
    # Reading its contact (and its desk) registered no wallet with a generic label and no address.
    assert "wallet_judge01" not in {w["wallet_id"] for w in client.get("/api/wallets").json()}

    # A seeded peer cannot be given a Seller Desk, so it never lists its trusted score in the Shop.
    resp = client.put("/api/wallets/node_peer_maker/agent_profile", json={
        "seller_active": True, "offered_amount": 1_000_000, "asking_price_usd": 20, "secret_min_reserve_usd": 10,
    })
    assert (resp.status_code, resp.json()["code"]) == (404, "wallet_not_found")
    assert "node_peer_maker" not in {w["wallet_id"] for w in client.get("/api/wallets").json()}
    assert "desk_node_peer_maker" not in {l["listing_id"] for l in client.get("/api/shop?wallet_id=wallet_a").json()}


def test_settled_swap_is_recorded_persisted_and_moves_both_scores(monkeypatch, tmp_path):
    from backend import api_server

    graph = MemoryGraph(tmp_path)
    store = SessionStore(graph)
    monkeypatch.setattr(api_server, "memory_graph", graph)
    monkeypatch.setattr(api_server, "session_store", store)
    monkeypatch.setattr(api_server.rgb_engine, "execute_atomic_swap", lambda **kwargs: "ab" * 32)
    monkeypatch.setattr(api_server.wallet_state_manager, "consume_lot", lambda *args, **kwargs: None)
    monkeypatch.setattr(api_server.wallet_state_manager, "record_swap_settlement", lambda *args, **kwargs: None)
    monkeypatch.setattr(api_server, "_btc_sats", lambda wallet_id: None)

    now = time.time()
    before = {w: graph.get_reputation(w, now).reliability_pct for w in ("wallet_a", "wallet_b")}
    terms_hash = _agreed(store, "sess_settle", buyer="wallet_a", seller="wallet_b")
    store.sign_session("sess_settle", "wallet_a", terms_hash)
    store.sign_session("sess_settle", "wallet_b", terms_hash)
    api_server.run_settlement_worker("sess_settle")
    assert store.get_session("sess_settle").status == SessionStatus.SETTLED

    edges = json.loads((tmp_path / MEMORY_FILE).read_text())["edges"]
    for wallet_id, other, asset in (("wallet_a", "wallet_b", "USDT"), ("wallet_b", "wallet_a", "PEPE")):
        recorded = [e for e in edges[wallet_id] if e["session_id"] == "sess_settle"]
        assert [(e["counterparty"], e["asset_ticker"]) for e in recorded] == [(other, asset)]
    restarted = MemoryGraph(tmp_path)
    after = {w: restarted.get_reputation(w, now).reliability_pct for w in ("wallet_a", "wallet_b")}
    assert after["wallet_a"] > before["wallet_a"] and after["wallet_b"] > before["wallet_b"]


# ── Counterparty reliability in each agent's context ───────────────

def _context(**overrides) -> NegotiationContext:
    ctx = dict(
        session_id="sess_ctx", round_number=1, role="buyer", wallet_id="wallet_a", wallet_label="Wallet A",
        counterparty_wallet_id="wallet_b", counterparty_label="Wallet B", asset_ticker="PEPE",
        asset_amount=1_000_000, payment_ticker="USDT", secret_limit_usd=135, buyer_target_usd=120,
        current_ask_usd=150, list_price_usd=150, counterparty_reliability_pct=86,
        counterparty_trust_tier="High Authenticity",
    )
    ctx.update(overrides)
    return NegotiationContext(**ctx)


def test_each_agent_sees_its_counterpartys_computed_reliability():
    line = "Counterparty reliability: 86% (High Authenticity), computed from settled trades."
    prompt = build_system_prompt(_context())
    assert line in prompt and "within the rules below" in prompt
    assert line in mock_negotiate(_context())["private_thought"]
    assert line in mock_negotiate(_context(role="seller", secret_limit_usd=110))["private_thought"]
    assert "Counterparty reliability" not in build_system_prompt(_context(counterparty_trust_tier=None, counterparty_reliability_pct=None))
