#!/usr/bin/env python3
"""
MWM - E2E On-chain Swap (RGB for BTC) on Bitcoin Regtest
Using PR #85 onchain swap engine through python bindings.
"""

import os
import shutil
import subprocess
import time
import rgb_lib

# Paths and URLs
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

DIR_MAKER = "/tmp/mwm_e2e_maker_wallet"
DIR_TAKER = "/tmp/mwm_e2e_taker_wallet"

# Swap parameters
SWAP_RGB_AMOUNT = 100
SWAP_BTC_PRICE = 68_000
SWAP_FEE = 2_000
FEE_RATE = 1  # 1 sat/vB

def run_regtest_cmd(*args):
    """Invoke regtest.sh helper commands (mine, sendtoaddress)."""
    cmd = [REGTEST_SCRIPT] + list(args)
    res = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return res.stdout.strip()

def mine_blocks(num=1):
    run_regtest_cmd("mine", str(num))
    time.sleep(0.5)

def fund_address(address, btc_amount="1.0"):
    run_regtest_cmd("sendtoaddress", address, str(btc_amount))
    mine_blocks(1)

def create_wallet(data_dir: str, label: str):
    """Initialize an independent wallet with fresh keys and separate directory."""
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

def get_total_btc(wallet, online) -> int:
    """Total BTC: vanilla.future + colored.future (mirrors Rust total_btc)."""
    btc_bal = wallet.get_btc_balance(online, False)
    return btc_bal.vanilla.future + btc_bal.colored.future

def get_asset_amount(wallet, asset_id: str) -> int:
    """Asset amount: balance.future (mirrors Rust asset_amount)."""
    bal = wallet.get_asset_balance(asset_id)
    return bal.future

