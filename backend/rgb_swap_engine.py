"""
MwM - RGB On-Chain Atomic Swap Engine (PR #85 Protocol Engine)
Encapsulates wallet persistence, UTXO management, RGB-to-RGB symmetric atomic swaps,
double-signature 2/2 enforcement, and 7-stage settlement with thread-safe locking.

Rules:
- Maker = Seller (Wallet B) gives PEPE-RGB, receives USDT-RGB
- Taker = Buyer (Wallet A) gives USDT-RGB, receives PEPE-RGB
- Mandatory 2/2 signature verification against canonical terms_hash before broadcast
- Step 7 combines accept_swap_transfers and balance refresh on both Maker and Taker
- Wallet keys persisted in MWM_DATA_DIR/<wallet_id>/keys.json (restored via restore_keys)
"""

import os
import json
import time
import shutil
import logging
import threading
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import rgb_lib
from backend.config import settings
from backend import regtest
from backend.deterministic_gate import CanonicalSwapTerms, compute_terms_hash
from backend.seed import SEED_WALLETS

logger = logging.getLogger("mwm.rgb_engine")

NETWORK = rgb_lib.BitcoinNetwork.REGTEST
WITNESS_VERSION = rgb_lib.WitnessVersion.SEG_WIT_V0
FEE_RATE = 1  # 1 sat/vB
DEFAULT_SWAP_FEE_SAT = 2_000

# Global lock to serialize rgb_lib / SQLite calls across concurrent web threads
SWAP_GLOBAL_LOCK = threading.Lock()

class SecurityViolationError(RuntimeError):
    """Raised when signature verification or terms hash validation fails."""
    pass

class RgbSwapEngineError(RuntimeError):
    """Raised when an on-chain RGB operation or settlement step fails."""
    pass

