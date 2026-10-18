# MwM Vault

The self-custodial part of a MwM account. Each AI wallet (`wallet_a`, `wallet_b`, ...) has two parts, like Wallet and
TON Space in Telegram:

- **Wallet**: the AI wallet. The backend holds it with rgb-lib so the agents can negotiate and settle swaps.
- **Vault**: yours alone. A Tether WDK wallet (`@tetherto/wdk` core and its Transaction Policies engine) with UTEXO's
  RGB module (`@utexo/wdk-wallet-rgb`). Its recovery phrase is generated in the browser by WDK and sent here once.
  The backend never sees the phrase; the agents, the negotiator and the trust memory never see the phrase, the
  balances or the moves (the backend only takes part in moves to and from its own wallet).

Funds move between the two parts of the same account only: the backend's `move_to_vault` pays an invoice it asks this
service for, and the Vault's `move_to_wallet` pays an invoice it asks the backend for. Anything else leaving the Vault
is denied by the WDK policy engine.

## Run

Node **22** is required. The RGB binding (`@utexo/rgb-lib-darwin-arm64`, `-linux-x64` or `-linux-arm64`, the only
platforms published) is a native V8 addon that `npm ci` compiles with node-gyp, so it needs a C++ toolchain (Xcode
Command Line Tools on macOS, `build-essential` and Python 3 on Linux). It does not compile on Node 24+ (V8 removed
`String::Utf8Length` and `PropertyCallbackInfo::Holder`), where npm would silently drop it. So `vault/.npmrc` sets
`engine-strict` (`npm ci` on another Node stops at once), and a service started without the binding exits with a clear
message. Get Node 22 from nvm (`nvm install 22`), Homebrew (`node@22`) or the official tarball; if it is not your
default `node`, put its `bin` directory first on `PATH` for every command below (`PATH=/path/to/node22/bin:$PATH npm ci`).

```bash
cd vault
npm ci
npm start      # http://127.0.0.1:8200
```

`scripts/demo_reset.sh` starts it after the backend (log `~/.mwm/logs/vault.log`) with the first Node 22 it finds:
`VAULT_NODE`, `~/.mwm/node22/bin/node`, Homebrew `node@22`, then `node` on `PATH`. A full reset deletes the Vault data
because the chain is new.

| Env | Default | |
|---|---|---|
| `VAULT_PORT` | `8200` | binds 127.0.0.1 only |
| `MWM_VAULT_DIR` | `~/.mwm/vault` | `<wallet_id>/seed.enc`, `<wallet_id>/rgb/` (rgb-lib data), `<wallet_id>/policy.json` (daily totals) |
| `BACKEND_URL` | `http://127.0.0.1:8000` | the AI wallets' backend |
| `VAULT_INDEXER_URL` | `tcp://127.0.0.1:50001` | electrs |
| `VAULT_TRANSPORT_ENDPOINT` | `rpc://127.0.0.1:3000/json-rpc` | RGB proxy |
| `REGTEST_SCRIPT` | `<repo>/scripts/regtest.sh` | demo-only fee funding and mining |
| `COMPOSE_PROJECT_NAME` | unset (Compose uses the repo folder) | set it only when the Vault runs from another checkout than the one that started the regtest chain |

## API

JSON in and out. Errors are `{code, message}` like the backend's, and `message` is written for the user.

| Method and path | Body | Result |
|---|---|---|
| `GET /vault/health` | | `{ok: true}` |
| `GET /vault/{wallet_id}` | | `VaultState` |
| `POST /vault/{wallet_id}/create` | `{mnemonic, password}` | `201 VaultState`, unlocked. `409 vault_exists`, `400 invalid_mnemonic`, `400 weak_password` (< 8 chars) |
| `POST /vault/{wallet_id}/unlock` | `{password}` | `VaultState`. `401 wrong_password`, `404 vault_missing`, `429 too_many_attempts` (for a minute after 5 wrong passwords in a row) |
| `POST /vault/{wallet_id}/lock` | | `VaultState` |
| `POST /vault/{wallet_id}/invoice` | `{asset_id, amount}` | `{invoice, recipient_id}`, receive only (the backend calls it). `404 vault_missing`, `409 vault_locked` |
| `POST /vault/{wallet_id}/refresh` | | `VaultState`, after settling incoming transfers |
| `POST /vault/{wallet_id}/move_to_wallet` | `{asset_id, amount}` | `{txid, asset_id, amount}`. `403 policy_denied`, `409 insufficient_funds`, `503 backend_unavailable` |
| `POST /vault/{wallet_id}/send` | `{invoice, asset_id?}` | `{txid, asset_id, amount}` if the policy allows it, and it allows only the invoice `move_to_wallet` asks the Vault's own wallet for: a pasted invoice gets `403 policy_denied`, even one that wallet made. `asset_id` only for an invoice that names no asset |

`VaultState = {wallet_id, exists, unlocked, address, btc_sats, assets: [{asset_id, ticker, amount, pending}], policy}`.
`address` and `btc_sats` are `null` and `assets` is `[]` while missing or locked; `amount` is spendable, `pending` is
incoming and not settled yet. `policy = {assets, max_per_move, max_per_day, used_today}`.

