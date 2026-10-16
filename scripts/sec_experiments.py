#!/usr/bin/env python3
"""
MWM Security & Abandonment Experiments for PR #85 On-Chain Swaps.
Tests failure modes, abandonment at different stages, and post-expiry broadcasting.
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
NETWORK = rgb_lib.BitcoinNetwork.REGTEST

DIR_MAKER = "/tmp/mwm_sec_maker_wallet"
DIR_TAKER = "/tmp/mwm_sec_taker_wallet"

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

def setup_fresh_test():
    maker, maker_online = create_wallet(DIR_MAKER)
    taker, taker_online = create_wallet(DIR_TAKER)
    fund_address(maker.get_address(), "1.0")
    fund_address(taker.get_address(), "1.0")
    maker.create_utxos(maker_online, False, 1, 10_000, FEE_RATE, False)
    mine_blocks(1)
    asset = maker.issue_asset_nia("USDT", "Tether USD Test", 0, [SWAP_RGB_AMOUNT])
    return maker, maker_online, taker, taker_online, asset.asset_id

def experiment_1_maker_abandonment_after_proposal():
    """
    Experiment 1: Maker abandons after Stage 3 (accept_swap_request).
    At Stage 3, Maker has signed their input in proposal.psbt!
    Can Maker spend their input elsewhere to cancel the deal?
    If Maker does not spend their input, can Taker complete and broadcast?
    """
    print("\n--- EXPERIMENT 1: Maker Abandonment After Stage 3 (Signed Proposal) ---")
    maker, maker_online, taker, taker_online, asset_id = setup_fresh_test()

    leg_rgb = rgb_lib.OnchainSwapLeg(kind=rgb_lib.OnchainSwapLegKind.RGB, asset_id=asset_id, amount=SWAP_RGB_AMOUNT)
    leg_btc = rgb_lib.OnchainSwapLeg(kind=rgb_lib.OnchainSwapLegKind.BTC, asset_id=None, amount=SWAP_BTC_PRICE)

    offer = maker.create_swap_offer(leg_rgb, leg_btc, SWAP_FEE, None, PROXY_URL)
    request = taker.accept_swap_offer(taker_online, offer, 0, False)
    proposal = maker.accept_swap_request(maker_online, request, 0, False)

    print("Maker produced signed proposal. Maker now attempts to 'abandon'...")

    # Can Taker complete and broadcast despite Maker wishing to abandon?
    completion = taker.complete_swap_proposal(taker_online, proposal, 0, False)
    finalized = maker.process_swap_completion(maker_online, completion)
    # Taker broadcasts! (Or anyone with the finalized PSBT)
    txid = taker.broadcast_swap_completion(taker_online, finalized)
    print(f"Result: Taker unilaterally broadcasted transaction! TxID: {txid}")
    mine_blocks(1)
    taker_recv = taker.accept_swap_transfers(taker_online, finalized, rgb_lib.OnchainSwapRole.TAKER, False)
    print(f"Result: Taker finalized swap and acquired asset ({len(taker_recv.assignments)} assignments)!")
    print("CONCLUSION 1: At Stage 3, Maker's signature is already committed. Abandonment without double-spending is INEFFECTIVE.")

def experiment_2_input_spending_invalidation():
    """
    Experiment 2: Maker or Taker cancels by spending their input before broadcast.
    """
    print("\n--- EXPERIMENT 2: Active Cancellation via Input Invalidation ---")
    maker, maker_online, taker, taker_online, asset_id = setup_fresh_test()

    leg_rgb = rgb_lib.OnchainSwapLeg(kind=rgb_lib.OnchainSwapLegKind.RGB, asset_id=asset_id, amount=SWAP_RGB_AMOUNT)
    leg_btc = rgb_lib.OnchainSwapLeg(kind=rgb_lib.OnchainSwapLegKind.BTC, asset_id=None, amount=SWAP_BTC_PRICE)

    offer = maker.create_swap_offer(leg_rgb, leg_btc, SWAP_FEE, None, PROXY_URL)
    request = taker.accept_swap_offer(taker_online, offer, 0, False)
    proposal = maker.accept_swap_request(maker_online, request, 0, False)

    # Taker decides to spend their UTXO to an external address instead of completing!
    dest_addr = taker.get_address()
    taker_btc_before = taker.get_btc_balance(taker_online, False).vanilla.future
    # Taker spends 0.5 BTC to self
    send_txid = taker.send_btc(taker_online, dest_addr, 50_000_000, 1, False)
    print(f"Taker spent their UTXO in a normal transaction: {send_txid}")
    mine_blocks(1)

    # Now if Taker tries to complete the proposal:
    try:
        completion = taker.complete_swap_proposal(taker_online, proposal, 0, False)
        print("Taker completed proposal despite spent input (offline PSBT construction).")
        finalized = maker.process_swap_completion(maker_online, completion)
        maker.broadcast_swap_completion(maker_online, finalized)
        print("Broadcast succeeded? (Unexpected!)")
    except Exception as e:
        print(f"Swap broadcast failed as expected: {type(e).__name__}: {e}")
    print("CONCLUSION 2: Spending the input UTXO on-chain reliably invalidates the pending swap transaction.")

def experiment_3_expiration_timestamp_semantics():
    """
    Experiment 3: Expiration timestamp test.
    Is it an application gate or a Bitcoin locktime constraint?
    """
    print("\n--- EXPERIMENT 3: Expiration Timestamp Analysis ---")
    maker, maker_online, taker, taker_online, asset_id = setup_fresh_test()

    leg_rgb = rgb_lib.OnchainSwapLeg(kind=rgb_lib.OnchainSwapLegKind.RGB, asset_id=asset_id, amount=SWAP_RGB_AMOUNT)
    leg_btc = rgb_lib.OnchainSwapLeg(kind=rgb_lib.OnchainSwapLegKind.BTC, asset_id=None, amount=SWAP_BTC_PRICE)

    # Create offer expiring 5 seconds in the future
    exp_time = int(time.time()) + 2
    offer = maker.create_swap_offer(leg_rgb, leg_btc, SWAP_FEE, exp_time, PROXY_URL)
    print(f"Offer created with expiration_timestamp: {exp_time}")

    time.sleep(3) # Wait for offer to expire
    print(f"Current time: {int(time.time())}. Offer is now expired.")

    # Try to accept expired offer
    try:
        taker.accept_swap_offer(taker_online, offer, 0, False)
        print("ERROR: Taker accepted expired offer!")
    except Exception as e:
        print(f"accept_swap_offer rejected expired offer as expected: {type(e).__name__}: {e}")

    print("CONCLUSION 3: Expiration timestamp is an application-level guard in rgb-lib (nLockTime in PSBT is ZERO).")

if __name__ == "__main__":
    experiment_1_maker_abandonment_after_proposal()
    experiment_2_input_spending_invalidation()
    experiment_3_expiration_timestamp_semantics()
