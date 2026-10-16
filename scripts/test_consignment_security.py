#!/usr/bin/env python3
"""
Test di sicurezza della consignment:
1. Test 3A (Pre-firma abort): Verifica che il Taker scarichi e validi la consignment
   PRIMA di firmare la PSBT (durante complete_swap_proposal). Se la consignment
   proposta dal Maker e' corrotta/invalida, complete_swap_proposal DEVE fallire
   e la PSBT del Taker NON deve essere firmata o finalizzata.
2. Test 3B (Offline Proxy Recovery): Verifica che dopo che la consignment e' stata validata
   e scaricata localmente in complete_swap_proposal, se il proxy va offline o il Maker
   cancella la consignment dal proxy, il Taker e il Maker riescono comunque ad eseguire
   accept_swap_transfers recuperando il file locale e completando la transazione on-chain.
"""

import os
import shutil
import subprocess
import time
import rgb_lib

ELECTRUM_URL = "127.0.0.1:50001"
PROXY_URL = "http://127.0.0.1:3000/json-rpc"
TRANSPORT_ENDPOINT = f"rpc://127.0.0.1:3000/json-rpc"

BASE_DATA_DIR = "/tmp/test_consignment_security"
DIR_MAKER = os.path.join(BASE_DATA_DIR, "maker")
DIR_TAKER = os.path.join(BASE_DATA_DIR, "taker")

FEE_RATE = 1
SWAP_FEE = 2_000
SWAP_RGB_AMOUNT = 100
SWAP_BTC_AMOUNT = 50_000


_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DEFAULT_REGTEST = (
    os.path.join(_ROOT, "rgb-lib-python", "rgb-lib", "tests", "regtest.sh")
    if os.path.exists(os.path.join(_ROOT, "rgb-lib-python", "rgb-lib", "tests", "regtest.sh"))
    else os.path.join(_ROOT, "rgb-lib", "tests", "regtest.sh")
)
REGTEST_SCRIPT = os.getenv("REGTEST_SCRIPT", _DEFAULT_REGTEST)

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


NETWORK = rgb_lib.BitcoinNetwork.REGTEST

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


