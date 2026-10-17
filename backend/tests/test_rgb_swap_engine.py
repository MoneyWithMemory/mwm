"""
Unit tests for rgb_swap_engine, double signature enforcement, and session state machine.
"""

import time
from types import SimpleNamespace
import pytest
from backend.deterministic_gate import CanonicalSwapTerms, compute_terms_hash
from backend.rgb_swap_engine import (
    RgbSwapEngine,
    RgbSwapEngineError,
    SecurityViolationError,
    WalletManager,
)
from backend.session_store import SessionStore, SessionStatus
from backend.qvac_negotiator import NegotiationTurn

def test_session_state_machine_and_signatures():
    store = SessionStore()
    sess = store.create_session(
        session_id="sess_flow_1",
        asset_id="rgb:pepe_id",
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_asset_id="rgb:usdt_id",
        payment_ticker="USDT",
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        asking_price_usd=150,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    assert sess.status == SessionStatus.NEGOTIATING

    # Add a negotiation turn
    turn_a = NegotiationTurn(
        speaker_wallet_id="wallet_a",
        speaker_label="Wallet A",
        action="OFFER",
        offer_usd=125,
        public_message="Counteroffer 125 USDT",
        private_thought="This is my strategic maximum concession.",
        round_number=2,
    )
    store.record_turn("sess_flow_1", turn_a)

    # Perspective masking test
    view_buyer = sess.to_view("wallet_a")
    assert view_buyer["my_private_thought"] == "This is my strategic maximum concession."
    assert view_buyer["history"][0]["private_thought"] == "This is my strategic maximum concession."

    view_seller = sess.to_view("wallet_b")
    # Seller should NOT see buyer's private thought!
    assert view_seller["my_private_thought"] == ""
    assert view_seller["history"][0]["private_thought"] is None

    # Transition to AWAITING_SIGNATURES
    terms = CanonicalSwapTerms(
        session_id="sess_flow_1",
        asset_id="rgb:pepe_id",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt_id",
        payment_amount=125,
        agreed_price_usd=125,
        network_fee_sat=2000,
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        expiry_unix=int(time.time()) + 3600,
    )
    valid_hash = compute_terms_hash(terms)
    store.set_awaiting_signatures("sess_flow_1", 125, 125, terms, valid_hash)
    assert sess.status == SessionStatus.AWAITING_SIGNATURES

    # Signing with wrong hash must fail
    with pytest.raises(ValueError, match="does not match active session terms_hash"):
        store.sign_session("sess_flow_1", "wallet_a", "invalid_bad_hash")

    # Unauthorized party cannot sign
    with pytest.raises(ValueError, match="not an authorized party"):
        store.sign_session("sess_flow_1", "wallet_intruder", valid_hash)

    # 1/2 signature (Buyer signs)
    store.sign_session("sess_flow_1", "wallet_a", valid_hash)
    assert sess.buyer_signed is True
    assert sess.seller_signed is False
    # Status should still be AWAITING_SIGNATURES
    assert sess.status == SessionStatus.AWAITING_SIGNATURES

    # 2/2 signature (Seller signs)
    store.sign_session("sess_flow_1", "wallet_b", valid_hash)
    assert sess.seller_signed is True
    # Auto-transitions to SETTLING!
    assert sess.status == SessionStatus.SETTLING

    # Transition to SETTLED
    store.set_settled("sess_flow_1", "txid_1234567890abcdef")
    assert sess.status == SessionStatus.SETTLED
    assert sess.txid == "txid_1234567890abcdef"
    assert sess.settlement_step == 7

def test_session_cancellation_and_expiry():
    store = SessionStore()
    sess = store.create_session(
        session_id="sess_cancel",
        asset_id="rgb:pepe",
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_ticker="USDT",
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        asking_price_usd=150,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
        expiry_seconds=1,  # 1 second expiry
    )
    # Cancel by user
    store.cancel_session("sess_cancel", cancelled_by="wallet_a")
    assert sess.status == SessionStatus.CANCELLED_BY_USER

    # Expiry test
    sess_exp = store.create_session(
        session_id="sess_exp",
        asset_id="rgb:pepe",
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_ticker="USDT",
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        asking_price_usd=150,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
        expiry_seconds=0,
    )
    terms = CanonicalSwapTerms(
        session_id="sess_exp",
        asset_id="rgb:pepe",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_amount=125,
        agreed_price_usd=125,
        network_fee_sat=2000,
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        expiry_unix=int(time.time()) - 10,
    )
    store.set_awaiting_signatures("sess_exp", 125, 125, terms, compute_terms_hash(terms))
    retrieved = store.get_session("sess_exp")
    assert retrieved.status == SessionStatus.EXPIRED

def test_engine_enforces_double_signature_and_hash_security():
    engine = RgbSwapEngine()
    terms = CanonicalSwapTerms(
        session_id="sess_sec_test",
        asset_id="rgb:pepe_asset",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt_asset",
        payment_amount=125,
        agreed_price_usd=125,
        network_fee_sat=2000,
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        expiry_unix=int(time.time()) + 3600,
    )
    correct_hash = compute_terms_hash(terms)

    # 1. Missing signature (1/2) must raise SecurityViolationError
    with pytest.raises(SecurityViolationError, match="both buyer and seller signatures are strictly required"):
        engine.execute_atomic_swap(
            canonical_terms=terms,
            buyer_signed=True,
            seller_signed=False,
            buyer_signed_hash=correct_hash,
            seller_signed_hash=correct_hash,
        )

    # 2. Hash mismatch between buyer and seller must raise SecurityViolationError
    with pytest.raises(SecurityViolationError, match="signature terms_hash mismatch"):
        engine.execute_atomic_swap(
            canonical_terms=terms,
            buyer_signed=True,
            seller_signed=True,
            buyer_signed_hash=correct_hash,
            seller_signed_hash="different_hash_value",
        )

    # 3. Signed hash mismatch with current terms must raise SecurityViolationError
    with pytest.raises(SecurityViolationError, match="does not match canonical terms"):
        engine.execute_atomic_swap(
            canonical_terms=terms,
            buyer_signed=True,
            seller_signed=True,
            buyer_signed_hash="outdated_terms_hash",
            seller_signed_hash="outdated_terms_hash",
        )


def _unspent(*allocs, exists=True, pending_blinded=0, btc=10_000, colorable=True):
    return SimpleNamespace(
        utxo=SimpleNamespace(exists=exists, btc_amount=str(btc), colorable=colorable),
        pending_blinded=pending_blinded,
        rgb_allocations=[
            SimpleNamespace(asset_id=aid, settled=settled, assignment=SimpleNamespace(amount=amt))
            for aid, amt, settled in allocs
        ],
    )


class _FakeWallet:
    def __init__(self, unspents):
        self.unspents = unspents

    def list_unspents(self, online, settled_only, skip_sync):
        return self.unspents


def test_selected_amount_mirrors_rgb_lib_selection():
    sel = RgbSwapEngine._selected_amount
    split = _FakeWallet([_unspent(("usdt", 9_870, True)), _unspent(("usdt", 130, True))])
    assert sel(split, None, "usdt", 130) == 130
    assert sel(split, None, "usdt", 124) == 130  # would sweep 6 USDT with no change output

    lot = _FakeWallet([_unspent(("pepe", 1_000_000, True))])
    assert sel(lot, None, "pepe", 1_000_000) == 1_000_000
    assert sel(lot, None, "pepe", 500_000) == 1_000_000  # partial lot: not exact
    assert sel(lot, None, "pepe", 2_000_000) is None

    pending = _FakeWallet([_unspent(("usdt", 50, False)), _unspent(("usdt", 130, True))])
    assert sel(pending, None, "usdt", 130) == 130


def test_swap_refused_before_any_transfer_when_seller_lacks_lot():
    class FakeMgr:
        def get_or_create_wallet(self, wallet_id):
            return object(), None, "bcrt1qfake"

        def get_spendable(self, wallet_id, asset_id):
            return 0 if wallet_id == "wallet_b" else 10_000

    engine = RgbSwapEngine(wallet_mgr=FakeMgr())
    engine._ensure_isolated_allocation = lambda **kw: pytest.fail("no on-chain step may run")
    terms = CanonicalSwapTerms(
        session_id="sess_short",
        asset_id="rgb:pepe_asset",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt_asset",
        payment_amount=125,
        agreed_price_usd=125,
        network_fee_sat=2000,
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        expiry_unix=int(time.time()) + 3600,
    )
    h = compute_terms_hash(terms)
    with pytest.raises(RgbSwapEngineError, match="seller no longer holds the agreed lot"):
        engine.execute_atomic_swap(
            canonical_terms=terms,
            buyer_signed=True,
            seller_signed=True,
            buyer_signed_hash=h,
            seller_signed_hash=h,
        )


def _awaiting_session(store, session_id):
    store.create_session(
        session_id=session_id,
        asset_id="rgb:pepe",
        asset_ticker="PEPE",
        asset_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_ticker="USDT",
        buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b",
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        asking_price_usd=150,
        buyer_max_budget_usd=135,
        seller_min_reserve_usd=110,
    )
    terms = CanonicalSwapTerms(
        session_id=session_id,
        asset_id="rgb:pepe",
        rgb_amount=1_000_000,
        payment_asset_id="rgb:usdt",
        payment_amount=125,
        agreed_price_usd=125,
        network_fee_sat=2000,
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        expiry_unix=int(time.time()) + 600,
    )
    return terms, compute_terms_hash(terms)


def test_cancel_during_negotiation_sticks():
    store = SessionStore()
    terms, h = _awaiting_session(store, "sess_race")
    store.cancel_session("sess_race", cancelled_by="wallet_a")
    # The agent turn that was in flight finishes after the cancel.
    store.set_awaiting_signatures("sess_race", 125, 125, terms, h)
    store.set_blocked("sess_race", "No agreement within 4 rounds")
    store.set_failed("sess_race", "Buyer agent inference failed")
    assert store.get_session("sess_race").status == SessionStatus.CANCELLED_BY_USER


def test_only_one_signature_starts_settlement_and_settled_is_final():
    store = SessionStore()
    terms, h = _awaiting_session(store, "sess_once")
    store.set_awaiting_signatures("sess_once", 125, 125, terms, h)
    _, started_buyer = store.sign_session("sess_once", "wallet_a", h)
    _, started_seller = store.sign_session("sess_once", "wallet_b", h)
    assert (started_buyer, started_seller) == (False, True)
    with pytest.raises(ValueError):
        store.sign_session("sess_once", "wallet_b", h)

    store.set_settled("sess_once", "txid_ok")
    store.set_failed("sess_once", "late failure from a duplicate worker")
    session = store.get_session("sess_once")
    assert session.status == SessionStatus.SETTLED
    assert session.txid == "txid_ok"


def test_wallet_ids_cannot_escape_data_dir(tmp_path):
    mgr = WalletManager(data_root=str(tmp_path / "data"))
    for bad in ("../escaped", "a/b", "", "x" * 65):
        with pytest.raises(ValueError, match="Invalid wallet id"):
            mgr.get_wallet_dir(bad)
    assert mgr.get_wallet_dir("wallet_1a2b3c4d").parent == tmp_path / "data"
    assert not (tmp_path / "escaped").exists()


def test_demo_funding_is_idempotent_across_restarts(monkeypatch, tmp_path):
    import rgb_lib
    from backend import rgb_swap_engine as engine_mod

    sent = []
    monkeypatch.setattr(engine_mod.regtest, "send_to_address", lambda address, amount: sent.append(amount))
    monkeypatch.setattr(engine_mod.regtest, "mine", lambda blocks=1: None)

    class FakeBtcWallet:
        def __init__(self, sats):
            self.sats = sats

        def get_btc_balance(self, online, skip_sync):
            return SimpleNamespace(vanilla=SimpleNamespace(future=self.sats), colored=SimpleNamespace(future=0))

        def create_utxos(self, online, up_to, num, size, fee_rate, skip_sync):
            assert up_to is True
            raise rgb_lib.RgbLibError.AllocationsAlreadyAvailable()

    mgr = WalletManager(data_root=str(tmp_path / "data"))
    for sats, expect_send in ((0, True), (499_999, True), (999_735, False)):
        sent.clear()
        monkeypatch.setattr(mgr, "get_or_create_wallet", lambda wid, s=sats: (FakeBtcWallet(s), None, "bcrt1qfake"))
        mgr.fund_and_create_utxos("wallet_a", "0.01000000", 5, 10_000, min_btc_sats=500_000)
        assert bool(sent) is expect_send


def test_thinking_is_null_outside_negotiation():
    store = SessionStore()
    _awaiting_session(store, "sess_think")
    session = store.get_session("sess_think")
    session.thinking = "seller"
    assert session.to_session_view("wallet_a")["thinking"] == "seller"
    store.cancel_session("sess_think", cancelled_by="wallet_a")
    session.thinking = "seller"  # an agent turn that was in flight sets it after the cancel
    assert session.to_session_view("wallet_a")["thinking"] is None


def test_needs_my_signature_follows_each_side():
    store = SessionStore()
    terms, h = _awaiting_session(store, "sess_needs")
    session = store.get_session("sess_needs")
    assert session.to_summary("wallet_a")["needs_my_signature"] is False  # still negotiating
    store.set_awaiting_signatures("sess_needs", 125, 125, terms, h)
    assert session.to_summary("wallet_a")["needs_my_signature"] is True
    assert session.to_session_view("wallet_b")["needs_my_signature"] is True
    store.sign_session("sess_needs", "wallet_a", h)
    assert session.to_summary("wallet_a")["needs_my_signature"] is False
    assert session.to_summary("wallet_b")["needs_my_signature"] is True
    assert session.to_summary("wallet_sybil")["needs_my_signature"] is False


class _SelfSendWallet(_FakeWallet):
    """
    The asset sits on one small-BTC UTXO, as after receiving it in a swap. After a self-send, a
    refresh filtered on the asset settles the witness receive (a new 10k-sat output) and the
    send; the blind receive with no asset ID stays pending.
    """

    def __init__(self, asset_id, amount, free_utxos=1):
        super().__init__([_unspent((asset_id, amount, True), btc=847)] + [_unspent() for _ in range(free_utxos)])
        self.asset_id = asset_id
        self.receives = []
        self.sent = None
        self.refreshes = []
        self.created = 0

    def create_utxos(self, online, up_to, num, size, fee_rate, skip_sync):
        self.created += num
        self.unspents += [_unspent(btc=size) for _ in range(num)]

    def witness_receive(self, asset_id, assignment, expiration, transports, min_confirmations):
        self.receives.append(("witness", asset_id, assignment.amount))
        return SimpleNamespace(recipient_id="wvout:fake")

    def blind_receive(self, asset_id, assignment, expiration, transports, min_confirmations):
        self.receives.append(("blind", asset_id, assignment.amount))
        return SimpleNamespace(recipient_id="utxob:fake")

    def send(self, online, recipient_map, donation, fee_rate, min_confirmations, expiration):
        self.sent = [(r.witness_data.amount_sat if r.witness_data else None, r.assignment.amount) for r in recipient_map[self.asset_id]]

    def refresh(self, online, asset_id, filters, skip_sync):
        self.refreshes.append(asset_id)
        if self.sent and asset_id == self.asset_id:
            (btc, exact), *held = self.sent
            self.unspents = [_unspent((self.asset_id, exact, True), btc=btc)] + [_unspent(pending_blinded=1) for _ in held]
        return {}


@pytest.mark.parametrize("part,free_utxos", [(300_000, 1), (500_000, 1), (700_000, 0), (999_999, 1), (1_000_000, 0)])
def test_isolation_puts_exactly_the_part_on_a_new_output(monkeypatch, part, free_utxos):
    monkeypatch.setattr("backend.rgb_swap_engine.regtest.mine", lambda n=1: None)
    wallet = _SelfSendWallet("pepe", 1_000_000, free_utxos=free_utxos)
    engine = RgbSwapEngine(wallet_mgr=object())
    engine._ensure_isolated_allocation(
        wallet=wallet, online=None, asset_id="pepe", exact_amount=part, party="buyer", min_btc_sat=3_000,
    )
    # A smallest-first selection could not isolate a part above half, and the 847-sat UTXO could
    # not pay the taker's 3,000 sats even for the whole balance: the part moves to a new output.
    rest = 1_000_000 - part
    assert wallet.receives == [("witness", "pepe", part)] + ([("blind", None, rest)] if rest else [])
    assert wallet.sent[0] == (10_000, part)
    assert RgbSwapEngine._selection_fits(wallet, None, "pepe", part, 3_000)
    # A full refresh first, then only refreshes filtered on the asset (the blind receive waits).
    assert wallet.refreshes == [None, "pepe", "pepe"]
    assert wallet.created == (1 if rest and free_utxos == 0 else 0)


def test_isolation_skips_a_selection_that_already_fits(monkeypatch):
    wallet = _SelfSendWallet("pepe", 1_000_000)
    wallet.unspents[0] = _unspent(("pepe", 1_000_000, True), btc=10_000)
    RgbSwapEngine(wallet_mgr=object())._ensure_isolated_allocation(
        wallet=wallet, online=None, asset_id="pepe", exact_amount=1_000_000, party="seller", min_btc_sat=1_000,
    )
    assert wallet.receives == [] and wallet.sent is None


def test_failed_swap_settles_any_parked_excess(monkeypatch):
    monkeypatch.setattr("backend.rgb_swap_engine.regtest.mine", lambda n=1: None)

    class FailingWallet:
        def __init__(self):
            self.refreshes = []

        def create_swap_offer(self, **kwargs):
            raise RuntimeError("proxy unreachable")

        def refresh(self, online, asset_id, filters, skip_sync):
            self.refreshes.append((asset_id, filters))

    maker, taker = FailingWallet(), FailingWallet()

    class FakeMgr:
        def get_or_create_wallet(self, wallet_id):
            return (maker if wallet_id == "wallet_b" else taker), None, "bcrt1qfake"

        def get_spendable(self, wallet_id, asset_id):
            return 10**9

    engine = RgbSwapEngine(wallet_mgr=FakeMgr())
    engine._ensure_isolated_allocation = lambda **kw: None
    terms = CanonicalSwapTerms(
        session_id="sess_fail",
        asset_id="rgb:pepe_asset",
        rgb_amount=500_000,
        payment_asset_id="rgb:usdt_asset",
        payment_amount=75,
        agreed_price_usd=75,
        network_fee_sat=2000,
        buyer_address="bcrt1qbuyer",
        seller_address="bcrt1qseller",
        expiry_unix=int(time.time()) + 3600,
    )
    h = compute_terms_hash(terms)
    with pytest.raises(RuntimeError, match="proxy unreachable"):
        engine.execute_atomic_swap(
            canonical_terms=terms, buyer_signed=True, seller_signed=True, buyer_signed_hash=h, seller_signed_hash=h,
        )
    assert maker.refreshes == [(None, []), (None, [])] and taker.refreshes == [(None, []), (None, [])]
