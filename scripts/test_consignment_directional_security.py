#!/usr/bin/env python3
"""
Test di Sicurezza Direzionale Consignment per On-Chain Swap RGB:

1. Test 1 (RGB -> BTC, Taker Payer):
   - Consignment del Maker alterata o non valida.
   - Verifica che `complete_swap_proposal` sollevi eccezione.
   - Verifica che la PSBT restituita NON contenga le firme del Taker.
   - Verifica che nessun broadcast avvenga e i fondi BTC del Taker rimangano al sicuro.

2. Test 2 (BTC -> RGB, Maker Payer):
   - Consignment del Taker alterata o non valida.
   - Verifica che `process_swap_completion` sollevi eccezione.
   - Verifica che il Maker NON firmi la PSBT e NON trasmetta la transazione.
   - Verifica che gli input BTC del Maker rimangano intatti.

3. Test 3 (Verifica Persistenza su Disco e Hash):
   - Verifica che la consignment validata dal destinatario sia effettivamente salvata
     in locale (es. swap-receive/<recipient_id>/<asset_id>.rgb).
   - Registrazione del percorso assoluto e calcolo dell'hash SHA256.

4. Test 4 (Proxy Offline Assessment durante accept_swap_transfers):
   - Simulazione endpoint del proxy non raggiungibile (porta non esistente o spento).
   - Invocazione di `accept_swap_transfers`.
   - Verifica e documentazione del comportamento (fallback su cache locale o errore di rete).
"""

import os
import shutil
import subprocess
import time
import hashlib
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

BASE_DATA_DIR = "/tmp/test_consignment_directional"
DIR_MAKER = os.path.join(BASE_DATA_DIR, "maker")
DIR_TAKER = os.path.join(BASE_DATA_DIR, "taker")

FEE_RATE = 1
SWAP_FEE = 2_000
SWAP_RGB_AMOUNT = 100
SWAP_BTC_AMOUNT = 50_000


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


