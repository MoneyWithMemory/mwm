#!/usr/bin/env python3
"""
Directional Test: RgbForRgb
Topology:
- Maker issues Asset A (100 units), gives 100 Asset A, receives 50 Asset B
- Taker issues Asset B (50 units), gives 50 Asset B, receives 100 Asset A
- Both execute on-chain swap and accept transfers
- Both refresh to settled
- Verification of cross-respend:
  * Maker spends 10 Asset B to Wallet 3
  * Taker spends 20 Asset A to Wallet 4
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

DIR_MAKER = "/tmp/mwm_rgb_for_rgb_maker"
DIR_TAKER = "/tmp/mwm_rgb_for_rgb_taker"
DIR_WALLET3 = "/tmp/mwm_rgb_for_rgb_wallet3"
DIR_WALLET4 = "/tmp/mwm_rgb_for_rgb_wallet4"

MAKER_RGB_AMOUNT = 100
TAKER_RGB_AMOUNT = 50
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
    print("DIRECTIONAL TEST: RGB <-> RGB (SYMMETRIC SWAP & RE-SPEND)")
    print("=" * 80)

    # 1. SETUP WALLETS
    print("\n[Step 1] Inizializzazione dei wallet...")
    maker, maker_online = create_wallet(DIR_MAKER)
    taker, taker_online = create_wallet(DIR_TAKER)
    w3, w3_online = create_wallet(DIR_WALLET3)
    w4, w4_online = create_wallet(DIR_WALLET4)

    fund_address(maker.get_address(), "1.0")
    fund_address(taker.get_address(), "1.0")
    fund_address(w3.get_address(), "1.0")
    fund_address(w4.get_address(), "1.0")

    maker.create_utxos(maker_online, False, 5, 10_000, FEE_RATE, False)
    taker.create_utxos(taker_online, False, 5, 10_000, FEE_RATE, False)
    w3.create_utxos(w3_online, False, 5, 10_000, FEE_RATE, False)
    w4.create_utxos(w4_online, False, 5, 10_000, FEE_RATE, False)
    mine_blocks(2)

    # 2. ISSUE ASSETS
    print("\n[Step 2] Emissione Asset A su Maker e Asset B su Taker...")
    asset_a = maker.issue_asset_nia(
        ticker="ASSTA",
        name="Asset A (Maker)",
        precision=0,
        amounts=[MAKER_RGB_AMOUNT],
    )
    asset_a_id = asset_a.asset_id

    asset_b = taker.issue_asset_nia(
        ticker="ASSTB",
        name="Asset B (Taker)",
        precision=0,
        amounts=[TAKER_RGB_AMOUNT],
    )
    asset_b_id = asset_b.asset_id
    mine_blocks(1)
    print(f"  Maker Asset A ID: {asset_a_id} (100 units)")
    print(f"  Taker Asset B ID: {asset_b_id} (50 units)")

    # 3. ON-CHAIN SWAP RGB <-> RGB
    print("\n[Step 3] Esecuzione protocollo On-Chain Swap (RgbForRgb)...")
    maker_gives = rgb_lib.OnchainSwapLeg(
        kind=rgb_lib.OnchainSwapLegKind.RGB,
        asset_id=asset_a_id,
        amount=MAKER_RGB_AMOUNT,
    )
    maker_receives = rgb_lib.OnchainSwapLeg(
        kind=rgb_lib.OnchainSwapLegKind.RGB,
        asset_id=asset_b_id,
        amount=TAKER_RGB_AMOUNT,
    )

    print("  Maker: create_swap_offer...")
    offer = maker.create_swap_offer(
        maker_gives=maker_gives,
        maker_receives=maker_receives,
        network_fee_sat=SWAP_FEE,
        expiration_timestamp=None,
        proxy_url=PROXY_URL,
    )

    print("  Taker: accept_swap_offer...")
    request = taker.accept_swap_offer(
        online=taker_online,
        offer=offer,
        min_confirmations=0,
        skip_sync=False,
    )

    print("  Maker: accept_swap_request...")
    proposal = maker.accept_swap_request(
        online=maker_online,
        request=request,
        min_confirmations=0,
        skip_sync=False,
    )

    print("  Taker: complete_swap_proposal...")
    completion = taker.complete_swap_proposal(
        online=taker_online,
        proposal=proposal,
        min_confirmations=0,
        skip_sync=False,
    )

    print("  Maker: process_swap_completion...")
    finalized = maker.process_swap_completion(
        online=maker_online,
        completion=completion,
    )

    print("  Maker: broadcast_swap_completion...")
    txid = maker.broadcast_swap_completion(
        online=maker_online,
        completion=finalized,
    )
    print(f"  Swap Broadcast riuscito! TXID: {txid}")
    mine_blocks(2)

    # 4. ACCEPTS TRANSFERS & REFRESH ON BOTH SIDES
    print("\n[Step 4] Entrambi i wallet accettano i trasferimenti swap e aggiornano i saldi...")
    print("  Taker: accept_swap_transfers (role=TAKER)...")
    taker.accept_swap_transfers(
        online=taker_online,
        completion=finalized,
        role=rgb_lib.OnchainSwapRole.TAKER,
        skip_sync=False,
    )

    print("  Maker: accept_swap_transfers (role=MAKER)...")
    maker.accept_swap_transfers(
        online=maker_online,
        completion=finalized,
        role=rgb_lib.OnchainSwapRole.MAKER,
        skip_sync=False,
    )
    mine_blocks(1)

    print("  Refresh saldi Taker...")
    taker.refresh(taker_online, None, [], False)
    mine_blocks(1)
    taker.refresh(taker_online, asset_a_id, [], False)

    print("  Refresh saldi Maker...")
    maker.refresh(maker_online, None, [], False)
    mine_blocks(1)
    maker.refresh(maker_online, asset_b_id, [], False)

    bal_taker_a = taker.get_asset_balance(asset_a_id)
    bal_maker_b = maker.get_asset_balance(asset_b_id)
    print(f"  Taker saldo Asset A: settled={bal_taker_a.settled}, future={bal_taker_a.future}")
    print(f"  Maker saldo Asset B: settled={bal_maker_b.settled}, future={bal_maker_b.future}")
    assert bal_taker_a.settled == MAKER_RGB_AMOUNT, f"Atteso {MAKER_RGB_AMOUNT} Asset A su Taker, ottenuto {bal_taker_a.settled}"
    assert bal_maker_b.settled == TAKER_RGB_AMOUNT, f"Atteso {TAKER_RGB_AMOUNT} Asset B su Maker, ottenuto {bal_maker_b.settled}"
    print("  >>> CONFERMATO: Entrambi i wallet hanno ricevuto e consolidato (SETTLED) gli asset scambiati!")

    # 5. CROSS RE-SPEND VERIFICATION
    print("\n[Step 5] Verifica Re-Spend Incrociata:")
    print("  A) Maker spende 10 Asset B (ricevuto da swap) a Wallet 3...")
    w3_rcv = w3.witness_receive(
        None,
        rgb_lib.Assignment.FUNGIBLE(10),
        None,
        [TRANSPORT_ENDPOINT],
        1,
    )
    maker_send = maker.send(
        maker_online,
        {
            asset_b_id: [
                rgb_lib.Recipient(
                    recipient_id=w3_rcv.recipient_id,
                    witness_data=rgb_lib.WitnessData(amount_sat=1000, blinding=None),
                    assignment=rgb_lib.Assignment.FUNGIBLE(10),
                    transport_endpoints=[TRANSPORT_ENDPOINT],
                )
            ]
        },
        True,
        FEE_RATE,
        1,
        None,
    )
    print(f"  Maker send ad Asset B riuscito! TXID: {maker_send.txid}")

    print("  B) Taker spende 20 Asset A (ricevuto da swap) a Wallet 4...")
    w4_rcv = w4.witness_receive(
        None,
        rgb_lib.Assignment.FUNGIBLE(20),
        None,
        [TRANSPORT_ENDPOINT],
        1,
    )
    taker_send = taker.send(
        taker_online,
        {
            asset_a_id: [
                rgb_lib.Recipient(
                    recipient_id=w4_rcv.recipient_id,
                    witness_data=rgb_lib.WitnessData(amount_sat=1000, blinding=None),
                    assignment=rgb_lib.Assignment.FUNGIBLE(20),
                    transport_endpoints=[TRANSPORT_ENDPOINT],
                )
            ]
        },
        True,
        FEE_RATE,
        1,
        None,
    )
    print(f"  Taker send ad Asset A riuscito! TXID: {taker_send.txid}")
    mine_blocks(3)

    w3.refresh(w3_online, None, [], False)
    w4.refresh(w4_online, None, [], False)
    mine_blocks(2)
    w3.refresh(w3_online, asset_b_id, [], False)
    w4.refresh(w4_online, asset_a_id, [], False)
    maker.refresh(maker_online, asset_b_id, [], False)
    taker.refresh(taker_online, asset_a_id, [], False)

    w3_bal = w3.get_asset_balance(asset_b_id)
    w4_bal = w4.get_asset_balance(asset_a_id)
    maker_rem = maker.get_asset_balance(asset_b_id)
    taker_rem = taker.get_asset_balance(asset_a_id)

    print(f"  Wallet 3 Asset B: settled={w3_bal.settled} (atteso: 10)")
    print(f"  Maker Asset B rimanente: settled={maker_rem.settled} (atteso: 40)")
    print(f"  Wallet 4 Asset A: settled={w4_bal.settled} (atteso: 20)")
    print(f"  Taker Asset A rimanente: settled={taker_rem.settled} (atteso: 80)")

    assert w3_bal.settled == 10
    assert maker_rem.settled == 40
    assert w4_bal.settled == 20
    assert taker_rem.settled == 80

    print("\n" + "=" * 80)
    print(">>> TEST RGB <-> RGB COMPLETATO CON SUCCESSO! <<<")
    print("1. Entrambi gli asset scambiati transitano a SETTLED.")
    print("2. La re-spesa degli output generati nello swap e' pienamente valida da entrambe le parti.")
    print("=" * 80)

if __name__ == "__main__":
    main()
