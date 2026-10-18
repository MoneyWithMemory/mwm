"""
Vault link tests: the receive_invoice, refresh and move_to_vault endpoints against a stub Vault
service, and the WalletManager calls behind them against fake rgb-lib wallets. Invoices are real
rgb-lib invoices from an offline wallet. The only send pays the wallet's own Vault, on an invoice
the backend fetched itself, never what the Seller Desk lists or a deal in progress has promised,
and no Vault move reaches the memory graph.
"""

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingTCPServer
from types import SimpleNamespace

import pytest
import rgb_lib
from fastapi.testclient import TestClient

from backend import api_server
from backend.api_server import app
from backend.deterministic_gate import CanonicalSwapTerms, compute_terms_hash
from backend.memory_graph import MemoryGraph, memory_graph
from backend.rgb_swap_engine import (
    NETWORK,
    WITNESS_PAYMENT_SAT,
    InsufficientFundsError,
    InvoiceMismatchError,
    WalletManager,
)
from backend.session_store import SessionStore

client = TestClient(app)
TRANSPORT = "rpc://127.0.0.1:3000/json-rpc"
# A real contract id, to name an asset in an invoice the offline wallet cannot name.
OTHER_ASSET = "rgb:OIbTkqKS-9FoqScg-mnCLvLe-Udr~Khi-C7~ZJUx-xi4QqKM"


def _market_asset(ticker: str) -> str:
    return next(a["asset_id"] for a in client.get("/api/market").json()["assets"] if a["ticker"] == ticker)


@pytest.fixture(scope="module")
def invoices(tmp_path_factory):
    """Real invoices from an offline wallet; witness receives need no UTXO, but no asset either."""
    keys = rgb_lib.generate_keys(NETWORK, rgb_lib.WitnessVersion.SEG_WIT_V0)
    wallet = rgb_lib.Wallet(
        rgb_lib.WalletData(
            data_dir=str(tmp_path_factory.mktemp("offline")),
            bitcoin_network=NETWORK,
            database_type=rgb_lib.DatabaseType.SQLITE,
            max_allocations_per_utxo=5,
            supported_schemas=[rgb_lib.AssetSchema.NIA],
        ),
        rgb_lib.SinglesigKeys(
            account_xpub_vanilla=keys.account_xpub_vanilla,
            account_xpub_colored=keys.account_xpub_colored,
            vanilla_keychain=0,
            master_fingerprint=keys.master_fingerprint,
            mnemonic=keys.mnemonic,
            witness_version=keys.witness_version,
        ),
    )

    def make(amount=None, asset_id=None, expires_in=900):
        assignment = rgb_lib.Assignment.ANY() if amount is None else rgb_lib.Assignment.FUNGIBLE(amount)
        invoice = wallet.witness_receive(None, assignment, int(time.time()) + expires_in, [TRANSPORT], 1).invoice
        # rgb-lib only names an asset the wallet knows: put the contract id in by hand.
        return invoice.replace("rgb:~/", f"{asset_id}/", 1) if asset_id else invoice

    return make


class FakeRgbWallet:
    """The rgb-lib calls behind the Vault link, recorded; `transfers` maps asset id (or None) to transfers."""

    def __init__(self, spendable=1_000, assets=()):
        self.spendable = spendable
        self.assets = list(assets)
        self.unspents = [_unspent(allocated=True)]
        self.transfers = {}
        self.receives = []
        self.sent = []
        self.created = 0
        self.refreshes = 0

    def get_asset_balance(self, asset_id):
        return SimpleNamespace(settled=self.spendable, future=self.spendable, spendable=self.spendable)

    def get_btc_balance(self, online, skip_sync):
        return SimpleNamespace(vanilla=SimpleNamespace(future=990_000), colored=SimpleNamespace(future=0))

    def list_assets(self, schemas):
        return SimpleNamespace(nia=[SimpleNamespace(asset_id=a, ticker="X", name="X") for a in self.assets])

    def list_unspents(self, online, settled_only, skip_sync):
        return self.unspents

    def create_utxos(self, online, up_to, num, size, fee_rate, skip_sync):
        self.created += num
        self.unspents += [_unspent() for _ in range(num)]

    def blind_receive(self, asset_id, assignment, expiration, transports, min_confirmations):
        if asset_id is not None and asset_id not in self.assets:
            raise rgb_lib.RgbLibError.AssetNotFound(asset_id=asset_id)
        self.receives.append((asset_id, assignment.amount, expiration))
        n = len(self.receives)
        return SimpleNamespace(invoice=f"rgb:~/~/~/utxob:fake{n}", recipient_id=f"utxob:fake{n}", expiration_timestamp=expiration)

    def list_transfers(self, asset_id):
        return self.transfers.get(asset_id, [])

    def send(self, online, recipient_map, donation, fee_rate, min_confirmations, expiration):
        self.sent.append((recipient_map, donation, fee_rate))
        return SimpleNamespace(txid="txid_vault_out")

    def refresh(self, online, asset_id, filters, skip_sync):
        self.refreshes += 1
        return {}


