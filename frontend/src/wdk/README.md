# Tether WDK in the browser

Tether WDK runs directly in the browser bundle: no sidecar process. It only creates, validates and derives keys for the onboarding; the MwM backend opens and owns the on-chain RGB wallet once the mnemonic is submitted (`POST /api/wallets/create`).

## Packages

Pinned exact versions, chosen to be at least two weeks old:

| Package | Version | Why |
|---|---|---|
| `@tetherto/wdk` | 1.0.0-beta.18 | core: seed phrase helpers, wallet registry |
| `@tetherto/wdk-wallet-btc` | 1.0.0-beta.17 | BIP-84 Bitcoin wallet, regtest |
| `@tetherto/wdk-wallet` | 1.0.0-beta.17 (`overrides`) | one version for both packages above |
| `buffer` | 6.0.3 | `Buffer` global for `bip39` inside WDK |

## API used (`wdk.ts`)

| Wrapper | WDK call |
|---|---|
| `generateSeed()` | `WDK.getRandomSeedPhrase(12)` |
| `validateSeed(seed)` | `WDK.isValidSeed(seed)` (after trimming, lowercasing and single-spacing) |
| `deriveAddress(seed)` | `new WDK(seed).registerWallet('bitcoin', WalletManagerBtc, { network: 'regtest', bip: 84, client })`, then `getAccount('bitcoin', 0)` → `account.getAddress()`, then `wdk.dispose()` |

`deriveAddress` returns the account 0 address at `m/84'/1'/0'/0/0` (`bcrt1q…`). The M3.1 spike checked it against an independent derivation with `bip39`, `bip32` and `bitcoinjs-lib`.

## Browser shims

- **`buffer-global.ts`:** sets `globalThis.Buffer` before WDK loads, because `bip39` calls `Buffer.from` to generate a seed.
- **`sodium-memzero.ts`:** `vite.config.ts` aliases `sodium-universal` to it. WDK only calls `sodium_memzero` to wipe key bytes, and `sodium-native` is Node-only.
- **Offline client:** `wdk.ts` passes a BTC client whose network methods always reject. WDK never contacts its default public Electrum server, so no seed-derived address leaves the browser.
- **Node built-ins:** Vite replaces `net`, `tls` and `events`, imported by the unused Electrum transports, with empty modules. In dev this logs a harmless `console.warn` when WDK loads.

## Size

The bundle is about 1.1 MB minified (300 KB gzip), so the onboarding must import `wdk.ts` lazily when the sheet opens. WDK is not part of the main bundle.

## Dev check

`npm run dev`, then open `http://localhost:5173/#wdk` (dev only). It generates a phrase, validates it and shows the derived address and timing. The phrase itself is never rendered.