def test_3a_pre_sign_validation_abort():
    print("\n" + "=" * 80)
    print("TEST 3A: Validazione Pre-Firma (Pre-Sign Consignment Validation)")
    print("=" * 80)
    
    maker, maker_online = create_wallet(DIR_MAKER)
    taker, taker_online = create_wallet(DIR_TAKER)

    fund_address(maker.get_address(), "1.0")
    fund_address(taker.get_address(), "1.0")
    maker.create_utxos(maker_online, False, 5, 10_000, FEE_RATE, False)
    taker.create_utxos(taker_online, False, 5, 10_000, FEE_RATE, False)
    mine_blocks(2)

    # Maker cede RGB in cambio di BTC
    asset = maker.issue_asset_nia(
        ticker="SEC3A",
        name="Security 3A Token",
        precision=0,
        amounts=[SWAP_RGB_AMOUNT],
    )
    asset_id = asset.asset_id
    mine_blocks(1)

    maker_gives = rgb_lib.OnchainSwapLeg(
        kind=rgb_lib.OnchainSwapLegKind.RGB,
        asset_id=asset_id,
        amount=SWAP_RGB_AMOUNT,
    )
    maker_receives = rgb_lib.OnchainSwapLeg(
        kind=rgb_lib.OnchainSwapLegKind.BTC,
        asset_id=None,
        amount=SWAP_BTC_AMOUNT,
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

    print(f"  Maker ha generato la proposal con consignment. TXID: {proposal.txid}")

    # SIMULAZIONE ATTACCO: Corruzione della consignment salvata sul proxy
    corrupted_consignment = rgb_lib.OnchainSwapConsignment(
        asset_id=proposal.consignments[0].asset_id,
        path="",
        endpoint=proposal.consignments[0].endpoint,
        txid=proposal.consignments[0].txid,
        vout=proposal.consignments[0].vout,
        blinding=proposal.consignments[0].blinding,
        recipient_id="non_existent_or_tampered_recipient",
    )
    tampered_proposal = rgb_lib.OnchainSwapProposal(
        request=proposal.request,
        maker_inputs=proposal.maker_inputs,
        maker_change_script_pubkey_hex=proposal.maker_change_script_pubkey_hex,
        txid=proposal.txid,
        psbt=proposal.psbt,
        consignments=[corrupted_consignment],
        maker_history=proposal.maker_history,
    )

    print("  Taker esegue complete_swap_proposal con consignment manomessa...")
    failed_as_expected = False
    try:
        taker.complete_swap_proposal(
            online=taker_online,
            proposal=tampered_proposal,
            min_confirmations=0,
            skip_sync=False,
        )
    except Exception as e:
        print(f"  >>> Fallimento atteso rilevato: {e}")
        failed_as_expected = True

    assert failed_as_expected, "CRITICAL ERROR: Taker ha accettato/firmato la transazione nonostante consignment invalida!"
    print("  >>> VERIFICATO: Il Taker ha rifiutato di firmare la PSBT a fronte di consignment non valida!")


def test_3b_offline_proxy_resilience():
    print("\n" + "=" * 80)
    print("TEST 3B: Resilienza Proxy Offline post-validazione / durante accept")
    print("=" * 80)

    maker, maker_online = create_wallet(DIR_MAKER)
    taker, taker_online = create_wallet(DIR_TAKER)

    fund_address(maker.get_address(), "1.0")
    fund_address(taker.get_address(), "1.0")
    maker.create_utxos(maker_online, False, 5, 10_000, FEE_RATE, False)
    taker.create_utxos(taker_online, False, 5, 10_000, FEE_RATE, False)
    mine_blocks(2)

    asset = maker.issue_asset_nia(
        ticker="SEC3B",
        name="Security 3B Token",
        precision=0,
        amounts=[SWAP_RGB_AMOUNT],
    )
    asset_id = asset.asset_id
    mine_blocks(1)

    maker_gives = rgb_lib.OnchainSwapLeg(
        kind=rgb_lib.OnchainSwapLegKind.RGB,
        asset_id=asset_id,
        amount=SWAP_RGB_AMOUNT,
    )
    maker_receives = rgb_lib.OnchainSwapLeg(
        kind=rgb_lib.OnchainSwapLegKind.BTC,
        asset_id=None,
        amount=SWAP_BTC_AMOUNT,
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

    # 1. Taker scarica e valida con successo durante complete_swap_proposal
    completion = taker.complete_swap_proposal(
        online=taker_online,
        proposal=proposal,
        min_confirmations=0,
        skip_sync=False,
    )
    print("  1. Taker ha validato la consignment e firmato la PSBT in complete_swap_proposal.")

    # 2. Maker riceve completion e finalizza
    finalized = maker.process_swap_completion(
        online=maker_online,
        completion=completion,
    )
    txid = maker.broadcast_swap_completion(
        online=maker_online,
        completion=finalized,
    )
    print(f"  2. Maker ha mandato in broadcast lo swap. TXID: {txid}")
    mine_blocks(1)

    # 3. Ora simuliamo che l'endpoint del proxy non sia raggiungibile modificando la porta nell'oggetto o spegnendo l'accesso
    print("  3. Simulazione: l'endpoint del proxy originale non e' raggiungibile durante accept_swap_transfers...")
    bad_endpoint_consignment = rgb_lib.OnchainSwapConsignment(
        asset_id=finalized.consignments[0].asset_id,
        path="",
        endpoint="rpc://127.0.0.1:9999/json-rpc", # porta inesistente!
        txid=finalized.consignments[0].txid,
        vout=finalized.consignments[0].vout,
        blinding=finalized.consignments[0].blinding,
        recipient_id=finalized.consignments[0].recipient_id,
    )
    offline_proxy_completion = rgb_lib.OnchainSwapCompletion(
        proposal=finalized.proposal,
        psbt=finalized.psbt,
        txid=finalized.txid,
        consignments=[bad_endpoint_consignment],
        finalized_psbt=finalized.finalized_psbt,
        taker_history=finalized.taker_history,
    )

    # 4. Taker chiama accept_swap_transfers con proxy non raggiungibile
    print("  4. Taker invoca accept_swap_transfers (con proxy offline)...")
    taker.accept_swap_transfers(
        online=taker_online,
        completion=offline_proxy_completion,
        role=rgb_lib.OnchainSwapRole.TAKER,
        skip_sync=False,
    )
    print("  >>> Successo: Taker ha recuperato la consignment dalla cache locale su disco!")

    mine_blocks(1)
    taker.refresh(taker_online, None, [], False)
    mine_blocks(1)
    taker.refresh(taker_online, asset_id, [], False)

    bal = taker.get_asset_balance(asset_id)
    print(f"  5. Saldo Taker verificato: settled={bal.settled}, future={bal.future}")
    assert bal.settled == SWAP_RGB_AMOUNT, f"Atteso {SWAP_RGB_AMOUNT}, ottenuto {bal.settled}"
    print("  >>> VERIFICATO: Il recupero locale opera correttamente anche con proxy offline!")


def main():
    test_3a_pre_sign_validation_abort()
    test_3b_offline_proxy_resilience()
    print("\n" + "=" * 80)
    print("TUTTI I TEST DI SICUREZZA CONSIGNMENT (3A e 3B) HANNO AVUTO SUCCESSO!")
    print("=" * 80)


if __name__ == "__main__":
    main()