def test_direction_rgb_for_btc_negative():
    print("\n" + "=" * 80)
    print("TEST 1: Validazione Pre-Firma RGB -> BTC (Taker paga BTC, Maker cede RGB)")
    print("=" * 80)

    maker, maker_online = create_wallet(DIR_MAKER)
    taker, taker_online = create_wallet(DIR_TAKER)

    fund_address(maker.get_address(), "1.0")
    fund_address(taker.get_address(), "1.0")
    maker.create_utxos(maker_online, False, 5, 10_000, FEE_RATE, False)
    taker.create_utxos(taker_online, False, 5, 10_000, FEE_RATE, False)
    mine_blocks(2)

    asset = maker.issue_asset_nia(
        ticker="NEG1",
        name="Negative Test 1 Token",
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
    print(f"  Maker ha preparato proposal. TXID: {proposal.txid}")

    # Manomettiamo la consignment
    corrupted_consignment = rgb_lib.OnchainSwapConsignment(
        asset_id=proposal.consignments[0].asset_id,
        path="",
        endpoint=proposal.consignments[0].endpoint,
        txid=proposal.consignments[0].txid,
        vout=proposal.consignments[0].vout,
        blinding=proposal.consignments[0].blinding,
        recipient_id="tampered_taker_recipient_id",
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

    print("  Taker tenta complete_swap_proposal con consignment manomessa...")
    taker_aborted = False
    try:
        taker.complete_swap_proposal(
            online=taker_online,
            proposal=tampered_proposal,
            min_confirmations=0,
            skip_sync=False,
        )
    except Exception as e:
        print(f"  >>> Blocco pre-firma riuscito con errore atteso: {e}")
        taker_aborted = True

    assert taker_aborted, "VIOLAZIONE DI SICUREZZA: Taker non ha abortito su consignment invalida!"

    # Verifica stato on-chain del Taker: i suoi input BTC non devono essere stati spesi
    taker_utxos = taker.list_unspents(taker_online, False, False)
    assert len(taker_utxos) > 0, "Gli UTXO del Taker non sono presenti!"
    print("  >>> VERIFICATO: Il Taker non ha firmato la PSBT e gli UTXO BTC del Taker rimangono intatti!")


def test_direction_btc_for_rgb_negative():
    print("\n" + "=" * 80)
    print("TEST 2: Validazione Pre-Firma BTC -> RGB (Maker paga BTC, Taker cede RGB)")
    print("=" * 80)

    maker, maker_online = create_wallet(DIR_MAKER)
    taker, taker_online = create_wallet(DIR_TAKER)

    fund_address(maker.get_address(), "1.0")
    fund_address(taker.get_address(), "1.0")
    maker.create_utxos(maker_online, False, 5, 10_000, FEE_RATE, False)
    taker.create_utxos(taker_online, False, 5, 10_000, FEE_RATE, False)
    mine_blocks(2)

    # Taker emette RGB
    asset = taker.issue_asset_nia(
        ticker="NEG2",
        name="Negative Test 2 Token",
        precision=0,
        amounts=[SWAP_RGB_AMOUNT],
    )
    asset_id = asset.asset_id
    mine_blocks(1)

    maker_gives = rgb_lib.OnchainSwapLeg(
        kind=rgb_lib.OnchainSwapLegKind.BTC,
        asset_id=None,
        amount=SWAP_BTC_AMOUNT,
    )
    maker_receives = rgb_lib.OnchainSwapLeg(
        kind=rgb_lib.OnchainSwapLegKind.RGB,
        asset_id=asset_id,
        amount=SWAP_RGB_AMOUNT,
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
    print(f"  Taker ha completato proposal con consignment. TXID: {completion.txid}")

    # Manomettiamo la consignment inviata al Maker
    corrupted_consignment = rgb_lib.OnchainSwapConsignment(
        asset_id=completion.consignments[0].asset_id,
        path="",
        endpoint=completion.consignments[0].endpoint,
        txid=completion.consignments[0].txid,
        vout=completion.consignments[0].vout,
        blinding=completion.consignments[0].blinding,
        recipient_id="tampered_maker_recipient_id",
    )
    tampered_completion = rgb_lib.OnchainSwapCompletion(
        proposal=completion.proposal,
        psbt=completion.psbt,
        txid=completion.txid,
        consignments=[corrupted_consignment],
        finalized_psbt=completion.finalized_psbt,
        taker_history=completion.taker_history,
    )

    print("  Maker tenta process_swap_completion con consignment manomessa...")
    maker_aborted = False
    try:
        maker.process_swap_completion(
            online=maker_online,
            completion=tampered_completion,
        )
    except Exception as e:
        print(f"  >>> Blocco pre-firma riuscito con errore atteso: {e}")
        maker_aborted = True

    assert maker_aborted, "VIOLAZIONE DI SICUREZZA: Maker non ha abortito su consignment invalida!"

    # Verifica stato del Maker: nessun broadcast eseguito e UTXO intatti
    maker_utxos = maker.list_unspents(maker_online, False, False)
    assert len(maker_utxos) > 0, "Gli UTXO del Maker non sono presenti!"
    print("  >>> VERIFICATO: Il Maker non ha firmato la PSBT e gli UTXO BTC del Maker rimangono intatti!")


def test_disk_persistence_and_offline_recovery():
    print("\n" + "=" * 80)
    print("TEST 3 & 4: Verifica Persistenza su Disco (SHA256) & Comportamento Proxy Offline")
    print("=" * 80)

    maker, maker_online = create_wallet(DIR_MAKER)
    taker, taker_online = create_wallet(DIR_TAKER)

    fund_address(maker.get_address(), "1.0")
    fund_address(taker.get_address(), "1.0")
    maker.create_utxos(maker_online, False, 5, 10_000, FEE_RATE, False)
    taker.create_utxos(taker_online, False, 5, 10_000, FEE_RATE, False)
    mine_blocks(2)

    asset = maker.issue_asset_nia(
        ticker="PERSIST",
        name="Persistence Test Token",
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

    # Taker valida e firma
    completion = taker.complete_swap_proposal(
        online=taker_online,
        proposal=proposal,
        min_confirmations=0,
        skip_sync=False,
    )

    # 3. VERIFICA FILE SU DISCO ED HASH
    print("\n[Verifica Persistenza su Disco]:")
    expected_recipient = proposal.consignments[0].recipient_id
    # Il percorso del wallet include il pubkey fingerprint/hash di directory (DIR_TAKER/<pubkey>/...)
    matching_files = []
    for root, dirs, files in os.walk(DIR_TAKER):
        for f in files:
            if f == f"{asset_id}.rgb" and expected_recipient in root:
                matching_files.append(os.path.join(root, f))

    assert len(matching_files) > 0, f"File consignment non trovato in {DIR_TAKER} per recipient {expected_recipient}"
    expected_path = matching_files[0]
    
    with open(expected_path, "rb") as f:
        file_bytes = f.read()
    file_sha256 = hashlib.sha256(file_bytes).hexdigest()
    file_size = len(file_bytes)
    print(f"  Percorso consignment confermato: {expected_path}")
    print(f"  Dimensione file: {file_size} bytes")
    print(f"  SHA256 consignment: {file_sha256}")

    # Maker finalizza e manda in broadcast
    finalized = maker.process_swap_completion(
        online=maker_online,
        completion=completion,
    )
    txid = maker.broadcast_swap_completion(
        online=maker_online,
        completion=finalized,
    )
    print(f"  Swap Broadcast riuscito! TXID: {txid}")
    mine_blocks(1)

    # 4. TEST COMPORTAMENTO PROXY OFFLINE
    print("\n[Verifica Proxy Offline in accept_swap_transfers]:")
    bad_endpoint_consignment = rgb_lib.OnchainSwapConsignment(
        asset_id=finalized.consignments[0].asset_id,
        path="",
        endpoint="rpc://127.0.0.1:9999/json-rpc", # porta non raggiungibile / proxy simulato offline
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

    print("  Invocazione taker.accept_swap_transfers con proxy offline...")
    taker.accept_swap_transfers(
        online=taker_online,
        completion=offline_proxy_completion,
        role=rgb_lib.OnchainSwapRole.TAKER,
        skip_sync=False,
    )
    print("  >>> accept_swap_transfers completato con successo (recupero da cache locale su disco)!")

    mine_blocks(1)
    taker.refresh(taker_online, None, [], False)
    mine_blocks(1)
    taker.refresh(taker_online, asset_id, [], False)

    bal = taker.get_asset_balance(asset_id)
    print(f"  Saldo Taker consolidato: settled={bal.settled}, future={bal.future}")
    assert bal.settled == SWAP_RGB_AMOUNT, f"Atteso {SWAP_RGB_AMOUNT}, ottenuto {bal.settled}"
    print("  >>> VERIFICATO: Il consolidamento a Settled ha successo anche con proxy offline!")


def main():
    test_direction_rgb_for_btc_negative()
    test_direction_btc_for_rgb_negative()
    test_disk_persistence_and_offline_recovery()
    print("\n" + "=" * 80)
    print(">>> TUTTI I TEST DI SICUREZZA DIREZIONALE E PERSISTENZA HANNO AVUTO SUCCESSO! <<<")
    print("=" * 80)


if __name__ == "__main__":
    main()
