#!/usr/bin/env python3
"""
MWM Deep Feasibility Verification:
1. Isolate refresh() panic and compare SQLite persistence against normal RGB receive.
2. Investigate consignment recovery paths and API limitations.
3. Test the 5-point end-to-end success criteria.
"""

import os
import shutil
import subprocess
import time
import json
import sqlite3
import urllib.request
import rgb_lib

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_REGTEST = (
    os.path.join(_ROOT, "rgb-lib-python", "rgb-lib", "tests", "regtest.sh")
    if os.path.exists(os.path.join(_ROOT, "rgb-lib-python", "rgb-lib", "tests", "regtest.sh"))
    else os.path.join(_ROOT, "rgb-lib", "tests", "regtest.sh")
)
REGTEST_SCRIPT = os.getenv("REGTEST_SCRIPT", _DEFAULT_REGTEST)
COMPOSE_FILE = os.getenv("COMPOSE_FILE", os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "compose.yaml"))
ELECTRUM_URL = "127.0.0.1:50001"
PROXY_HTTP_URL = "http://127.0.0.1:3000/json-rpc"
PROXY_RPC_URL = "rpc://127.0.0.1:3000/json-rpc"
NETWORK = rgb_lib.BitcoinNetwork.REGTEST

DIR_MAKER_SWAP = "/tmp/mwm_feasi_maker"
DIR_TAKER_SWAP = "/tmp/mwm_feasi_taker"
DIR_NORMAL_SENDER = "/tmp/mwm_feasi_norm_sender"
DIR_NORMAL_RCVR = "/tmp/mwm_feasi_norm_rcvr"

SWAP_RGB_AMOUNT = 100
SWAP_BTC_PRICE = 68_000
SWAP_FEE = 2_000
FEE_RATE = 1

def run_regtest_cmd(*args):
    cmd = [REGTEST_SCRIPT] + list(args)
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return res.stdout.strip()

def mine_blocks(num=1):
    run_regtest_cmd("mine", str(num))
    time.sleep(0.5)

def fund_address(address, btc_amount="1.0"):
    run_regtest_cmd("sendtoaddress", address, str(btc_amount))
    mine_blocks(1)

def create_wallet(data_dir: str):
    if os.path.exists(data_dir):
        shutil.rmtree(data_dir)
    os.makedirs(data_dir, exist_ok=True)

    keys = rgb_lib.generate_keys(NETWORK, rgb_lib.WitnessVersion.SEG_WIT_V0)
    singlesig_keys = rgb_lib.SinglesigKeys(
        account_xpub_vanilla=keys.account_xpub_vanilla,
        account_xpub_colored=keys.account_xpub_colored,
        vanilla_keychain=1,
        master_fingerprint=keys.master_fingerprint,
        mnemonic=keys.mnemonic,
        witness_version=keys.witness_version,
    )
    wallet_data = rgb_lib.WalletData(
        data_dir=data_dir,
        bitcoin_network=NETWORK,
        database_type=rgb_lib.DatabaseType.SQLITE,
        max_allocations_per_utxo=5,
        supported_schemas=[rgb_lib.AssetSchema.NIA],
    )
    wallet = rgb_lib.Wallet(wallet_data, singlesig_keys)
    online_opts = rgb_lib.OnlineOptions(
        indexer_url=ELECTRUM_URL,
        skip_consistency_check=True,
        vanilla_sync_lookback=10,
    )
    online = wallet.go_online(online_opts)
    return wallet, online

def dump_wallet_db(data_dir: str):
    """Estrae i record rilevanti dal database SQLite del wallet"""
    subdirs = [d for d in os.listdir(data_dir) if os.path.isdir(os.path.join(data_dir, d))]
    if not subdirs:
        return {}
    db_path = os.path.join(data_dir, subdirs[0], "rgb_lib.db")
    if not os.path.exists(db_path):
        return {}
    
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()
    
    tables = ["batch_transfer", "asset_transfer", "transfer", "coloring", "txo"]
    dump = {}
    for t in tables:
        try:
            c.execute(f"SELECT * FROM {t}")
            rows = [dict(r) for r in c.fetchall()]
            dump[t] = rows
        except Exception as e:
            dump[t] = str(e)
    conn.close()
    return dump

