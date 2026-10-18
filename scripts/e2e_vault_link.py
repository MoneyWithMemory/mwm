#!/usr/bin/env python3
"""
MwM - E2E Vault link on Bitcoin regtest (real RGB transfers, both directions).

Runs against a backend whose VAULT_URL points at this script's stand-in Vault:
- Wallet -> Vault: POST /api/wallets/{id}/move_to_vault. The backend fetches the invoice from
  the stand-in, pays it, mines and asks the stand-in to refresh.
- Vault -> Wallet: POST /api/wallets/{id}/receive_invoice, the stand-in pays that invoice, then
  POST /api/wallets/{id}/refresh. The wallet's balance and activity must follow.
The stand-in Vault is a fresh rgb_lib wallet (its own seed, in --data-dir) behind a tiny HTTP stub
serving /vault/{id}/invoice and /vault/{id}/refresh. Nothing shared is started, stopped or reset;
the script only funds its own wallet from the regtest miner and mines blocks.

Usage (backend started with VAULT_URL=http://127.0.0.1:8201):
  .venv/bin/python scripts/e2e_vault_link.py \
      [--backend http://127.0.0.1:8101] [--vault-port 8201] [--wallet wallet_a] [--asset USDT] [--amount 25]
"""

import argparse
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler
from socketserver import ThreadingTCPServer

import requests
import rgb_lib

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REGTEST_SCRIPT = os.getenv("REGTEST_SCRIPT", os.path.join(_ROOT, "scripts", "regtest.sh"))
ELECTRUM_URL = os.getenv("ELECTRUM_URL", "127.0.0.1:50001")
TRANSPORT = "rpc://127.0.0.1:3000/json-rpc"
NETWORK = rgb_lib.BitcoinNetwork.REGTEST
FEE_RATE = 1  # 1 sat/vB, like the backend

RESULTS = []


def check(label, ok, detail=""):
    RESULTS.append(bool(ok))
    print(f"  [{'PASS' if ok else 'FAIL'}] {label}" + (f"  ({detail})" if detail and not ok else ""))
    return bool(ok)


def run_regtest_cmd(*args):
    res = subprocess.run([REGTEST_SCRIPT, *args], capture_output=True, text=True, check=True)
    return res.stdout.strip()


def mine_blocks(num=1):
    run_regtest_cmd("mine", str(num))
    time.sleep(0.5)