class WalletManager:
    """Manages persistent RGB wallets under MWM_DATA_DIR."""

    def __init__(self, data_root: Optional[str] = None) -> None:
        self.data_root = Path(data_root or settings.MWM_DATA_DIR)
        self.data_root.mkdir(parents=True, exist_ok=True)
        self._wallets: Dict[str, rgb_lib.Wallet] = {}
        self._onlines: Dict[str, Any] = {}
        self._addresses: Dict[str, str] = {}

    def get_wallet_dir(self, wallet_id: str) -> Path:
        wdir = self.data_root / wallet_id
        wdir.mkdir(parents=True, exist_ok=True)
        return wdir

    def get_or_create_wallet(self, wallet_id: str, mnemonic: Optional[str] = None) -> Tuple[rgb_lib.Wallet, Any, str]:
        """
        Load an existing wallet or generate a new one, persisting keys in keys.json.
        Returns (wallet, online, address). Primary address is cached for stability.
        """
        if wallet_id in self._wallets and wallet_id in self._onlines and wallet_id in self._addresses:
            return self._wallets[wallet_id], self._onlines[wallet_id], self._addresses[wallet_id]

        wdir = self.get_wallet_dir(wallet_id)
        keys_file = wdir / "keys.json"

        if mnemonic:
            keys = rgb_lib.restore_keys(NETWORK, mnemonic, WITNESS_VERSION)
            keys_file.write_text(json.dumps({
                "mnemonic": keys.mnemonic,
                "xpub_vanilla": keys.account_xpub_vanilla,
                "xpub_colored": keys.account_xpub_colored,
                "fingerprint": keys.master_fingerprint,
            }, indent=2))
        elif keys_file.exists():
            try:
                data = json.loads(keys_file.read_text())
                keys = rgb_lib.restore_keys(NETWORK, data["mnemonic"], WITNESS_VERSION)
            except Exception as exc:
                logger.warning(f"Failed to restore keys for {wallet_id} ({exc}), generating fresh.")
                keys = rgb_lib.generate_keys(NETWORK, WITNESS_VERSION)
                keys_file.write_text(json.dumps({
                    "mnemonic": keys.mnemonic,
                    "xpub_vanilla": keys.account_xpub_vanilla,
                    "xpub_colored": keys.account_xpub_colored,
                    "fingerprint": keys.master_fingerprint,
                }, indent=2))
        else:
            keys = rgb_lib.generate_keys(NETWORK, WITNESS_VERSION)
            keys_file.write_text(json.dumps({
                "mnemonic": keys.mnemonic,
                "xpub_vanilla": keys.account_xpub_vanilla,
                "xpub_colored": keys.account_xpub_colored,
                "fingerprint": keys.master_fingerprint,
            }, indent=2))

        singlesig_keys = rgb_lib.SinglesigKeys(
            account_xpub_vanilla=keys.account_xpub_vanilla,
            account_xpub_colored=keys.account_xpub_colored,
            # Keychain 0 (external) so the first address is m/84'/1'/0'/0/0,
            # identical to the one Tether WDK derives client-side.
            vanilla_keychain=0,
            master_fingerprint=keys.master_fingerprint,
            mnemonic=keys.mnemonic,
            witness_version=keys.witness_version,
        )
        wallet_data = rgb_lib.WalletData(
            data_dir=str(wdir),
            bitcoin_network=NETWORK,
            database_type=rgb_lib.DatabaseType.SQLITE,
            max_allocations_per_utxo=5,
            supported_schemas=[rgb_lib.AssetSchema.NIA],
        )
        wallet = rgb_lib.Wallet(wallet_data, singlesig_keys)
        online_opts = rgb_lib.OnlineOptions(
            indexer_url=settings.ELECTRUM_URL,
            skip_consistency_check=True,
            vanilla_sync_lookback=10,
        )
        online = None
        try:
            online = wallet.go_online(online_opts)
        except Exception as exc:
            logger.warning(f"Wallet {wallet_id} go_online deferred ({exc})")

        address = wallet.get_address()
        self._addresses[wallet_id] = address
        self._wallets[wallet_id] = wallet
        self._onlines[wallet_id] = online
        return wallet, online, address

    def get_balances(self, wallet_id: str) -> Dict[str, Any]:
        """Fetch total BTC balance and all NIA asset balances."""
        wallet, online, address = self.get_or_create_wallet(wallet_id)
        btc_bal = wallet.get_btc_balance(online, False)
        total_btc_sats = btc_bal.vanilla.future + btc_bal.colored.future

        assets_list: List[Dict[str, Any]] = []
        try:
            assets = wallet.list_assets([rgb_lib.AssetSchema.NIA])
            for nia in assets.nia:
                b = wallet.get_asset_balance(nia.asset_id)
                assets_list.append({
                    "asset_id": nia.asset_id,
                    "ticker": nia.ticker,
                    "name": nia.name,
                    "settled": b.settled,
                    "future": b.future,
                    "spendable": b.spendable,
                })
        except Exception as exc:
            logger.warning(f"list_assets failed for {wallet_id}: {exc}")

        return {
            "wallet_id": wallet_id,
            "address": address,
            "btc_sats": total_btc_sats,
            "assets": assets_list,
        }

    def get_spendable(self, wallet_id: str, asset_id: str) -> int:
        """Spendable amount of an RGB asset; 0 when the wallet does not know the asset."""
        wallet, _, _ = self.get_or_create_wallet(wallet_id)
        try:
            return wallet.get_asset_balance(asset_id).spendable
        except Exception:
            return 0

    def fund_and_create_utxos(self, wallet_id: str, btc_amount: str = "1.0", utxo_count: int = 5, size_sat: int = 10_000) -> None:
        """Ensure wallet has BTC and colored UTXOs for RGB allocations."""
        wallet, online, address = self.get_or_create_wallet(wallet_id)
        regtest.send_to_address(address, btc_amount)
        wallet.create_utxos(online, False, utxo_count, size_sat, FEE_RATE, False)
        regtest.mine(2)

    def issue_nia(self, wallet_id: str, ticker: str, name: str, supply: int) -> str:
        """Issue a fungible RGB asset (NIA) on the given wallet."""
        wallet, _, _ = self.get_or_create_wallet(wallet_id)
        asset = wallet.issue_asset_nia(
            ticker=ticker,
            name=name,
            precision=0,
            amounts=[supply],
        )
        regtest.mine(1)
        return asset.asset_id