def _unspent(allocated=False):
    return SimpleNamespace(
        utxo=SimpleNamespace(exists=True, colorable=True),
        rgb_allocations=[SimpleNamespace(asset_id="rgb:x")] if allocated else [],
        pending_blinded=0,
    )


def _transfer(recipient_id, status, amount=0, txid=None):
    return SimpleNamespace(
        recipient_id=recipient_id,
        status=status,
        assignments=[rgb_lib.Assignment.FUNGIBLE(amount)] if amount else [],
        txid=txid,
    )


def _use_fake_wallet(monkeypatch, mgr, fake):
    monkeypatch.setattr(mgr, "get_or_create_wallet", lambda wallet_id, mnemonic=None: (fake, None, "bcrt1qfake"))
    monkeypatch.setattr(mgr, "_receives", {})
    monkeypatch.setattr("backend.rgb_swap_engine.regtest.mine", lambda blocks=1: None)


@pytest.fixture
def mgr(tmp_path):
    return WalletManager(data_root=str(tmp_path / "data"))


# ── WalletManager ───────────────────────────────────────────────────

def test_receive_invoice_takes_an_empty_utxo_and_names_known_assets_only(monkeypatch, mgr):
    fake = FakeRgbWallet(assets=["rgb:usdt"])
    _use_fake_wallet(monkeypatch, mgr, fake)

    receive = mgr.create_receive_invoice("wallet_a", "rgb:usdt", 25)
    # The only UTXO holds allocations, so a new empty one is created for the blind receive.
    assert fake.created == 1
    asset_id, amount, expiry = fake.receives[-1]
    assert (asset_id, amount) == ("rgb:usdt", 25)
    assert receive == {"invoice": "rgb:~/~/~/utxob:fake1", "recipient_id": "utxob:fake1", "expires_at": expiry}
    assert 0 < expiry - time.time() <= 15 * 60

    # An asset the wallet never held cannot be named: that invoice takes any asset.
    mgr.create_receive_invoice("wallet_a", "rgb:pepe", 10)
    assert fake.receives[-1][:2] == (None, 10) and fake.created == 1
    assert mgr._receives["wallet_a"] == {"utxob:fake1": "rgb:usdt", "utxob:fake2": "rgb:pepe"}


def test_refresh_reports_each_settled_invoice_once(monkeypatch, mgr):
    fake = FakeRgbWallet(assets=["rgb:usdt"])
    _use_fake_wallet(monkeypatch, mgr, fake)
    mgr.create_receive_invoice("wallet_a", "rgb:usdt", 25)
    mgr.create_receive_invoice("wallet_a", "rgb:pepe", 10)

    waiting = rgb_lib.TransferStatus.WAITING_COUNTERPARTY
    fake.transfers = {
        "rgb:usdt": [
            _transfer("utxob:fake1", rgb_lib.TransferStatus.SETTLED, 25, "txid_in"),
            _transfer("utxob:swap", rgb_lib.TransferStatus.SETTLED, 99, "txid_swap"),  # not a Vault invoice
        ],
        None: [_transfer("utxob:fake2", waiting)],
    }
    assert mgr.refresh("wallet_a") == [{"recipient_id": "utxob:fake1", "asset_id": "rgb:usdt", "amount": 25, "txid": "txid_in"}]
    # Two passes: the first accepts the consignment, the second settles it.
    assert fake.refreshes == 2
    assert mgr.refresh("wallet_a") == []

    fake.transfers[None] = [_transfer("utxob:fake2", rgb_lib.TransferStatus.FAILED)]  # expired unpaid
    assert mgr.refresh("wallet_a") == []
    assert mgr._receives["wallet_a"] == {}