def main():
    print("=" * 60)
    print("MWM E2E ON-CHAIN SWAP TEST (RGB FOR BTC)")
    print("=" * 60)

    # 1. Setup Wallets
    print("\n[Step 1] Initializing Maker and Taker wallets...")
    maker, maker_online = create_wallet(DIR_MAKER, "Maker")
    taker, taker_online = create_wallet(DIR_TAKER, "Taker")

    maker_addr = maker.get_address()
    taker_addr = taker.get_address()
    print(f"Maker address: {maker_addr}")
    print(f"Taker address: {taker_addr}")

    # 2. Fund Wallets with BTC on Regtest
    print("\n[Step 2] Funding Maker and Taker on Bitcoin regtest...")
    fund_address(maker_addr, "1.0")
    fund_address(taker_addr, "1.0")

    # Sync and verify initial BTC funding
    maker_btc_funded = get_total_btc(maker, maker_online)
    taker_btc_funded = get_total_btc(taker, taker_online)
    print(f"Maker funded total BTC: {maker_btc_funded} sats")
    print(f"Taker funded total BTC: {taker_btc_funded} sats")
    assert maker_btc_funded >= 100_000_000, "Maker not properly funded"
    assert taker_btc_funded >= 100_000_000, "Taker not properly funded"

    # 3. Create Colorable UTXOs and Issue RGB Asset for Maker
    print("\n[Step 3] Creating UTXOs and Issuing RGB Asset on Maker...")
    # Following Rust test: create 1 UTXO of 10,000 sats for RGB allocation
    created_utxos = maker.create_utxos(maker_online, False, 1, 10_000, FEE_RATE, False)
    mine_blocks(1)
    print(f"Maker created {created_utxos} UTXO(s) for RGB allocation.")

    asset = maker.issue_asset_nia(
        ticker="USDT",
        name="Tether USD Test",
        precision=0,
        amounts=[SWAP_RGB_AMOUNT],
    )
    asset_id = asset.asset_id
    print(f"Issued Asset ID: {asset_id} with supply: {SWAP_RGB_AMOUNT}")

    # Verify Pre-Swap Balances
    maker_rgb_before = get_asset_amount(maker, asset_id)
    maker_btc_before = get_total_btc(maker, maker_online)
    taker_btc_before = get_total_btc(taker, taker_online)

    print("\n=== PRE-SWAP RECORDED BALANCES ===")
    print(f"Maker RGB: {maker_rgb_before}")
    print(f"Maker BTC total: {maker_btc_before} sats")
    print(f"Taker BTC total: {taker_btc_before} sats")
    assert maker_rgb_before == SWAP_RGB_AMOUNT, "Maker RGB balance incorrect before swap"

    # 4. SWAP LIFECYCLE (7 STAGES)
    print("\n" + "=" * 40)
    print("STARTING 7-STAGE SWAP EXECUTION")
    print("=" * 40)

    # Leg definition: Maker gives RGB, receives BTC
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

    # STAGE 1: Maker create_swap_offer
    print("\n[Stage 1] Maker: create_swap_offer...")
    offer = maker.create_swap_offer(
        maker_gives=maker_gives,
        maker_receives=maker_receives,
        network_fee_sat=SWAP_FEE,
        expiration_timestamp=None,
        proxy_url=PROXY_URL,
    )
    print("  -> Offer created successfully.")

    # STAGE 2: Taker accept_swap_offer
    print("\n[Stage 2] Taker: accept_swap_offer...")
    request = taker.accept_swap_offer(
        online=taker_online,
        offer=offer,
        min_confirmations=0,
        skip_sync=False,
    )
    print("  -> Request generated by Taker.")

    # STAGE 3: Maker accept_swap_request (Maker signs their leg)
    print("\n[Stage 3] Maker: accept_swap_request...")
    proposal = maker.accept_swap_request(
        online=maker_online,
        request=request,
        min_confirmations=0,
        skip_sync=False,
    )
    print("  -> Proposal generated and signed by Maker.")

    # STAGE 4: Taker complete_swap_proposal (Taker signs their leg)
    print("\n[Stage 4] Taker: complete_swap_proposal...")
    completion = taker.complete_swap_proposal(
        online=taker_online,
        proposal=proposal,
        min_confirmations=0,
        skip_sync=False,
    )
    print("  -> Proposal completed and signed by Taker.")

    # STAGE 5: Maker process_swap_completion
    print("\n[Stage 5] Maker: process_swap_completion...")
    finalized = maker.process_swap_completion(
        online=maker_online,
        completion=completion,
    )
    print("  -> Completion processed by Maker.")

    # STAGE 6: Maker broadcast_swap_completion
    print("\n[Stage 6] Maker: broadcast_swap_completion...")
    txid = maker.broadcast_swap_completion(
        online=maker_online,
        completion=finalized,
    )
    print(f"  -> Broadcast succeeded! TXID: {txid}")
    assert txid == finalized.txid, "Broadcast TXID mismatch"

    # Confirm transaction on Regtest
    print("\n[Mining] Mining 1 block to confirm swap transaction on regtest...")
    mine_blocks(1)

    # STAGE 7: accept_swap_transfers on Taker (Taker is receiving RGB)
    print("\n[Stage 7] Taker: accept_swap_transfers...")
    taker_recv_res = taker.accept_swap_transfers(
        online=taker_online,
        completion=finalized,
        role=rgb_lib.OnchainSwapRole.TAKER,
        skip_sync=False,
    )
    print(f"  -> Taker accepted swap transfers ({len(taker_recv_res.assignments)} assignment(s)).")
    assert len(taker_recv_res.assignments) > 0, "Taker received no assignments"

    # 5. POST-SWAP VERIFICATION & ASSERTIONS
    print("\n" + "=" * 40)
    print("POST-SWAP ECONOMIC VERIFICATION")
    print("=" * 40)

    # Synchronize and read post-swap balances exactly as in Rust assert_btc_delta & assert_asset_balances
    maker_btc_after = get_total_btc(maker, maker_online)
    taker_btc_after = get_total_btc(taker, taker_online)

    maker_rgb_after = get_asset_amount(maker, asset_id)
    taker_rgb_after = get_asset_amount(taker, asset_id)

    print(f"Maker RGB: {maker_rgb_before} -> {maker_rgb_after}")
    print(f"Taker RGB: 0 -> {taker_rgb_after}")
    print(f"Maker BTC: {maker_btc_before} -> {maker_btc_after} sats (Delta: {maker_btc_after - maker_btc_before})")
    print(f"Taker BTC: {taker_btc_before} -> {taker_btc_after} sats (Delta: {taker_btc_after - taker_btc_before})")

    # Economic Assertions
    # 1. RGB Balances: Maker gave all SWAP_RGB_AMOUNT, Taker received SWAP_RGB_AMOUNT
    assert maker_rgb_after == 0, f"Expected Maker RGB 0, got {maker_rgb_after}"
    assert taker_rgb_after == SWAP_RGB_AMOUNT, f"Expected Taker RGB {SWAP_RGB_AMOUNT}, got {taker_rgb_after}"
    assert maker_rgb_after + taker_rgb_after == SWAP_RGB_AMOUNT, "RGB asset conservation violated"

    # 2. BTC Balances (Exact expected deltas as defined in Rust integration test):
    # - Maker receives: +SWAP_BTC_PRICE
    # - Taker pays: -(SWAP_BTC_PRICE + SWAP_FEE)
    maker_btc_delta = maker_btc_after - maker_btc_before
    taker_btc_delta = taker_btc_after - taker_btc_before

    expected_maker_delta = SWAP_BTC_PRICE
    expected_taker_delta = -(SWAP_BTC_PRICE + SWAP_FEE)

    print(f"\nChecking BTC Deltas:")
    print(f"  Maker: actual {maker_btc_delta} == expected {expected_maker_delta}")
    print(f"  Taker: actual {taker_btc_delta} == expected {expected_taker_delta}")

    assert maker_btc_delta == expected_maker_delta, f"Maker BTC delta mismatch: {maker_btc_delta} != {expected_maker_delta}"
    assert taker_btc_delta == expected_taker_delta, f"Taker BTC delta mismatch: {taker_btc_delta} != {expected_taker_delta}"

    # 3. Overall BTC Conservation: total BTC decreases ONLY by SWAP_FEE
    btc_loss = (maker_btc_before + taker_btc_before) - (maker_btc_after + taker_btc_after)
    print(f"  Total BTC net fee spent: {btc_loss} == expected {SWAP_FEE}")
    assert btc_loss == SWAP_FEE, f"Net BTC fee mismatch: {btc_loss} != {SWAP_FEE}"

    print("\n" + "=" * 60)
    print(">>> SUCCESS: ALL 7 SWAP STAGES & ECONOMIC ASSERTIONS PASSED! <<<")
    print("=" * 60)


if __name__ == "__main__":
    main()
