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

The browser always calls same-origin `/api/...`; Vite proxies it to `VITE_API_TARGET`, so no CORS setup is needed.

To keep the mock as the default and switch to the real backend only on demand, put the two variables in `frontend/.env.lan.local` (also git-ignored) and run `npm run dev -- --mode lan`.

## Contract check

`node scripts/contract-check.mjs http://<backend>:8000` checks a live backend against `src/api/types.ts` and `API_CONTRACT.md` (shapes, asset ids, masking, gate, terms hash, signing guards). It creates one blocked and one cancelled session. Add `--e2e` to sign both sides and wait for the on-chain settlement: this moves regtest balances and sets the PEPE price. Needs Node 23.6 or newer; exits with 1 on any failure.

## Unit tests

`node --import ./scripts/node-alias.mjs --test 'scripts/*.test.ts'` runs the unit tests of the lot rules and unit prices shared by the buy forms and the mock. No dependencies: Node 23.6 or newer runs the TypeScript, and `scripts/node-alias.mjs` resolves `@/` imports as Vite does. They live in `scripts/`, which Tailwind does not scan, so editing them never reloads open pages.

## Layout

- `src/views/**`: the four pane views (Wallet, Trade, Seller Desk, Contacts) and the split view.
- `src/components/shell/WalletPane.tsx`: one wallet pane with its own view stack. Views navigate with `useWalletContext().navigate(view, params)` from `src/lib/navigation.ts`; there is no URL router.
- `src/components/ui/**`: shared UI kit. `src/api/**`: typed API client and hooks. `src/lib/**`: tokens and helpers.
