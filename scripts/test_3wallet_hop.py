#!/usr/bin/env python3
"""
3-Wallet Hop Full Test:
Maker -> On-Chain Swap (RGB for BTC) -> Taker -> refresh() (settled) -> Partial Send (20 RGB) -> Wallet 3 -> refresh() (settled) -> Re-spend to Wallet 4
"""

import os
import shutil
import subprocess
import time
import rgb_lib

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_REGTEST = (
    os.path.join(_ROOT, "rgb-lib-python", "rgb-lib", "tests", "regtest.sh")
    if os.path.exists(os.path.join(_ROOT, "rgb-lib-python", "rgb-lib", "tests", "regtest.sh"))
    else os.path.join(_ROOT, "rgb-lib", "tests", "regtest.sh")
)
REGTEST_SCRIPT = os.getenv("REGTEST_SCRIPT", _DEFAULT_REGTEST)
ELECTRUM_URL = "127.0.0.1:50001"
PROXY_URL = "http://127.0.0.1:3000/json-rpc"
TRANSPORT_ENDPOINT = "rpc://127.0.0.1:3000/json-rpc"
NETWORK = rgb_lib.BitcoinNetwork.REGTEST

DIR_MAKER = "/tmp/mwm_hop_maker"
DIR_TAKER = "/tmp/mwm_hop_taker"
DIR_WALLET3 = "/tmp/mwm_hop_wallet3"
DIR_WALLET4 = "/tmp/mwm_hop_wallet4"

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