def test_pay_invoice_sends_exactly_the_requested_transfer(monkeypatch, mgr, invoices):
    fake = FakeRgbWallet()
    _use_fake_wallet(monkeypatch, mgr, fake)
    invoice = invoices(25)

    assert mgr.pay_invoice("wallet_a", invoice, "rgb:usdt", 25) == "txid_vault_out"
    [(recipient_map, donation, fee_rate)] = fake.sent
    [recipient] = recipient_map["rgb:usdt"]
    assert recipient.recipient_id == rgb_lib.Invoice(invoice).invoice_data().recipient_id
    assert recipient.assignment.amount == 25 and recipient.transport_endpoints == [TRANSPORT]
    # A witness invoice asks the payer for a bitcoin output; a blind one would get none.
    assert recipient.witness_data.amount_sat == WITNESS_PAYMENT_SAT
    assert (donation, fee_rate) == (True, 1)
    assert fake.refreshes == 1

    # An invoice leaving the amount open, or naming the same asset, is paid the same way.
    mgr.pay_invoice("wallet_a", invoices(None), "rgb:usdt", 25)
    mgr.pay_invoice("wallet_a", invoices(25, asset_id=OTHER_ASSET), OTHER_ASSET, 25)
    assert len(fake.sent) == 3


@pytest.mark.parametrize("make_invoice", [
    lambda inv: inv(30),                          # another amount
    lambda inv: inv(25, asset_id=OTHER_ASSET),    # another asset
    lambda inv: inv(25, expires_in=30),           # expires before it could be accepted
    lambda inv: "rgb:not-an-invoice",
])
def test_pay_invoice_refuses_another_transfer_before_sending(monkeypatch, mgr, invoices, make_invoice):
    fake = FakeRgbWallet()
    _use_fake_wallet(monkeypatch, mgr, fake)
    with pytest.raises(InvoiceMismatchError):
        mgr.pay_invoice("wallet_a", make_invoice(invoices), "rgb:usdt", 25)
    assert fake.sent == []


def test_pay_invoice_refuses_an_uncovered_amount_and_keeps_a_broadcast_txid(monkeypatch, mgr, invoices):
    fake = FakeRgbWallet(spendable=24)
    _use_fake_wallet(monkeypatch, mgr, fake)
    with pytest.raises(InsufficientFundsError):
        mgr.pay_invoice("wallet_a", invoices(25), "rgb:usdt", 25)
    assert fake.sent == []

    # Once broadcast, the move has happened: a failing confirmation must not look like a failed move.
    fake.spendable = 25

    def regtest_down(blocks=1):
        raise RuntimeError("regtest down")

    monkeypatch.setattr("backend.rgb_swap_engine.regtest.mine", regtest_down)
    assert mgr.pay_invoice("wallet_a", invoices(25), "rgb:usdt", 25) == "txid_vault_out"


# ── Endpoints ───────────────────────────────────────────────────────

class StubVault:
    """A Vault service stand-in: canned answers per action, every call recorded."""

    def __init__(self):
        self.calls = []
        self.answers = {}
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                _, _, wallet_id, action = self.path.split("/", 3)
                stub.calls.append((wallet_id, action, payload))
                status, body = stub.answers.get(action, (404, {"code": "not_found", "message": "No such route"}))
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        # Not HTTPServer: it resolves its host name, a slow reverse DNS lookup on some machines.
        self.server = ThreadingTCPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()

    def actions(self):
        return [action for _, action, _ in self.calls]


@pytest.fixture(autouse=True)
def sessions(monkeypatch):
    """A session store of its own: deals other test modules left in progress promise nothing here."""
    store = SessionStore(MemoryGraph())
    monkeypatch.setattr("backend.api_server.session_store", store)
    return store


@pytest.fixture
def vault(monkeypatch):
    stub = StubVault()
    monkeypatch.setattr("backend.api_server.settings.VAULT_URL", stub.url)
    yield stub
    stub.server.shutdown()
    stub.server.server_close()


@pytest.fixture
def fake_wallet(monkeypatch):
    fake = FakeRgbWallet(assets=[_market_asset("USDT")])
    _use_fake_wallet(monkeypatch, api_server.wallet_mgr, fake)
    return fake