def run_normal_rgb_receive():
    """Esegue un normale flusso di ricezione RGB per confrontare la persistenza DB"""
    print("\n" + "-"*60)
    print("ESECUZIONE NORMALE RICEZIONE RGB (BASELINE)")
    print("-"*60)
    sender, sender_online = create_wallet(DIR_NORMAL_SENDER)
    rcvr, rcvr_online = create_wallet(DIR_NORMAL_RCVR)

    fund_address(sender.get_address(), "1.0")
    fund_address(rcvr.get_address(), "1.0")

    sender.create_utxos(sender_online, False, 1, 10_000, FEE_RATE, False)
    rcvr.create_utxos(rcvr_online, False, 1, 10_000, FEE_RATE, False)
    mine_blocks(1)

    asset = sender.issue_asset_nia("BASE", "Baseline Asset", 0, [50])
    asset_id = asset.asset_id

    # Ricevente prepara blind receive
    receive_data = rcvr.blind_receive(None, rgb_lib.Assignment.ANY(), None, [PROXY_RPC_URL], 1)
    
    # Mittente invia 50 unità con donation=True (broadcast immediato)
    recipient = rgb_lib.Recipient(
        recipient_id=receive_data.recipient_id,
        witness_data=None,
        assignment=rgb_lib.Assignment.FUNGIBLE(50),
        transport_endpoints=[PROXY_RPC_URL],
    )
    send_res = sender.send(sender_online, {asset_id: [recipient]}, True, FEE_RATE, 1, None)
    mine_blocks(1)

    # Ricevente esegue refresh
    rcvr.refresh(rcvr_online, None, [], False)
    rcvr_balance = rcvr.get_asset_balance(asset_id)
    print(f"Normale Receive - Saldo dopo refresh: future={rcvr_balance.future}, settled={rcvr_balance.settled}")

    db_dump = dump_wallet_db(DIR_NORMAL_RCVR)
    return db_dump

def run_isolated_swap_test():
    """Esegue lo swap minimo isolando esattamente il panic di refresh()"""
    print("\n" + "-"*60)
    print("ESECUZIONE SWAP TEST E ISOLAMENTO PANIC REFRESH()")
    print("-"*60)
    maker, maker_online = create_wallet(DIR_MAKER_SWAP)
    taker, taker_online = create_wallet(DIR_TAKER_SWAP)

    fund_address(maker.get_address(), "1.0")
    fund_address(taker.get_address(), "1.0")

    maker.create_utxos(maker_online, False, 1, 10_000, FEE_RATE, False)
    mine_blocks(1)
    asset = maker.issue_asset_nia("SWAP", "Swap Feasibility Asset", 0, [SWAP_RGB_AMOUNT])
    asset_id = asset.asset_id

    leg_rgb = rgb_lib.OnchainSwapLeg(kind=rgb_lib.OnchainSwapLegKind.RGB, asset_id=asset_id, amount=SWAP_RGB_AMOUNT)
    leg_btc = rgb_lib.OnchainSwapLeg(kind=rgb_lib.OnchainSwapLegKind.BTC, asset_id=None, amount=SWAP_BTC_PRICE)

    offer = maker.create_swap_offer(leg_rgb, leg_btc, SWAP_FEE, None, PROXY_HTTP_URL)
    request = taker.accept_swap_offer(taker_online, offer, 0, False)
    proposal = maker.accept_swap_request(maker_online, request, 0, False)
    completion = taker.complete_swap_proposal(taker_online, proposal, 0, False)
    finalized = maker.process_swap_completion(maker_online, completion)

    txid = maker.broadcast_swap_completion(maker_online, finalized)
    mine_blocks(1)
    print(f"1. Transazione Bitcoin confermata su regtest: {txid}")

    # accept_swap_transfers
    taker.accept_swap_transfers(taker_online, finalized, rgb_lib.OnchainSwapRole.TAKER, False)
    print("2. accept_swap_transfers completato con successo.")

    # Dump del database del Taker SUBITO DOPO accept_swap_transfers (prima del crash)
    taker_db_before_refresh = dump_wallet_db(DIR_TAKER_SWAP)

    # Verifica saldo prima del refresh
    bal_pre = taker.get_asset_balance(asset_id)
    print(f"3. Bilancio Taker pre-refresh: future={bal_pre.future}, settled={bal_pre.settled}")

    # Tentativo di spendere prima del refresh
    print("\n4. Test Re-spendibilità pre-refresh:")
    respend_pre_error = None
    try:
        # Tenta di spendere verso un dummy recipient
        dummy_keys = rgb_lib.generate_keys(NETWORK, rgb_lib.WitnessVersion.SEG_WIT_V0)
        # Proviamo a inviare verso se stessi o un dummy recipient
        taker.send(taker_online, {asset_id: []}, True, FEE_RATE, 0, None)
    except Exception as e:
        respend_pre_error = f"{type(e).__name__}: {e}"
        print(f"   Re-spend pre-refresh respinto: {respend_pre_error}")

    # Tentativo di refresh (questo innesca il panic isolato)
    print("\n5. Invocazione taker.refresh() per far transitare il transfer a settled:")
    refresh_error = None
    try:
        taker.refresh(taker_online, None, [], False)
        print("   taker.refresh completato senza errori!")
    except Exception as e:
        refresh_error = f"{type(e).__name__}: {e}"
        print(f"   PANIC RILEVATO: {refresh_error}")

    return {
        "asset_id": asset_id,
        "txid": txid,
        "bal_pre": {"future": bal_pre.future, "settled": bal_pre.settled},
        "respend_pre_error": respend_pre_error,
        "refresh_error": refresh_error,
        "taker_db": taker_db_before_refresh,
    }