def main():
    print("=" * 80)
    print("MWM 3-WALLET HOP FULL VALIDATION TEST")
    print("=" * 80)

    # 1. SETUP WALLETS
    print("\n[Step 1] Inizializzazione di 4 Wallet indipendenti...")
    maker, maker_online = create_wallet(DIR_MAKER)
    taker, taker_online = create_wallet(DIR_TAKER)
    w3, w3_online = create_wallet(DIR_WALLET3)
    w4, w4_online = create_wallet(DIR_WALLET4)

    fund_address(maker.get_address(), "1.0")
    fund_address(taker.get_address(), "1.0")
    fund_address(w3.get_address(), "1.0")
    fund_address(w4.get_address(), "1.0")

    maker.create_utxos(maker_online, False, 1, 10_000, FEE_RATE, False)
    taker.create_utxos(taker_online, False, 1, 10_000, FEE_RATE, False)
    w3.create_utxos(w3_online, False, 1, 10_000, FEE_RATE, False)
    w4.create_utxos(w4_online, False, 1, 10_000, FEE_RATE, False)
    mine_blocks(2)

    # 2. ISSUE ASSET
    print("\n[Step 2] Emissione Asset RGB su Maker (100 unità)...")
    asset = maker.issue_asset_nia(
        ticker="MWM",
        name="MwM Feasibility Token",
        precision=0,
        amounts=[SWAP_RGB_AMOUNT],
    )
    asset_id = asset.asset_id
    mine_blocks(1)
    print(f"  Asset ID: {asset_id}")

    # 3. ON-CHAIN SWAP: MAKER (gives 100 RGB) <-> TAKER (gives 68,000 sats BTC)
    print("\n[Step 3] Esecuzione protocollo On-Chain Swap (PR #85)...")
    maker_gives = rgb_lib.OnchainSwapLeg(
        kind=rgb_lib.OnchainSwapLegKind.RGB,
        asset_id=asset_id,
        amount=SWAP_RGB_AMOUNT,
    )
    maker_receives = rgb_lib.OnchainSwapLeg(
        kind=rgb_lib.OnchainSwapLegKind.BTC,
        asset_id=None,
        amount=SWAP_BTC_PRICE,
    )

    offer = maker.create_swap_offer(
        maker_gives=maker_gives,
        maker_receives=maker_receives,
        network_fee_sat=SWAP_FEE,
        expiration_timestamp=None,
        proxy_url=PROXY_URL,
    )
    request = taker.accept_swap_offer(
        online=taker_online,
        offer=offer,
        min_confirmations=0,
        skip_sync=False,
    )
    proposal = maker.accept_swap_request(
        online=maker_online,
        request=request,
        min_confirmations=0,
        skip_sync=False,
    )
    completion = taker.complete_swap_proposal(
        online=taker_online,
        proposal=proposal,
        min_confirmations=0,
        skip_sync=False,
    )
    finalized = maker.process_swap_completion(
        online=maker_online,
        completion=completion,
    )
    txid = maker.broadcast_swap_completion(
        online=maker_online,
        completion=finalized,
    )
    print(f"  Swap Broadcast riuscito! TXID: {txid}")
    mine_blocks(2)

    # 4. TAKER ACCEPTS SWAP TRANSFERS & REFRESH TO SETTLED
    print("\n[Step 4] Taker: accept_swap_transfers e refresh()...")
    taker.accept_swap_transfers(
        online=taker_online,
        completion=finalized,
        role=rgb_lib.OnchainSwapRole.TAKER,
        skip_sync=False,
    )
    mine_blocks(1)

    bal_pre = taker.get_asset_balance(asset_id)
    print(f"  Taker saldo pre-refresh: future={bal_pre.future}, settled={bal_pre.settled}")

    print("  Invocazione taker.refresh()...")
    taker.refresh(taker_online, asset_id, [], False)
    mine_blocks(1)
    taker.refresh(taker_online, asset_id, [], False)

    bal_post = taker.get_asset_balance(asset_id)
    print(f"  Taker saldo post-refresh: future={bal_post.future}, settled={bal_post.settled}")
    assert bal_post.settled == SWAP_RGB_AMOUNT, f"Atteso settled={SWAP_RGB_AMOUNT}, ottenuto {bal_post.settled}"
    print("  >>> CONFERMATO: Lo swap e' SETTLED al 100% nel wallet del Taker!")

    # 5. HOP 2: TAKER -> WALLET 3 (Spesa parziale di 20 RGB)
    print("\n[Step 5] Hop 2: Taker spende parzialmente 20 RGB verso Wallet 3...")
    w3_rcv = w3.witness_receive(
        None,
        rgb_lib.Assignment.FUNGIBLE(20),
        None,
        [TRANSPORT_ENDPOINT],
        1,
    )
    recipient_map = {
        asset_id: [
            rgb_lib.Recipient(
                recipient_id=w3_rcv.recipient_id,
                witness_data=rgb_lib.WitnessData(
                    amount_sat=1000,
                    blinding=None,
                ),
                assignment=rgb_lib.Assignment.FUNGIBLE(20),
                transport_endpoints=[TRANSPORT_ENDPOINT],
            )
        ]
    }
    send_res = taker.send(taker_online, recipient_map, True, FEE_RATE, 1, None)
    print(f"  Invio da Taker a Wallet 3 completato! TXID: {send_res.txid}")
    mine_blocks(3)

    w3.refresh(w3_online, None, [], False)
    mine_blocks(2)
    w3.refresh(w3_online, asset_id, [], False)
    taker.refresh(taker_online, asset_id, [], False)

    w3_bal = w3.get_asset_balance(asset_id)
    taker_remaining = taker.get_asset_balance(asset_id)
    print(f"  Wallet 3 post-refresh: settled={w3_bal.settled}, future={w3_bal.future}")
    print(f"  Taker post-refresh rimanente: settled={taker_remaining.settled}, future={taker_remaining.future}")
    assert w3_bal.settled == 20, f"Atteso 20 settled su Wallet 3, ottenuto {w3_bal.settled}"
    assert taker_remaining.settled == 80, f"Atteso 80 settled su Taker, ottenuto {taker_remaining.settled}"
    print("  >>> CONFERMATO: Spesa parziale riuscita! Taker rimasti 80, Wallet 3 ricevuti 20.")

    # 6. HOP 3: WALLET 3 -> WALLET 4 (Re-spesa di 20 RGB)
    print("\n[Step 6] Hop 3: Wallet 3 spende 20 RGB verso Wallet 4...")
    w4_rcv = w4.witness_receive(
        None,
        rgb_lib.Assignment.FUNGIBLE(20),
        None,
        [TRANSPORT_ENDPOINT],
        1,
    )
    recipient_map_w4 = {
        asset_id: [
            rgb_lib.Recipient(
                recipient_id=w4_rcv.recipient_id,
                witness_data=rgb_lib.WitnessData(
                    amount_sat=1000,
                    blinding=None,
                ),
                assignment=rgb_lib.Assignment.FUNGIBLE(20),
                transport_endpoints=[TRANSPORT_ENDPOINT],
            )
        ]
    }
    send_w4 = w3.send(w3_online, recipient_map_w4, True, FEE_RATE, 1, None)
    print(f"  Invio da Wallet 3 a Wallet 4 completato! TXID: {send_w4.txid}")
    mine_blocks(3)

    w4.refresh(w4_online, None, [], False)
    mine_blocks(2)
    w4.refresh(w4_online, asset_id, [], False)
    w3.refresh(w3_online, asset_id, [], False)

    w4_bal = w4.get_asset_balance(asset_id)
    w3_bal_final = w3.get_asset_balance(asset_id)
    print(f"  Wallet 4 saldo finale: settled={w4_bal.settled}")
    print(f"  Wallet 3 saldo finale: settled={w3_bal_final.settled}")
    assert w4_bal.settled == 20, f"Atteso 20 settled su Wallet 4, ottenuto {w4_bal.settled}"
    assert w3_bal_final.settled == 0, f"Atteso 0 settled su Wallet 3, ottenuto {w3_bal_final.settled}"

    print("\n" + "=" * 80)
    print(">>> TUTTI I REQUISITI DIMOSTRATI CON SUCCESSO! <<<")
    print("1. Lo swap PR #85 atterra e transita regolarmente a SETTLED.")
    print("2. L'asset ottenuto tramite swap e' SPENDIBILE parzialmente (80 restanti, 20 inviati).")
    print("3. Il terzo wallet riceve e puo' a sua volta RE-SPENDERE l'asset senza problemi.")
    print("=" * 80)

if __name__ == "__main__":
    main()