@pytest.fixture
def memory_graph_untouched(monkeypatch):
    """Any memory-graph write fails the test; also checks what wallets see of the graph is unchanged."""
    def seen():
        return client.get("/api/wallets/wallet_a/contacts").json(), client.get("/api/wallets/wallet_a").json()["trust"]

    before = seen()
    for name in dir(memory_graph):
        if name.startswith(("record", "register")) and callable(getattr(memory_graph, name)):
            monkeypatch.setattr(memory_graph, name, lambda *args, **kwargs: pytest.fail("a Vault move reached the memory graph"))
    yield
    assert seen() == before


def _wallet_a():
    return client.get("/api/wallets/wallet_a").json()


def test_vault_endpoints_validate_wallet_asset_and_amount(monkeypatch, vault):
    usdt = _market_asset("USDT")
    monkeypatch.setattr(api_server.wallet_mgr, "pay_invoice", lambda *a: pytest.fail("nothing may be paid"))
    monkeypatch.setattr(api_server.wallet_mgr, "create_receive_invoice", lambda *a: pytest.fail("no invoice may be made"))
    monkeypatch.setattr("backend.api_server._spendable", lambda wallet_id, asset_id: 10)

    for action in ("receive_invoice", "move_to_vault"):
        def post(wallet_id="wallet_a", **body):
            return client.post(f"/api/wallets/{wallet_id}/{action}", json={"asset_id": usdt, "amount": 5, **body})

        resp = post("wallet_ghost")
        assert (resp.status_code, resp.json()["code"]) == (404, "wallet_not_found")
        for asset in ("btc", "rgb:unknown"):
            resp = post(asset_id=asset)
            assert (resp.status_code, resp.json()["code"]) == (400, "invalid_request")
            assert "USDT and PEPE" in resp.json()["message"]
        for amount in (0, -3, 2.5, "10", True, None):
            resp = post(amount=amount)
            assert (resp.status_code, resp.json()["code"]) == (400, "invalid_request")
    assert client.post("/api/wallets/wallet_ghost/refresh").status_code == 404

    # The client never hands over an invoice: the backend asks the wallet's own Vault for it.
    resp = client.post("/api/wallets/wallet_a/move_to_vault", json={"asset_id": usdt, "amount": 5, "invoice": "rgb:~/~/~/utxob:x"})
    assert (resp.status_code, resp.json()["code"]) == (400, "invalid_request")
    resp = client.post("/api/wallets/wallet_a/move_to_vault", json={"asset_id": usdt, "amount": 11})
    assert (resp.status_code, resp.json()) == (409, {"code": "insufficient_funds", "message": "Your wallet does not hold 11 USDT."})
    assert vault.calls == []


@pytest.mark.parametrize("answer,expected", [
    ((404, {"code": "vault_missing", "message": "No Vault."}), (409, "vault_missing", "You have no Vault yet. Create it first.")),
    ((409, {"code": "vault_locked", "message": "Locked."}), (409, "vault_locked", "The Vault is locked. Unlock it and try again.")),
    ((403, {"code": "policy_denied", "message": "Vault policy: no."}), (403, "policy_denied", "Vault policy: no.")),
    ((500, {"code": "internal", "message": "boom"}), (503, "vault_unavailable", api_server.VAULT_UNAVAILABLE)),
    ((200, {"recipient_id": "utxob:x"}), (503, "vault_unavailable", api_server.VAULT_UNAVAILABLE)),
])
def test_move_to_vault_maps_vault_errors(monkeypatch, vault, fake_wallet, answer, expected):
    vault.answers["invoice"] = answer
    activity = _wallet_a()["activity"]
    resp = client.post("/api/wallets/wallet_a/move_to_vault", json={"asset_id": _market_asset("USDT"), "amount": 5})
    assert (resp.status_code, resp.json()["code"], resp.json()["message"]) == expected
    assert vault.actions() == ["invoice"] and fake_wallet.sent == []
    assert _wallet_a()["activity"] == activity


def test_move_to_vault_when_the_vault_is_unreachable(monkeypatch, fake_wallet):
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        closed_port = s.getsockname()[1]
    monkeypatch.setattr("backend.api_server.settings.VAULT_URL", f"http://127.0.0.1:{closed_port}")
    resp = client.post("/api/wallets/wallet_a/move_to_vault", json={"asset_id": _market_asset("USDT"), "amount": 5})
    assert (resp.status_code, resp.json()["code"]) == (503, "vault_unavailable")
    assert fake_wallet.sent == []