class StandInVault:
    """A Vault stand-in: its own rgb_lib wallet, which the backend never sees."""

    def __init__(self, data_dir):
        keys = rgb_lib.generate_keys(NETWORK, rgb_lib.WitnessVersion.SEG_WIT_V0)
        self.wallet = rgb_lib.Wallet(
            rgb_lib.WalletData(
                data_dir=data_dir,
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
        self.online = self.wallet.go_online(rgb_lib.OnlineOptions(
            indexer_url=ELECTRUM_URL, skip_consistency_check=True, vanilla_sync_lookback=10,
        ))
        self.lock = threading.Lock()
        self.calls = []

    def fund(self):
        run_regtest_cmd("sendtoaddress", self.wallet.get_address(), "0.01")
        mine_blocks(1)
        self.wallet.create_utxos(self.online, True, 5, 10_000, FEE_RATE, False)
        mine_blocks(1)

    def invoice(self, asset_id, amount):
        assignment = rgb_lib.Assignment.FUNGIBLE(amount)
        expiry = int(time.time()) + 900
        with self.lock:
            try:
                receive = self.wallet.blind_receive(asset_id, assignment, expiry, [TRANSPORT], 1)
            except rgb_lib.RgbLibError.AssetNotFound:
                # Like a fresh Vault: an asset it never held cannot be named in its invoice.
                receive = self.wallet.blind_receive(None, assignment, expiry, [TRANSPORT], 1)
        return {"invoice": receive.invoice, "recipient_id": receive.recipient_id}

    def refresh(self):
        with self.lock:
            for _ in range(2):
                self.wallet.refresh(self.online, None, [], False)

    def balance(self, asset_id):
        with self.lock:
            try:
                return self.wallet.get_asset_balance(asset_id).spendable
            except rgb_lib.RgbLibError.AssetNotFound:
                return 0

    def pay(self, invoice, asset_id, amount):
        data = rgb_lib.Invoice(invoice).invoice_data()
        recipient = rgb_lib.Recipient(
            recipient_id=data.recipient_id,
            witness_data=None,
            assignment=rgb_lib.Assignment.FUNGIBLE(amount),
            transport_endpoints=data.transport_endpoints,
        )
        with self.lock:
            return self.wallet.send(self.online, {asset_id: [recipient]}, True, FEE_RATE, 1, None).txid


class StubServer(ThreadingTCPServer):
    # Not HTTPServer: it resolves its host name, a slow reverse DNS lookup on some machines.
    # Reusing the address only skips the TIME_WAIT of a previous run, never a live listener.
    allow_reuse_address = True
    daemon_threads = True


def serve(vault, port):
    """The stand-in's HTTP stub, the part of the Vault service the backend calls."""

    class Handler(BaseHTTPRequestHandler):
        def _answer(self, status, body):
            data = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            self._answer(200, {"ok": True}) if self.path == "/vault/health" else self._answer(404, {"code": "not_found", "message": "No such route"})

        def do_POST(self):
            payload = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            parts = self.path.strip("/").split("/")
            if len(parts) != 3 or parts[0] != "vault" or parts[2] not in ("invoice", "refresh"):
                return self._answer(404, {"code": "not_found", "message": "No such route"})
            wallet_id, action = parts[1], parts[2]
            vault.calls.append((wallet_id, action, payload))
            try:
                if action == "invoice":
                    return self._answer(200, vault.invoice(payload["asset_id"], payload["amount"]))
                vault.refresh()
                return self._answer(200, {"wallet_id": wallet_id, "exists": True, "unlocked": True})
            except Exception as exc:
                return self._answer(500, {"code": "internal", "message": str(exc)})

        def log_message(self, *args):
            pass

    server = StubServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True).start()
    return server


def port_in_use(port):
    with socket.socket() as s:
        return s.connect_ex(("127.0.0.1", port)) == 0


def wallet_state(backend, wallet_id, asset_id):
    state = requests.get(f"{backend}/api/wallets/{wallet_id}", timeout=30).json()
    amount = next((a["amount"] for a in state["assets"] if a["asset_id"] == asset_id), 0)
    return amount, state["activity"]


def main():
    parser = argparse.ArgumentParser(description="E2E Vault link on regtest, with a stand-in Vault.")
    parser.add_argument("--backend", default="http://127.0.0.1:8101")
    parser.add_argument("--vault-port", type=int, default=8201, help="the port of the backend's VAULT_URL")
    parser.add_argument("--wallet", default="wallet_a")
    parser.add_argument("--asset", default="USDT", choices=("USDT", "PEPE"))
    parser.add_argument("--amount", type=int, default=25)
    parser.add_argument("--data-dir", help="stand-in wallet dir (default: a new temp dir, removed on PASS)")
    args = parser.parse_args()
    backend, wallet_id, amount = args.backend.rstrip("/"), args.wallet, args.amount

    print("=" * 64)
    print(f"MWM E2E VAULT LINK: {wallet_id} <-> stand-in Vault, {amount} {args.asset}")
    print("=" * 64)
    if port_in_use(args.vault_port):
        print(f"Port {args.vault_port} is in use (the real Vault service?). Start a backend with VAULT_URL on a free "
              f"port and pass it as --vault-port; this script never shadows a running Vault.")
        return 2
    if not requests.get(f"{backend}/api/health", timeout=30).json().get("regtest"):
        print(f"{backend} reports regtest offline.")
        return 2
    asset_id = next(a["asset_id"] for a in requests.get(f"{backend}/api/market", timeout=30).json()["assets"] if a["ticker"] == args.asset)
    start_amount, _ = wallet_state(backend, wallet_id, asset_id)
    print(f"{wallet_id} holds {start_amount} {args.asset} ({asset_id})")
    if start_amount < amount:
        print(f"{wallet_id} needs at least {amount} {args.asset}.")
        return 2

    data_dir = args.data_dir or tempfile.mkdtemp(prefix="mwm-e2e-vault-")
    os.makedirs(data_dir, exist_ok=True)
    print(f"\n[Setup] Stand-in Vault in {data_dir}: funding it and creating colorable UTXOs...")
    vault = StandInVault(data_dir)
    vault.fund()
    server = serve(vault, args.vault_port)
    try:
        print(f"\n[1] Wallet -> Vault: POST {backend}/api/wallets/{wallet_id}/move_to_vault")
        t0 = time.time()
        resp = requests.post(f"{backend}/api/wallets/{wallet_id}/move_to_vault", json={"asset_id": asset_id, "amount": amount}, timeout=300)
        body = resp.json()
        print(f"  -> {resp.status_code} {body} in {time.time() - t0:.1f}s")
        txid_out = body.get("txid")
        check("move_to_vault answers 200 with a txid", resp.status_code == 200 and txid_out, body)
        actions = [(w, a) for w, a, _ in vault.calls]
        if not check("the backend asked this Vault for the invoice, then for a refresh",
                     actions == [(wallet_id, "invoice"), (wallet_id, "refresh")], actions):
            if not vault.calls:
                print(f"  The stand-in got no call: is the backend's VAULT_URL http://127.0.0.1:{args.vault_port}?")
        check("the invoice was asked for this asset and amount",
              vault.calls[:1] and vault.calls[0][2] == {"asset_id": asset_id, "amount": amount}, vault.calls[:1])
        check(f"the Vault holds {amount} {args.asset}", vault.balance(asset_id) == amount, vault.balance(asset_id))
        after_out, activity = wallet_state(backend, wallet_id, asset_id)
        check(f"{wallet_id} balance dropped by {amount}", after_out == start_amount - amount, f"{start_amount} -> {after_out}")
        item = activity[0] if activity else {}
        check("activity: vault / out with the txid and no counterparty",
              (item.get("kind"), item.get("direction"), item.get("amount"), item.get("txid"), item.get("counterparty_address"))
              == ("vault", "out", amount, txid_out, None), item)

        print(f"\n[2] Vault -> Wallet: POST {backend}/api/wallets/{wallet_id}/receive_invoice, the Vault pays, then refresh")
        t0 = time.time()
        resp = requests.post(f"{backend}/api/wallets/{wallet_id}/receive_invoice", json={"asset_id": asset_id, "amount": amount}, timeout=300)
        receive = resp.json()
        print(f"  -> {resp.status_code} invoice {str(receive.get('invoice'))[:60]}... expires_at {receive.get('expires_at')}")
        check("receive_invoice answers 200 with an invoice for this asset and amount",
              resp.status_code == 200 and receive.get("invoice") and (receive.get("asset_id"), receive.get("amount")) == (asset_id, amount), receive)
        data = rgb_lib.Invoice(receive["invoice"]).invoice_data()
        check("the invoice is a blind receive of exactly that amount",
              rgb_lib.RecipientInfo(data.recipient_id).recipient_type() == rgb_lib.RecipientType.BLIND
              and data.assignment == rgb_lib.Assignment.FUNGIBLE(amount) and data.asset_id in (None, asset_id), data)
        txid_in = vault.pay(receive["invoice"], asset_id, amount)
        mine_blocks(1)
        resp = requests.post(f"{backend}/api/wallets/{wallet_id}/refresh", timeout=300)
        print(f"  -> paid (txid {txid_in}), refresh {resp.status_code} {resp.json()} in {time.time() - t0:.1f}s")
        check("refresh answers 200", resp.status_code == 200 and resp.json() == {"wallet_id": wallet_id, "refreshed": True}, resp.json())
        final, activity = wallet_state(backend, wallet_id, asset_id)
        check(f"{wallet_id} balance is back to {start_amount}", final == start_amount, f"{after_out} -> {final}")
        item = activity[0] if activity else {}
        check("activity: vault / in with the Vault's txid",
              (item.get("kind"), item.get("direction"), item.get("amount"), item.get("txid")) == ("vault", "in", amount, txid_in), item)
        requests.post(f"{backend}/api/wallets/{wallet_id}/refresh", timeout=300)
        check("a second refresh records nothing twice", len(wallet_state(backend, wallet_id, asset_id)[1]) == len(activity))
        vault.refresh()
        check("the Vault is empty again", vault.balance(asset_id) == 0, vault.balance(asset_id))
    finally:
        server.shutdown()
        server.server_close()

    passed = all(RESULTS)
    print("\n" + "=" * 64)
    print(f"RESULT: {'PASS' if passed else 'FAIL'} ({sum(RESULTS)}/{len(RESULTS)} checks)")
    print("=" * 64)
    if passed and not args.data_dir:
        shutil.rmtree(data_dir, ignore_errors=True)
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(main())
