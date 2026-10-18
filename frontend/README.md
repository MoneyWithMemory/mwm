# MwM frontend

Telegram Wallet style mini-app: React 19, Vite, TypeScript, Tailwind CSS v4, motion, lucide-react.

```bash
npm install
npm run dev     # http://localhost:5173, also reachable on the LAN
npm run build
npm run lint
```

## API mode

Set in `frontend/.env.local` (git-ignored):

| Variable | Values | Default |
|---|---|---|
| `VITE_API_MODE` | `mock` (in-memory demo data) or `http` (real backend) | `mock` |
| `VITE_API_TARGET` | backend origin used by the Vite proxy, e.g. `http://192.168.1.20:8000` | `http://127.0.0.1:8000` |
| `VITE_VAULT_TARGET` | Vault service origin used by the Vite proxy | `http://127.0.0.1:8200` |

The browser always calls same-origin `/api/...` and `/vault/...`; Vite proxies them to `VITE_API_TARGET` and `VITE_VAULT_TARGET`, so no CORS setup is needed. The Vault follows `VITE_API_MODE`: in mock mode it runs in the browser too.

The Vault opens only on the computer that runs it. The Vault service listens on 127.0.0.1, so in http mode run Vite on that machine: `VITE_VAULT_TARGET` can change the port, not the host. The `/vault` proxy answers 404 to other devices on the LAN, which get the app and `/api` only.

To keep the mock as the default and switch to the real backend only on demand, put `VITE_API_MODE` and `VITE_API_TARGET` (and `VITE_VAULT_TARGET` if the Vault is not on port 8200) in `frontend/.env.lan.local` (also git-ignored) and run `npm run dev -- --mode lan`.

## Contract check

`node scripts/contract-check.mjs http://<backend>:8000` checks a live backend against `src/api/types.ts` and `API_CONTRACT.md` (shapes, asset ids, masking, gate, terms hash, signing guards). It creates three sessions and changes no reliability score: one the gate blocks, one it cancels before the agents agree, and one the agents agree on that it leaves unsigned. Until that one expires 600 s later (without a walk-away), both wallets list it as a deal to sign and its amounts count as promised, so don't sign it in the UI: one signature alone would make the other side's expiry a walk-away. Add `--e2e` to sign both sides instead and wait for the on-chain settlement: this moves regtest balances, sets the PEPE price and sells Wallet B's whole lot, which switches its desk off until the backend restarts. Before a demo, restart the backend from the repo root (`./scripts/demo_reset.sh --restart`, `BACKEND_HANDOVER.md` §4). Needs Node 23.6 or newer; exits with 1 on any failure.

## Unit tests

`node --import ./scripts/node-alias.mjs --test 'scripts/*.test.ts'` runs the unit tests of the lot rules and unit prices shared by the buy forms and the mock, of the trust labels (`src/lib/trust.ts`), of the mock Advisor's signals (`src/api/mock/advice.ts`) and Your AI's answers (`src/api/mock/ask.ts`), and of the Vault (policy, Move form, error sentences, the mock Vault's moves). No dependencies: Node 23.6 or newer runs the TypeScript, and `scripts/node-alias.mjs` resolves `@/` and extensionless imports as Vite does. They live in `scripts/`, which Tailwind does not scan, so editing them never reloads open pages.

## Layout

- `src/views/**`: the four tabs (Wallet, Shop, Deals, Contacts), the Trade view a deal opens on top of Deals, the Seller Desk sheet (`seller-desk/`, opened from the Shop), and the split view.
- `src/components/shell/WalletPane.tsx`: one wallet pane with its own view stack. Views navigate with `useWalletContext().navigate(view, params)` from `src/lib/navigation.ts`; there is no URL router.
- `src/components/ui/**`: shared UI kit. `src/api/**`: typed API client and hooks. `src/vault/**`: the Vault's client, mock and hooks (its UI is the Vault part of the Wallet view, `src/views/wallet/vault/`). `src/lib/**`: tokens and helpers.