def test_move_to_vault_refuses_a_mismatched_invoice(vault, fake_wallet, invoices):
    vault.answers["invoice"] = (200, {"invoice": invoices(30), "recipient_id": "x"})
    resp = client.post("/api/wallets/wallet_a/move_to_vault", json={"asset_id": _market_asset("USDT"), "amount": 25})
    assert (resp.status_code, resp.json()["code"]) == (502, "vault_invoice_mismatch")
    assert "nothing was sent" in resp.json()["message"]
    assert fake_wallet.sent == [] and vault.actions() == ["invoice"]


def test_move_to_vault_pays_the_own_vault_off_the_memory_graph(vault, fake_wallet, invoices, memory_graph_untouched):
    usdt = _market_asset("USDT")
    invoice = invoices(25)
    vault.answers["invoice"] = (200, {"invoice": invoice, "recipient_id": "x"})
    vault.answers["refresh"] = (500, {"code": "internal", "message": "boom"})  # logged, not fatal
    before = _wallet_a()

    resp = client.post("/api/wallets/wallet_a/move_to_vault", json={"asset_id": usdt, "amount": 25})
    assert (resp.status_code, resp.json()) == (200, {"txid": "txid_vault_out", "asset_id": usdt, "amount": 25})
    assert vault.calls == [("wallet_a", "invoice", {"asset_id": usdt, "amount": 25}), ("wallet_a", "refresh", {})]
    [(recipient_map, _, _)] = fake_wallet.sent
    assert recipient_map[usdt][0].recipient_id == rgb_lib.Invoice(invoice).invoice_data().recipient_id

    after = _wallet_a()
    assert after["activity"][0] == {
        "id": after["activity"][0]["id"], "t": after["activity"][0]["t"], "kind": "vault", "direction": "out",
        "asset": {"asset_id": usdt, "ticker": "USDT", "schema": "NIA", "precision": 0}, "amount": 25,
        "counterparty_address": None, "txid": "txid_vault_out", "session_id": None, "status": "confirmed",
    }
    point = after["history_points"][-1]["balances"]
    assert len(after["history_points"]) == len(before["history_points"]) + 1
    assert point[usdt] == before["history_points"][-1]["balances"][usdt] - 25 and point["btc"] == 990_000


def test_vault_in_is_recorded_once_its_invoice_settles(vault, fake_wallet, memory_graph_untouched):
    usdt = _market_asset("USDT")
    resp = client.post("/api/wallets/wallet_a/receive_invoice", json={"asset_id": usdt, "amount": 40})
    assert resp.status_code == 200
    receive = resp.json()
    assert receive == {
        "invoice": "rgb:~/~/~/utxob:fake1", "recipient_id": "utxob:fake1", "asset_id": usdt, "amount": 40,
        "expires_at": receive["expires_at"],
    }
    assert isinstance(receive["expires_at"], int)
    count = len(_wallet_a()["activity"])

    assert client.post("/api/wallets/wallet_a/refresh").json() == {"wallet_id": "wallet_a", "refreshed": True}
    assert len(_wallet_a()["activity"]) == count  # not paid yet

    fake_wallet.transfers[usdt] = [_transfer("utxob:fake1", rgb_lib.TransferStatus.SETTLED, 40, "txid_vault_in")]
    before = _wallet_a()
    assert client.post("/api/wallets/wallet_a/refresh").status_code == 200
    client.post("/api/wallets/wallet_a/refresh")
    after = _wallet_a()
    assert len(after["activity"]) == count + 1
    item = after["activity"][0]
    assert (item["kind"], item["direction"], item["amount"], item["txid"], item["counterparty_address"]) == (
        "vault", "in", 40, "txid_vault_in", None,
    )
    assert after["history_points"][-1]["balances"][usdt] == before["history_points"][-1]["balances"][usdt] + 40
    # Vault -> Wallet is driven by the Vault: the backend never calls it for a receive.
    assert vault.calls == []


# ── Guards: the desk lot and deals in progress ──────────────────────