## Policies

`src/policy.js` registers two policies with `wdk.registerPolicy` before the account is fetched, so
`wdk.getAccount('rgb', 0)` returns the policy-governed proxy, and the service only ever uses that proxy.

- The engine denies by default: a method without a rule is blocked. `vault-upkeep` allows only what moves no value out:
  `listAssets`, `listUnspents`, `listTransfers`, `receiveAsset`, `refreshWallet`, `createUtxos` (a send to itself).
  `sendTransaction`, `sign`, `signPsbt`, `sendBegin`/`sendEnd`, `getRgbWallet` (the raw SDK handle), `createBackup`
  and the rest stay blocked. Reads in `DEFAULT_POLICY_EXCLUSIONS` (`getAddress`, `getBalance`) pass untouched.
- `vault-outbound` governs `transfer`. DENY rules, each with the reason the user sees:
  asset is not USDT or PEPE; amount not a whole number above zero; fee rate over 10 sat/vB; over `max_per_move`
  (5,000 USDT, 1,000,000 PEPE);
  over `max_per_day` (10,000 USDT, 2,000,000 PEPE, totals persisted per day); and, last, the invoice was not obtained
  by this Vault from its own wallet's `receive_invoice` (recorded by `move_to_wallet`, bound to its asset and amount,
  single use). An ALLOW rule requires all of the above again.
- `move_to_wallet` first runs `account.simulate.transfer(...)` as a dry run without an invoice: if any rule other
  than the own-wallet one denies, it stops before asking the backend for an invoice. The transfer itself is then
  evaluated by the engine again, and a `PolicyViolationError` becomes `403 policy_denied` with its reason.

## Security notes

- The phrase arrives once, in `create`, and is checked with `WDK.isValidSeed`. At rest it is sealed with the password:
  scrypt (N=2^15, r=8, p=1) and AES-256-GCM, the wallet id bound as additional data; `seed.enc` is 0600 in a 0700
  directory. It is never logged or returned.
- Unlock decrypts it into a buffer, derives the BIP-39 seed, and zeroes the buffer. WDK gets the seed bytes; rgb-sdk
  zeroes that same buffer when `lock` disposes the WDK instance (a middleware works around a `WalletManagerRgb.dispose`
  ordering bug that would otherwise throw and skip it). The request bodies of `create` and `unlock` are zeroed once
  parsed too. The phrase and the password still pass through JavaScript strings (the parsed request, the normalized
  phrase) and the BIP-39 library's own copies, which this service cannot wipe. A restart locks every Vault.
- After 5 wrong passwords in a row, a Vault does not unlock for a minute, not even with the right password.
- The policy's state (own invoices, tickers, daily totals) lives in this service, outside the backend and the agents.
- The API has no session token: while a Vault is unlocked, any local process can call it (it binds 127.0.0.1 only).
  Other devices cannot, not even through the frontend's Vite server, which listens on the network: its `/vault` proxy
  answers 404 to every client but this computer (`frontend/vite.config.ts`, dev and preview).
  Web pages cannot either: a request must name this computer as its `Host` (no DNS rebinding), a browser POST must
  come from a page opened on this computer (its `Origin` is `localhost`, `127.0.0.1` or `[::1]`), and a body must be
  JSON, which from another site needs a CORS preflight the Vault never grants (`403 forbidden`,
  `415 unsupported_media_type`). The policy still holds: value leaves only to the Vault's own wallet, within the
  limits. The backend itself only calls `invoice` and `refresh`.

**Demo-only (regtest):** on `create` the service funds the Vault with 0.01 BTC from the regtest miner for fees and
creates colorable UTXOs, tops them up before an invoice when none is free, and mines a block after a move. On a real
network the user funds fees and miners confirm. There is no auto-lock.

## Demo prep

```bash
VAULT_DEMO_PASSWORD='...' node scripts/prefund.mjs
```

It creates (or unlocks) the Vault of `wallet_a`, then asks the backend's `move_to_vault` for enough USDT that the Vault
holds 500. Safe to re-run. A new Vault gets a fresh WDK phrase that is never written anywhere: only the Vault holds it,
sealed with the password, which is all a re-run needs. `PREFUND_MNEMONIC_FILE` imports a known phrase from that file
instead. `PREFUND_WALLET_ID`, `PREFUND_TICKER`, `PREFUND_AMOUNT`, `BACKEND_URL` and `VAULT_URL` override the defaults.

## Tests

```bash
npm test
BACKEND_URL=http://127.0.0.1:8101 VAULT_URL=http://127.0.0.1:8201 npm run e2e
```

`npm test` needs no regtest: the encryption, the policy matrix on the real WDK policy engine (with a stand-in RGB
account), and the HTTP API. `npm run e2e` moves real regtest funds through a running backend and Vault (test services
only, so both URLs are required): Wallet to Vault, Vault to Wallet, a move over the limit and a payment to another
wallet's invoice, both denied.