class RgbSwapEngine:
    """Coordinates and executes RGB <-> RGB atomic swaps."""

    def __init__(self, wallet_mgr: Optional[WalletManager] = None) -> None:
        self.wallet_mgr = wallet_mgr or WalletManager()
        self.proxy_url = settings.PROXY_URL

    def setup_demo_environment(self) -> Dict[str, str]:
        """
        Initialize Wallet A (Buyer) and Wallet B (Seller) for demo:
        - Funds both with BTC on regtest
        - Creates colorable UTXOs on both
        - Issues 1,000,000 PEPE on Wallet B (Seller)
        - Issues 10,000 USDT on Wallet A (Buyer)
        Returns {'pepe_asset_id': ..., 'usdt_asset_id': ...}.
        """
        with SWAP_GLOBAL_LOCK:
            logger.info("Setting up demo wallets and RGB assets...")
            # 1. Wallets setup (BTC amount from seed.py, sats -> BTC string)
            for wid in ("wallet_b", "wallet_a"):
                btc = f"{SEED_WALLETS[wid].initial_btc_sats / 100_000_000:.8f}"
                self.wallet_mgr.fund_and_create_utxos(wid, btc, 5, 10_000)

            # 2. Check if Wallet B already has PEPE
            b_balances = self.wallet_mgr.get_balances("wallet_b")
            pepe_id = None
            for a in b_balances["assets"]:
                if a["ticker"] == settings.DEMO_ASSET_TICKER and a["future"] >= settings.DEMO_ASSET_SUPPLY:
                    pepe_id = a["asset_id"]
                    break
            if not pepe_id:
                logger.info(f"Issuing {settings.DEMO_ASSET_SUPPLY} {settings.DEMO_ASSET_TICKER} on Wallet B...")
                pepe_id = self.wallet_mgr.issue_nia(
                    "wallet_b",
                    settings.DEMO_ASSET_TICKER,
                    settings.DEMO_ASSET_NAME,
                    settings.DEMO_ASSET_SUPPLY,
                )

            # 3. Check if Wallet A already has USDT (with positive spendable balance)
            a_balances = self.wallet_mgr.get_balances("wallet_a")
            usdt_id = None
            for a in a_balances["assets"]:
                if a["ticker"] == settings.PAYMENT_ASSET_TICKER and a["spendable"] >= settings.PAYMENT_ASSET_SUPPLY:
                    usdt_id = a["asset_id"]
                    break
            if not usdt_id:
                logger.info(f"Issuing {settings.PAYMENT_ASSET_SUPPLY} {settings.PAYMENT_ASSET_TICKER} on Wallet A...")
                usdt_id = self.wallet_mgr.issue_nia(
                    "wallet_a",
                    settings.PAYMENT_ASSET_TICKER,
                    settings.PAYMENT_ASSET_NAME,
                    settings.PAYMENT_ASSET_SUPPLY,
                )

            return {
                "pepe_asset_id": pepe_id,
                "usdt_asset_id": usdt_id,
            }

    @staticmethod
    def _selected_amount(wallet: rgb_lib.Wallet, online: Any, asset_id: str, amount: int) -> Optional[int]:
        """
        Mirrors rgb-lib's select_rgb_inputs for a swap leg: UTXOs sorted by the sum of their
        allocations, taken whole until `amount` is covered. Returns the amount those inputs
        carry (None if insufficient). Swap transitions have no RGB change output, so anything
        above `amount` would make the transition invalid.
        """
        def alloc_amount(a: Any) -> int:
            return getattr(a.assignment, "amount", 0) or 0

        eligible = [
            u for u in wallet.list_unspents(online, False, False)
            if u.utxo.exists and u.pending_blinded == 0 and all(a.settled for a in u.rgb_allocations)
        ]
        eligible.sort(key=lambda u: sum(alloc_amount(a) for a in u.rgb_allocations))
        collected = 0
        for u in eligible:
            got = sum(alloc_amount(a) for a in u.rgb_allocations if a.asset_id == asset_id)
            if got == 0:
                continue
            collected += got
            if collected >= amount:
                return collected
        return None

    def _ensure_isolated_allocation(
        self,
        wallet: rgb_lib.Wallet,
        online: Any,
        asset_id: str,
        exact_amount: int,
        party: str,
    ) -> None:
        """
        Ensures the inputs rgb-lib will select for this leg carry exactly `exact_amount`,
        splitting the allocation with a self-send if needed. Raises before anything is
        swapped if an exact selection is still impossible, so no funds can be destroyed.
        """
        if self._selected_amount(wallet, online, asset_id, exact_amount) == exact_amount:
            logger.info(f"{party}: inputs already carry exactly {exact_amount} {asset_id}.")
            return

        logger.info(f"{party}: preparing isolated allocation of {exact_amount} {asset_id} via self-send...")
        transport = self.proxy_url.replace("http://", "rpc://").replace("https://", "rpcs://")
        rcv = wallet.blind_receive(None, rgb_lib.Assignment.FUNGIBLE(exact_amount), None, [transport], 1)
        recipient = rgb_lib.Recipient(
            recipient_id=rcv.recipient_id,
            witness_data=None,
            assignment=rgb_lib.Assignment.FUNGIBLE(exact_amount),
            transport_endpoints=[transport],
        )
        wallet.send(online, {asset_id: [recipient]}, True, FEE_RATE, 1, None)
        regtest.mine(2)
        wallet.refresh(online, None, [], False)
        regtest.mine(1)
        wallet.refresh(online, asset_id, [], False)

        selected = self._selected_amount(wallet, online, asset_id, exact_amount)
        if selected != exact_amount:
            raise RgbSwapEngineError(
                f"The {party}'s allocations of {asset_id} cannot be selected as exactly {exact_amount} "
                f"(rgb-lib would spend {selected}); settlement refused before any transfer."
            )
        logger.info(f"{party}: isolated settled allocation of {exact_amount} {asset_id} ready.")

    def execute_atomic_swap(
        self,
        canonical_terms: CanonicalSwapTerms,
        buyer_signed: bool,
        seller_signed: bool,
        buyer_signed_hash: str,
        seller_signed_hash: str,
        maker_wallet_id: str = "wallet_b",
        taker_wallet_id: str = "wallet_a",
        progress_callback: Optional[Callable[[int, str], None]] = None,
        txid_callback: Optional[Callable[[str], None]] = None,
    ) -> str:
        """
        Executes the 7-stage atomic swap between Maker (Seller) and Taker (Buyer).
        Strictly enforces 2/2 signature and terms_hash validation prior to settlement.
        Returns broadcast transaction ID (txid).
        """
        # Step 0: Inviolable Security Gate Verification
        computed_hash = compute_terms_hash(canonical_terms)
        if not (buyer_signed and seller_signed):
            raise SecurityViolationError("Atomic swap blocked: both buyer and seller signatures are strictly required (2/2).")

        if buyer_signed_hash != seller_signed_hash:
            raise SecurityViolationError("Atomic swap blocked: signature terms_hash mismatch between buyer and seller.")

        if buyer_signed_hash != computed_hash:
            raise SecurityViolationError(f"Atomic swap blocked: signed hash {buyer_signed_hash} does not match canonical terms {computed_hash}.")

        def report(step: int, msg: str) -> None:
            logger.info(f"[Swap Step {step}/7] {msg}")
            if progress_callback:
                progress_callback(step, msg)

        with SWAP_GLOBAL_LOCK:
            maker_wallet, maker_online, _ = self.wallet_mgr.get_or_create_wallet(maker_wallet_id)
            taker_wallet, taker_online, _ = self.wallet_mgr.get_or_create_wallet(taker_wallet_id)

            # Pre-flight: check both legs before anything moves on-chain (no self-send, no fees).
            if self.wallet_mgr.get_spendable(maker_wallet_id, canonical_terms.asset_id) < canonical_terms.rgb_amount:
                raise RgbSwapEngineError("The seller no longer holds the agreed lot; settlement refused before any transfer.")
            if self.wallet_mgr.get_spendable(taker_wallet_id, canonical_terms.payment_asset_id) < canonical_terms.payment_amount:
                raise RgbSwapEngineError("The buyer's balance does not cover the agreed price; settlement refused before any transfer.")

            # Both legs must select inputs carrying exactly their amount: otherwise the buyer's leg
            # fails at step 5 (InvalidConsignment) and the seller's surplus would be destroyed.
            self._ensure_isolated_allocation(
                wallet=taker_wallet,
                online=taker_online,
                asset_id=canonical_terms.payment_asset_id,
                exact_amount=canonical_terms.payment_amount,
                party="buyer",
            )
            self._ensure_isolated_allocation(
                wallet=maker_wallet,
                online=maker_online,
                asset_id=canonical_terms.asset_id,
                exact_amount=canonical_terms.rgb_amount,
                party="seller",
            )

            # Legs definition:
            # Maker (Seller) gives PEPE-RGB, receives USDT-RGB
            maker_gives = rgb_lib.OnchainSwapLeg(
                kind=rgb_lib.OnchainSwapLegKind.RGB,
                asset_id=canonical_terms.asset_id,
                amount=canonical_terms.rgb_amount,
            )
            maker_receives = rgb_lib.OnchainSwapLeg(
                kind=rgb_lib.OnchainSwapLegKind.RGB,
                asset_id=canonical_terms.payment_asset_id,
                amount=canonical_terms.payment_amount,
            )

            # Stage 1: Maker create_swap_offer
            report(1, "Maker: creating swap offer...")
            offer = maker_wallet.create_swap_offer(
                maker_gives=maker_gives,
                maker_receives=maker_receives,
                network_fee_sat=canonical_terms.network_fee_sat,
                expiration_timestamp=canonical_terms.expiry_unix,
                proxy_url=self.proxy_url,
            )

            # Stage 2: Taker accept_swap_offer
            report(2, "Taker: accepting swap offer and verifying terms...")
            request = taker_wallet.accept_swap_offer(
                online=taker_online,
                offer=offer,
                min_confirmations=0,
                skip_sync=False,
            )

            # Stage 3: Maker accept_swap_request
            report(3, "Maker: generating and signing swap proposal...")
            proposal = maker_wallet.accept_swap_request(
                online=maker_online,
                request=request,
                min_confirmations=0,
                skip_sync=False,
            )

            # Stage 4: Taker complete_swap_proposal (pre-signing consignment check)
            report(4, "Taker: validating consignment and completing proposal...")
            completion = taker_wallet.complete_swap_proposal(
                online=taker_online,
                proposal=proposal,
                min_confirmations=0,
                skip_sync=False,
            )

            # Stage 5: Maker process_swap_completion
            report(5, "Maker: processing swap completion PSBT...")
            finalized = maker_wallet.process_swap_completion(
                online=maker_online,
                completion=completion,
            )

            # Stage 6: Maker broadcast_swap_completion + Regtest Mine
            report(6, "Maker: broadcasting on-chain swap transaction...")
            txid = maker_wallet.broadcast_swap_completion(
                online=maker_online,
                completion=finalized,
            )
            if txid_callback:
                txid_callback(txid)
            report(6, f"Transaction broadcast confirmed (txid: {txid}). Mining blocks...")

            # The swap is on-chain from here: run every finalization call even if one fails,
            # so one side's error does not skip the other side's accept.
            post_errors: List[str] = []

            def attempt(label: str, fn: Callable[[], Any]) -> None:
                try:
                    fn()
                except Exception as exc:
                    logger.error(f"Post-broadcast step '{label}' failed (txid {txid}): {exc}")
                    post_errors.append(f"{label}: {exc}")

            attempt("mine", lambda: regtest.mine(2))

            # Stage 7: Atomically accept swap transfers & refresh on both sides
            report(7, "Finalizing: accepting swap transfers and consolidating balances on both Maker and Taker...")
            attempt("taker accept_swap_transfers", lambda: taker_wallet.accept_swap_transfers(
                online=taker_online,
                completion=finalized,
                role=rgb_lib.OnchainSwapRole.TAKER,
                skip_sync=False,
            ))
            attempt("maker accept_swap_transfers", lambda: maker_wallet.accept_swap_transfers(
                online=maker_online,
                completion=finalized,
                role=rgb_lib.OnchainSwapRole.MAKER,
                skip_sync=False,
            ))
            attempt("mine", lambda: regtest.mine(1))

            # Refresh both wallets to transition incoming allocations to SETTLED
            attempt("taker refresh", lambda: taker_wallet.refresh(taker_online, None, [], False))
            attempt("mine", lambda: regtest.mine(1))
            attempt("taker refresh", lambda: taker_wallet.refresh(taker_online, canonical_terms.asset_id, [], False))

            attempt("maker refresh", lambda: maker_wallet.refresh(maker_online, None, [], False))
            attempt("mine", lambda: regtest.mine(1))
            attempt("maker refresh", lambda: maker_wallet.refresh(maker_online, canonical_terms.payment_asset_id, [], False))

            if post_errors:
                raise RgbSwapEngineError(
                    f"Swap transaction {txid} was broadcast but finalization failed: " + "; ".join(post_errors)
                )

            report(7, "Settlement complete: both assets transitioned to SETTLED status.")
            return txid

# Global engine instance
swap_engine = RgbSwapEngine()
