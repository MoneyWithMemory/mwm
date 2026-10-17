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

## Layout

- `src/views/**`: the four pane views (Wallet, Trade, Seller Desk, Contacts) and the split view.
- `src/components/shell/WalletPane.tsx`: one wallet pane with its own view stack. Views navigate with `useWalletContext().navigate(view, params)` from `src/lib/navigation.ts`; there is no URL router.
- `src/components/ui/**`: shared UI kit. `src/api/**`: typed API client and hooks. `src/lib/**`: tokens and helpers.