@pytest.fixture
def locked_vault(vault, monkeypatch):
    """Past the guards a move asks the Vault for an invoice, and this Vault is locked: nothing is paid."""
    vault.answers["invoice"] = (409, {"code": "vault_locked", "message": "Locked."})
    monkeypatch.setattr(api_server.wallet_mgr, "pay_invoice", lambda *a: pytest.fail("nothing may be paid"))
    return vault


@pytest.fixture
def holdings(monkeypatch):
    """Spendable balances by (wallet id, asset id) as the endpoints read them; 0 for anything else."""
    held = {}
    monkeypatch.setattr("backend.api_server._spendable", lambda wallet_id, asset_id: held.get((wallet_id, asset_id), 0))
    return held


@pytest.fixture
def desk(monkeypatch):
    """Sets wallet_b's Seller Desk through the API; its profile is restored after the test."""
    profiles = api_server.wallet_state_manager._profiles
    monkeypatch.setitem(profiles, "wallet_b", profiles["wallet_b"])

    def set_desk(**fields):
        assert client.put("/api/wallets/wallet_b/agent_profile", json=fields).status_code == 200

    return set_desk


def _move(wallet_id, asset_id, amount):
    resp = client.post(f"/api/wallets/{wallet_id}/move_to_vault", json={"asset_id": asset_id, "amount": amount})
    return resp.status_code, resp.json()["code"], resp.json()["message"]


def _deal(store, session_id, amount, ceiling):
    """wallet_a negotiates `amount` PEPE from wallet_b, up to its secret ceiling (the seller's reserve is 110)."""
    store.create_session(
        session_id=session_id, asset_id=_market_asset("PEPE"), asset_ticker="PEPE", asset_amount=amount,
        payment_asset_id=_market_asset("USDT"), payment_ticker="USDT", buyer_wallet_id="wallet_a",
        seller_wallet_id="wallet_b", buyer_address="bcrt1qbuyer", seller_address="bcrt1qseller",
        asking_price_usd=150, buyer_max_budget_usd=ceiling, seller_min_reserve_usd=110,
    )


def _agree(store, session_id, price):
    """The agents agree on `price`: the terms wait for both signatures. Returns their hash."""
    session = store.get_session(session_id)
    terms = CanonicalSwapTerms(
        session_id=session_id, asset_id=session.asset_id, rgb_amount=session.asset_amount,
        payment_asset_id=session.payment_asset_id, payment_amount=price, agreed_price_usd=price,
        network_fee_sat=2_000, buyer_address=session.buyer_address, seller_address=session.seller_address,
        expiry_unix=int(time.time()) + 600,
    )
    terms_hash = compute_terms_hash(terms)
    store.set_awaiting_signatures(session_id, price, price, terms, terms_hash)
    return terms_hash


LISTED = "{:,} PEPE are listed on your Seller Desk. Lower the lot or pause the desk first."
PROMISED = "{:,} {} are promised in a deal in progress. Wait for it to finish or cancel it."


def test_move_to_vault_leaves_the_lot_listed_on_the_seller_desk(locked_vault, holdings, desk):
    pepe, usdt = _market_asset("PEPE"), _market_asset("USDT")
    holdings.update({("wallet_b", pepe): 1_000_000, ("wallet_b", usdt): 500})
    desk(seller_active=True, offered_asset_id=pepe, offered_amount=1_000_000, asking_price_usd=150, secret_min_reserve_usd=110)

    assert _move("wallet_b", pepe, 1) == (409, "desk_lot", LISTED.format(1_000_000))
    assert locked_vault.calls == []  # refused before the Vault is asked for anything

    # A lower lot frees the rest, and the desk holds back no other asset.
    desk(offered_amount=750_000)
    assert _move("wallet_b", pepe, 250_001) == (409, "desk_lot", LISTED.format(750_000))
    assert _move("wallet_b", pepe, 250_000)[1] == "vault_locked"
    assert _move("wallet_b", usdt, 500)[1] == "vault_locked"
    # A paused desk lists nothing.
    desk(seller_active=False)
    assert _move("wallet_b", pepe, 1_000_000)[1] == "vault_locked"
    assert locked_vault.actions() == ["invoice"] * 3