if __name__ == "__main__":
    os.environ["RUST_BACKTRACE"] = "1"
    norm_db = run_normal_rgb_receive()
    swap_res = run_isolated_swap_test()

    print("\n" + "="*80)
    print("CONFRONTO COMPARATIVO RECORD DATABASE SQLITE")
    print("="*80)

    print("\n--- [NORMALE RICEZIONE RGB] Tabelle del Ricevente:")
    print(f"batch_transfer: {json.dumps(norm_db.get('batch_transfer'), indent=2)}")
    print(f"asset_transfer: {json.dumps(norm_db.get('asset_transfer'), indent=2)}")
    print(f"transfer:       {json.dumps(norm_db.get('transfer'), indent=2)}")
    print(f"coloring:       {json.dumps(norm_db.get('coloring'), indent=2)}")

    print("\n--- [ON-CHAIN SWAP RICEZIONE] Tabelle del Ricevente (Taker):")
    taker_db = swap_res["taker_db"]
    print(f"batch_transfer: {json.dumps(taker_db.get('batch_transfer'), indent=2)}")
    print(f"asset_transfer: {json.dumps(taker_db.get('asset_transfer'), indent=2)}")
    print(f"transfer:       {json.dumps(taker_db.get('transfer'), indent=2)}")
    print(f"coloring:       {json.dumps(taker_db.get('coloring'), indent=2)}")

    print("\n" + "="*80)
    print("ANALISI INVARIANTE VIOLATA:")
    norm_transfers = norm_db.get('transfer', [])
    swap_transfers = taker_db.get('transfer', [])
    print(f"Numero di record nella tabella 'transfer' per Normale Receive: {len(norm_transfers)}")
    print(f"Numero di record nella tabella 'transfer' per Swap Receive:    {len(swap_transfers)}")
    if len(swap_transfers) == 0:
        print("CONFERMA EMPIRICA: La tabella 'transfer' e' COMPLETAMENTE VUOTA nel wallet swap!")
        print("Quando get_incoming_transfer() esegue:")
        print("    asset_transfer_data.transfers.first().expect('transfer should be connected to an asset transfer')")
        print("la collezione e' vuota e genera il panic incondizionato.")
