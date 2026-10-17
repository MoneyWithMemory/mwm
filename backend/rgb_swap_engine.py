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
import re
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
WALLET_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,64}")

# Global lock to serialize rgb_lib / SQLite calls across concurrent web threads
SWAP_GLOBAL_LOCK = threading.Lock()

# Bitcoin the swap takes from a leg's RGB inputs (the patched rgb-lib adds no other inputs):
# the RGB output it receives into, plus the network fee on the taker's side.
SWAP_RGB_OUTPUT_SAT = 1_000
# Bitcoin on the output that receives an isolated allocation; enough for the taker's share.
ISOLATION_UTXO_SAT = 10_000

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
        # wallet_id becomes a path component: reject anything that could escape data_root.
        if not WALLET_ID_RE.fullmatch(wallet_id):
            raise ValueError(f"Invalid wallet id: {wallet_id!r}")
        wdir = self.data_root / wallet_id
        wdir.mkdir(parents=True, exist_ok=True)
        return wdir

    @staticmethod
    def _write_keys(keys_file: Path, keys: Any) -> None:
        keys_file.write_text(json.dumps({
            "mnemonic": keys.mnemonic,
            "xpub_vanilla": keys.account_xpub_vanilla,
            "xpub_colored": keys.account_xpub_colored,
            "fingerprint": keys.master_fingerprint,
        }, indent=2))
        os.chmod(keys_file, 0o600)

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
            self._write_keys(keys_file, keys)
        elif keys_file.exists():
            try:
                data = json.loads(keys_file.read_text())
                keys = rgb_lib.restore_keys(NETWORK, data["mnemonic"], WITNESS_VERSION)
            except Exception as exc:
                logger.warning(f"Failed to restore keys for {wallet_id} ({exc}), generating fresh.")
                keys = rgb_lib.generate_keys(NETWORK, WITNESS_VERSION)
                self._write_keys(keys_file, keys)
        else:
            keys = rgb_lib.generate_keys(NETWORK, WITNESS_VERSION)
            self._write_keys(keys_file, keys)

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

    def fund_and_create_utxos(
        self,
        wallet_id: str,
        btc_amount: str = "1.0",
        utxo_count: int = 5,
        size_sat: int = 10_000,
        min_btc_sats: int = 0,
    ) -> None:
        """
        Ensure wallet has BTC and colored UTXOs for RGB allocations. Idempotent across
        restarts: BTC is sent only below min_btc_sats, and UTXOs are topped up to utxo_count.
        """
        wallet, online, address = self.get_or_create_wallet(wallet_id)
        btc = wallet.get_btc_balance(online, False)
        if btc.vanilla.future + btc.colored.future < min_btc_sats:
            regtest.send_to_address(address, btc_amount)
        try:
            wallet.create_utxos(online, True, utxo_count, size_sat, FEE_RATE, False)
        except rgb_lib.RgbLibError.AllocationsAlreadyAvailable:
            logger.info(f"{wallet_id}: colorable UTXOs already available, none created.")
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
        - Funds Wallet A, Wallet B and Sybil with their seed.py BTC on regtest
        - Creates colorable UTXOs on each
        - Issues 1,000,000 PEPE on Wallet B (Seller)
        - Issues 10,000 USDT on Wallet A (Buyer)
        Returns {'pepe_asset_id': ..., 'usdt_asset_id': ...}.
        """
        with SWAP_GLOBAL_LOCK:
            logger.info("Setting up demo wallets and RGB assets...")
            # 1. Wallets setup (BTC amount from seed.py, sats -> BTC string)
            for wid in ("wallet_b", "wallet_a", "wallet_sybil"):
                sats = SEED_WALLETS[wid].initial_btc_sats
                btc = f"{sats / 100_000_000:.8f}"
                # Top up only when below half the seed, so restarts don't keep adding 0.01 BTC.
                self.wallet_mgr.fund_and_create_utxos(wid, btc, 5, 10_000, min_btc_sats=sats // 2)

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
    def _alloc_amount(allocation: Any) -> int:
        return getattr(allocation.assignment, "amount", 0) or 0

    @classmethod
    def _eligible_unspents(cls, wallet: rgb_lib.Wallet, online: Any) -> List[Any]:
        """UTXOs rgb-lib may spend as swap inputs: settled, with no pending receive."""
        return [
            u for u in wallet.list_unspents(online, False, False)
            if u.utxo.exists and u.pending_blinded == 0 and all(a.settled for a in u.rgb_allocations)
        ]

    @classmethod
    def _select_inputs(cls, wallet: rgb_lib.Wallet, online: Any, asset_id: str, amount: int) -> Optional[List[Any]]:
        """
        Mirrors rgb-lib's select_rgb_inputs for a swap leg: UTXOs sorted by the sum of their
        allocations, taken whole until `amount` is covered. Returns those UTXOs (None if
        insufficient).
        """
        eligible = cls._eligible_unspents(wallet, online)
        eligible.sort(key=lambda u: sum(cls._alloc_amount(a) for a in u.rgb_allocations))
        selected: List[Any] = []
        collected = 0
        for u in eligible:
            got = sum(cls._alloc_amount(a) for a in u.rgb_allocations if a.asset_id == asset_id)
            if got == 0:
                continue
            selected.append(u)
            collected += got
            if collected >= amount:
                return selected
        return None

    @classmethod
    def _selected_amount(cls, wallet: rgb_lib.Wallet, online: Any, asset_id: str, amount: int) -> Optional[int]:
        """
        The amount the inputs selected for a swap leg carry (None if insufficient). Swap
        transitions have no RGB change output, so anything above `amount` would make the
        transition invalid.
        """
        selected = cls._select_inputs(wallet, online, asset_id, amount)
        if selected is None:
            return None
        return sum(cls._alloc_amount(a) for u in selected for a in u.rgb_allocations if a.asset_id == asset_id)

    @classmethod
    def _selection_fits(cls, wallet: rgb_lib.Wallet, online: Any, asset_id: str, amount: int, min_btc_sat: int) -> bool:
        """The leg's inputs carry exactly `amount`, nothing of other assets, and enough bitcoin."""
        selected = cls._select_inputs(wallet, online, asset_id, amount)
        if selected is None:
            return False
        carried = sum(cls._alloc_amount(a) for u in selected for a in u.rgb_allocations if a.asset_id == asset_id)
        only_this_asset = all(a.asset_id == asset_id for u in selected for a in u.rgb_allocations)
        btc = sum(int(u.utxo.btc_amount) for u in selected)
        return carried == amount and only_this_asset and btc >= min_btc_sat

    @classmethod
    def _eligible_amount(cls, wallet: rgb_lib.Wallet, online: Any, asset_id: str) -> int:
        return sum(
            cls._alloc_amount(a)
            for u in cls._eligible_unspents(wallet, online)
            for a in u.rgb_allocations
            if a.asset_id == asset_id
        )

    def _ensure_free_utxos(self, wallet: rgb_lib.Wallet, online: Any, count: int) -> None:
        """At least `count` empty colorable UTXOs, so a blind receive never shares one."""
        free = [
            u for u in wallet.list_unspents(online, False, False)
            if u.utxo.exists and u.utxo.colorable and not u.rgb_allocations and u.pending_blinded == 0
        ]
        if len(free) >= count:
            return
        wallet.create_utxos(online, False, count - len(free), ISOLATION_UTXO_SAT, FEE_RATE, False)
        regtest.mine(1)

    def _ensure_isolated_allocation(
        self,
        wallet: rgb_lib.Wallet,
        online: Any,
        asset_id: str,
        exact_amount: int,
        party: str,
        min_btc_sat: int = SWAP_RGB_OUTPUT_SAT,
    ) -> None:
        """
        Ensures the inputs rgb-lib selects for this leg carry exactly `exact_amount` of the
        asset, nothing else, and at least `min_btc_sat` of bitcoin, for any part of the balance.

        rgb-lib takes whole UTXOs, smallest first, and only settled allocations. So the whole
        balance is self-sent in two parts: exactly `exact_amount` to a new output carrying
        ISOLATION_UTXO_SAT (a witness receive), and the rest to a blind receive with no asset
        ID. A refresh filtered on the asset settles the send and the first receive only; the
        rest stays pending (unselectable) until the post-swap refresh, or _settle_parked if the
        swap stops earlier. Raises before anything is swapped if the selection is still not
        exact, so no funds can be destroyed.
        """
        # Start from a settled wallet: allocations of pending transfers would skew the mirror.
        wallet.refresh(online, None, [], False)
        if self._selection_fits(wallet, online, asset_id, exact_amount, min_btc_sat):
            logger.info(f"{party}: inputs already carry exactly {exact_amount} {asset_id}.")
            return

        total = self._eligible_amount(wallet, online, asset_id)
        if total < exact_amount:
            raise RgbSwapEngineError(
                f"The {party} holds only {total} settled {asset_id}, below {exact_amount}; settlement refused before any transfer."
            )
        rest = total - exact_amount
        logger.info(f"{party}: isolating {exact_amount} {asset_id} on a new output (rest {rest} held back)...")
        transport = self.proxy_url.replace("http://", "rpc://").replace("https://", "rpcs://")
        assignment = rgb_lib.Assignment.FUNGIBLE(exact_amount)
        exact_rcv = wallet.witness_receive(asset_id, assignment, None, [transport], 1)
        recipients = [rgb_lib.Recipient(
            recipient_id=exact_rcv.recipient_id,
            witness_data=rgb_lib.WitnessData(amount_sat=ISOLATION_UTXO_SAT, blinding=None),
            assignment=assignment,
            transport_endpoints=[transport],
        )]
        if rest:
            self._ensure_free_utxos(wallet, online, 1)
            rest_assignment = rgb_lib.Assignment.FUNGIBLE(rest)
            rest_rcv = wallet.blind_receive(None, rest_assignment, None, [transport], 1)
            recipients.append(rgb_lib.Recipient(
                recipient_id=rest_rcv.recipient_id,
                witness_data=None,
                assignment=rest_assignment,
                transport_endpoints=[transport],
            ))
        wallet.send(online, {asset_id: recipients}, True, FEE_RATE, 1, None)
        regtest.mine(2)
        wallet.refresh(online, asset_id, [], False)
        regtest.mine(1)
        wallet.refresh(online, asset_id, [], False)

        if not self._selection_fits(wallet, online, asset_id, exact_amount, min_btc_sat):
            selected = self._selected_amount(wallet, online, asset_id, exact_amount)
            raise RgbSwapEngineError(
                f"The {party}'s allocations of {asset_id} cannot be selected as exactly {exact_amount} "
                f"(rgb-lib would spend {selected}); settlement refused before any transfer."
            )
        logger.info(f"{party}: isolated settled allocation of {exact_amount} {asset_id} ready.")

    @staticmethod
    def _settle_parked(wallets: List[Tuple[rgb_lib.Wallet, Any]]) -> List[str]:
        """Completes every pending transfer (parked excess included); returns the errors."""
        errors: List[str] = []
        for round_ in range(2):
            for wallet, online in wallets:
                try:
                    wallet.refresh(online, None, [], False)
                except Exception as exc:
                    errors.append(str(exc))
            if round_ == 0:
                try:
                    regtest.mine(1)
                except Exception as exc:
                    errors.append(str(exc))
        return errors

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

            try:
                txid, finalized = self._isolate_and_broadcast(
                    canonical_terms, maker_wallet, maker_online, taker_wallet, taker_online, report, txid_callback,
                )
            except Exception:
                # Nothing was swapped: settle any excess parked by the isolation step.
                for err in self._settle_parked([(taker_wallet, taker_online), (maker_wallet, maker_online)]):
                    logger.warning(f"Refresh after a failed settlement: {err}")
                raise

            # The swap is on-chain from here: run every finalization call even if one fails,
            # so one side's error does not skip the other side's accept.
            post_errors: List[str] = []

            def attempt(label: str, fn: Callable[[], Any]) -> None:
                try:
                    fn()
                except Exception as exc:
                    logger.error(f"Post-broadcast step '{label}' failed (txid {txid}): {exc}")
                    post_errors.append(f"{label}: {exc}")

            # Only the broadcasting wallet (the maker) marks its swap inputs as spent. The taker
            # broadcasts the same transaction too (a no-op on-chain), or its spent RGB inputs would
            # stay unspent in its database and break its next transfer.
            attempt("taker broadcast_swap_completion", lambda: taker_wallet.broadcast_swap_completion(
                online=taker_online,
                completion=finalized,
            ))
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

            # Refresh both wallets twice, a block apart: incoming allocations (the swap's and any
            # parked excess) reach SETTLED on every asset.
            post_errors.extend(
                f"refresh: {err}"
                for err in self._settle_parked([(taker_wallet, taker_online), (maker_wallet, maker_online)])
            )

            if post_errors:
                raise RgbSwapEngineError(
                    f"Swap transaction {txid} was broadcast but finalization failed: " + "; ".join(post_errors)
                )

            report(7, "Settlement complete: both assets transitioned to SETTLED status.")
            return txid

    def _isolate_and_broadcast(
        self,
        canonical_terms: CanonicalSwapTerms,
        maker_wallet: rgb_lib.Wallet,
        maker_online: Any,
        taker_wallet: rgb_lib.Wallet,
        taker_online: Any,
        report: Callable[[int, str], None],
        txid_callback: Optional[Callable[[str], None]],
    ) -> Tuple[str, Any]:
        """Isolates both legs and runs stages 1-6; returns the broadcast txid and the finalized completion."""
        # Both legs must select inputs carrying exactly their amount: otherwise the buyer's leg
        # fails at step 5 (InvalidConsignment) and the seller's surplus would be destroyed.
        self._ensure_isolated_allocation(
            wallet=taker_wallet,
            online=taker_online,
            asset_id=canonical_terms.payment_asset_id,
            exact_amount=canonical_terms.payment_amount,
            party="buyer",
            min_btc_sat=SWAP_RGB_OUTPUT_SAT + canonical_terms.network_fee_sat,
        )
        self._ensure_isolated_allocation(
            wallet=maker_wallet,
            online=maker_online,
            asset_id=canonical_terms.asset_id,
            exact_amount=canonical_terms.rgb_amount,
            party="seller",
            min_btc_sat=SWAP_RGB_OUTPUT_SAT,
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
        return txid, finalized

# Global engine instance
swap_engine = RgbSwapEngine()