def test_move_to_vault_leaves_what_deals_in_progress_promise(locked_vault, holdings, desk, sessions):
    pepe, usdt = _market_asset("PEPE"), _market_asset("USDT")
    holdings.update({("wallet_a", usdt): 1_000, ("wallet_b", pepe): 800_000, ("wallet_b", usdt): 300})
    desk(seller_active=False)  # only the deals hold funds back here

    # Negotiating: the seller's lot, and the buyer's own ceiling, which the price may still reach.
    _deal(sessions, "sess_talk", amount=500_000, ceiling=135)
    assert _move("wallet_b", pepe, 300_001) == (409, "funds_committed", PROMISED.format(500_000, "PEPE"))
    assert _move("wallet_a", usdt, 866) == (409, "funds_committed", PROMISED.format(135, "USDT"))
    assert locked_vault.calls == []
    assert _move("wallet_b", pepe, 300_000)[1] == "vault_locked"
    assert _move("wallet_a", usdt, 865)[1] == "vault_locked"
    # The buyer's ceiling is not the seller's: its USDT moves freely, and no limit of the other
    # side ever shows in a message (each one is matched in full).
    assert _move("wallet_b", usdt, 300)[1] == "vault_locked"

    # Agreed: the agreed price instead of the ceiling. A second deal adds up.
    terms_hash = _agree(sessions, "sess_talk", 120)
    assert _move("wallet_a", usdt, 881) == (409, "funds_committed", PROMISED.format(120, "USDT"))
    _deal(sessions, "sess_more", amount=200_000, ceiling=60)
    assert _move("wallet_a", usdt, 821) == (409, "funds_committed", PROMISED.format(180, "USDT"))
    assert _move("wallet_b", pepe, 100_001) == (409, "funds_committed", PROMISED.format(700_000, "PEPE"))

    # Settling still holds the funds; a settled, cancelled or expired deal no longer does.
    for wallet_id in ("wallet_a", "wallet_b"):
        sessions.sign_session("sess_talk", wallet_id, terms_hash)
    assert _move("wallet_a", usdt, 821) == (409, "funds_committed", PROMISED.format(180, "USDT"))
    sessions.set_settled("sess_talk", "txid_swap")
    sessions.cancel_session("sess_more", "wallet_a")
    _deal(sessions, "sess_stale", amount=100_000, ceiling=50)
    _agree(sessions, "sess_stale", 40)
    sessions.get_session("sess_stale").expiry_unix = int(time.time()) - 1
    assert _move("wallet_a", usdt, 1_000)[1] == "vault_locked"
    assert _move("wallet_b", pepe, 800_000)[1] == "vault_locked"
    assert locked_vault.actions() == ["invoice"] * 5


def test_moves_of_one_wallet_run_one_at_a_time(monkeypatch, holdings, desk):
    from fastapi import HTTPException

    pepe = _market_asset("PEPE")
    holdings[("wallet_b", pepe)] = 1_000_000
    desk(seller_active=True, offered_asset_id=pepe, offered_amount=900_000, asking_price_usd=150, secret_min_reserve_usd=110)

    def slow_vault_invoice(wallet_id, asset_id, amount):
        time.sleep(0.2)  # the Vault may top up its UTXOs first: a second move must not pass the checks meanwhile
        return "rgb:~/~/~/utxob:vault"

    def pay(wallet_id, invoice, asset_id, amount):
        holdings[(wallet_id, asset_id)] -= amount
        return "txid_vault_out"

    monkeypatch.setattr(api_server, "_vault_invoice", slow_vault_invoice)
    monkeypatch.setattr(api_server.wallet_mgr, "pay_invoice", pay)
    monkeypatch.setattr(api_server, "_vault_post", lambda *args, **kwargs: SimpleNamespace(raise_for_status=lambda: None))
    monkeypatch.setattr(api_server, "_btc_sats", lambda wallet_id: None)
    monkeypatch.setattr(api_server.wallet_state_manager, "record_vault_move", lambda **kwargs: None)
    results = []

    def move():
        try:
            results.append(api_server.move_to_vault("wallet_b", api_server.MoveToVaultRequest(asset_id=pepe, amount=100_000))["txid"])
        except HTTPException as exc:
            results.append(exc.detail["message"])

    threads = [threading.Thread(target=move) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    # Two moves at once (two tabs, a retry) are checked one after the other: the desk keeps its lot.
    assert sorted(results) == sorted(["txid_vault_out", LISTED.format(900_000)])
    assert holdings[("wallet_b", pepe)] == 900_000
