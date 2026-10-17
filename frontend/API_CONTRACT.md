# MwM API contract

The frontend's view of the backend API. The source of truth is [`src/api/types.ts`](src/api/types.ts), and the in-browser mock ([`src/api/mock/`](src/api/mock/)) implements the same behaviour. If the backend needs a different shape, tell the frontend before implementing it.

## Conventions

- **Base URL:** the browser always calls same-origin `/api/...`. In dev, Vite proxies `/api` to `VITE_API_TARGET` (default `http://127.0.0.1:8000`), so the backend needs no CORS.
- **Names:** JSON fields are `snake_case`.
- **Amounts:** integers in atomic units. The display value is `amount / 10 ** precision`; USDT-RGB and PEPE use precision 0, and BTC uses 8, with its amount in sats.
- **Time:** unix seconds.
- **Prices:** in USD, with USDT-RGB pegged at 1.00. Price fields are integers (`*_usd`).
- **BTC:** the on-chain balance appears as a pseudo-asset `{asset_id: "btc", ticker: "BTC", schema: "BTC", precision: 8}`.
- **Response time:** every endpoint returns within 15 s, so long work (negotiation, swap) runs in the background. The frontend times out after 15 s, and after 120 s for `sign`.

## Errors

Every non-2xx response has this body:

```json
{ "code": "terms_hash_mismatch", "message": "The signed terms differ from the active terms" }
```

| Status | Codes |
|---|---|
| 400 | `invalid_asset`, `invalid_amount`, `invalid_limits`, `invalid_label`, `invalid_profile`, `self_trade`, `sign_error`, `wallet_creation_failed` |
| 403 | `forbidden` (the wallet is not part of the session) |
| 404 | `wallet_not_found`, `session_not_found` |
| 409 | `seller_desk_inactive`, `insufficient_funds`, `not_awaiting_signatures`, `terms_hash_mismatch`, `already_signed`, `expired`, `not_cancellable` |
| 500 | `internal_server_error` |

The UI shows `message` to the user, so write it in plain English.

## Endpoints

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/health` | | `Health` |
| GET | `/api/market` | | `Market` |
| GET | `/api/wallets` | | `WalletSummary[]` |
| GET | `/api/wallets/{id}` | | `WalletState` |
| POST | `/api/wallets/create` | `{label, mnemonic?}` | `WalletSummary` |
| PUT | `/api/wallets/{id}/aliases` | `{address, name}` | `{<address>: name}` (full alias map) |
| PUT | `/api/wallets/{id}/agent_profile` | partial `AgentProfile` | `AgentProfile` |
| GET | `/api/wallets/{id}/contacts` | | `Contact[]` |
| POST | `/api/sessions` | `CreateSessionRequest` | `SessionView` (buyer's perspective) |
| GET | `/api/sessions?wallet_id=` | | `SessionSummary[]`, newest first |
| GET | `/api/sessions/{id}?wallet_id=` | | `SessionView` (that wallet's perspective) |
| POST | `/api/sessions/{id}/sign` | `{wallet_id, terms_hash}` | `SessionView` |
| POST | `/api/sessions/{id}/cancel` | `{wallet_id}` | `SessionView` |

### GET /api/health

Reports whether the backend's dependencies are reachable.

```json
{ "regtest": true, "qvac": true, "proxy": true }
```

### GET /api/market

`sats_per_usd` is the fixed simulated rate (BTC = $100k). `price_usd` is per display unit:
- **USDT-RGB:** always 1.00 (`fixed_peg`).
- **PEPE:** `null` until its first settlement; after that, the last settlement price divided by the lot size (`p2p_negotiation`).

```json
{
  "mode": "fixed_simulated",
  "sats_per_usd": 1000,
  "assets": [
    { "asset_id": "rgb:Cfkujjki-...", "ticker": "USDT", "price_usd": 1, "source": "fixed_peg" },
    { "asset_id": "rgb:NEiuTRxB-...", "ticker": "PEPE", "price_usd": null, "source": "p2p_negotiation" }
  ]
}
```

### GET /api/wallets and GET /api/wallets/{id}

Seeded wallets:

| wallet_id | label | Role in the demo |
|---|---|---|
| `wallet_a` | Wallet A | Buyer; holds USDT |
| `wallet_b` | Wallet B | Seller; PEPE desk active |
| `wallet_sybil` | Sybil | Member of a wash-trading ring |

`GET /api/wallets` returns a `WalletSummary` for each one: `{wallet_id, label, address}`. `GET /api/wallets/{id}` returns the full `WalletState`:

```json
{
  "wallet_id": "wallet_a",
  "label": "Wallet A",
  "address": "bcrt1q7mvx...ecejxy",
  "assets": [
    { "asset_id": "btc", "ticker": "BTC", "schema": "BTC", "precision": 8, "amount": 500000 },
    { "asset_id": "rgb:Cfkujjki-...", "ticker": "USDT", "schema": "NIA", "precision": 0, "amount": 1000 }
  ],
  "avg_cost_basis": { "rgb:Cfkujjki-...": 1 },
  "history_points": [{ "t": 1792140000, "balances": { "btc": 500000, "rgb:Cfkujjki-...": 1000 }, "total_usd": 1500 }],
  "activity": [{
    "id": "seed-3", "t": 1792140000, "kind": "receive", "direction": "in",
    "asset": { "asset_id": "rgb:Cfkujjki-...", "ticker": "USDT", "schema": "NIA", "precision": 0 },
    "amount": 250, "counterparty_address": "bcrt1qj4rm...hye6dx", "txid": "9f2c...", "session_id": null, "status": "confirmed"
  }],
  "local_aliases": { "bcrt1qlnpz...8fdzuf": "PEPE Desk" },
  "agent_profile": {
    "seller_active": false, "offered_asset_id": null, "offered_amount": 0,
    "asking_price_usd": 0, "secret_min_reserve_usd": 0, "seller_ai_prompt": "",
    "buyer_max_ceiling_usd": 135, "buyer_target_usd": 120, "buyer_ai_prompt": "Open low and concede in measured steps."
  }
}
```

- `assets` always includes BTC, plus every RGB asset with a non-zero balance.
- `avg_cost_basis` is the average USD cost per display unit, or `null` if the wallet never bought the asset.
- `history_points` is oldest first: one seed point, then a new point after every completed settlement.
- `activity` is newest first, with one item per asset movement. A swap produces two items (one `out`, one `in`) that share `session_id` and `txid`. `kind` is `swap`, `receive` or `issue`; `status` is `pending` or `confirmed`.
- `local_aliases` holds the wallet's private No-KYC labels (address → name).
- `agent_profile` is the owner's desk and agent settings. It contains secrets (`secret_min_reserve_usd`, `buyer_max_ceiling_usd`), which must never appear in any session payload.

### POST /api/wallets/create

Creates a wallet from a Tether WDK mnemonic.

```json
{ "label": "My WDK wallet", "mnemonic": "abandon ... about" }
```

- The response is a `WalletSummary`.
- This is for **regtest only**: the mnemonic travels in plain text over the LAN to open the RGB wallet, and the UI warns about it.
- Never log the mnemonic. Importing an existing mnemonic again returns the existing wallet.

### PUT /api/wallets/{id}/aliases

Sets a local alias. An empty `name` removes it. The response is the full updated alias map.

```json
{ "address": "bcrt1qlnpz...8fdzuf", "name": "PEPE Desk" }
```

### PUT /api/wallets/{id}/agent_profile

Partial update of the Seller Desk and buyer defaults. The response is the full `AgentProfile`.

Validation errors (`400 invalid_profile`):
- when the desk is active, `secret_min_reserve_usd` is higher than `asking_price_usd`;
- `buyer_target_usd` is higher than `buyer_max_ceiling_usd`.

The negotiator re-reads the seller's profile every round, so a price changed live applies from the next round.

### GET /api/wallets/{id}/contacts

Every known address except the wallet's own, with this wallet's alias and the trust audit:

```json
[{
  "address": "bcrt1qmh5h...zcx4c",
  "alias": null,
  "trust": {
    "trusted": false,
    "sybil_ring_detected": true,
    "reliability_pct": 14,
    "trust_tier": "Ring Anomaly Detected",
    "assessment_summary": "Volume stays inside a closed cluster of related wallets trading with each other."
  }
}]
```

- `trust_tier` is one of `High Authenticity`, `Ring Anomaly Detected` or `Unverified`.
- `reliability_pct: null` means Unverified (cold start).
- **No exposed field ever carries loop percentages or raw trade counts**, and that includes `assessment_summary` and `gate.reasons`.

### POST /api/sessions

The buyer starts a negotiation with a seller's address. The secret ceiling and the target stay server-side.

```json
{
  "buyer_wallet_id": "wallet_a",
  "seller_address": "bcrt1qlnpz...8fdzuf",
  "asset_id": "rgb:NEiuTRxB-...",
  "rgb_amount": 1000000,
  "buyer_max_ceiling_usd": 135,
  "buyer_target_usd": 120,
  "buyer_ai_prompt": "Open low and concede in measured steps."
}
```

- The endpoint returns immediately with the `SessionView`, and the negotiation runs in the background.
- If either side is a ring member or Unverified, the session is created directly in `BLOCKED_BY_GATE`, with `rounds: []` and the reason in `gate.reasons`. No QVAC call happens.
- Errors:
  - `400`: invalid amount or limits, or self-trade.
  - `409 seller_desk_inactive`: the seller's desk is off, or the seller isn't selling this asset.
  - `409 insufficient_funds`: the seller doesn't hold the lot, or the buyer's USDT is below the ceiling.

### GET /api/sessions/{id}?wallet_id=

The session as seen by one participant (`403 forbidden` otherwise):

```json
{
  "session_id": "sess_3f9a1c2b7d10",
  "state": "AWAITING_SIGNATURES",
  "my_role": "buyer",
  "counterparty_address": "bcrt1qlnpz...8fdzuf",
  "asset": { "asset_id": "rgb:NEiuTRxB-...", "ticker": "PEPE", "schema": "NIA", "precision": 0 },
  "rgb_amount": 1000000,
  "agreed_price_usd": 124,
  "created_at": 1792226800,
  "updated_at": 1792226809,
  "payment_asset": { "asset_id": "rgb:Cfkujjki-...", "ticker": "USDT", "schema": "NIA", "precision": 0 },
  "counterparty_trust": { "trusted": true, "sybil_ring_detected": false, "reliability_pct": 92, "trust_tier": "High Authenticity", "assessment_summary": "..." },
  "rounds": [
    { "n": 1, "buyer_offer_usd": 102, "seller_offer_usd": 136, "buyer_action": "OFFER", "seller_action": "OFFER",
      "my_private_thought": "The public ask is 150 USDT. Opening at 102 leaves room to concede...",
      "public_messages": { "buyer": "I can offer 102 USDT for the lot.", "seller": "I can go to 136 USDT for the lot." } },
    { "n": 3, "buyer_offer_usd": 124, "seller_offer_usd": 124, "buyer_action": "OFFER", "seller_action": "ACCEPT",
      "my_private_thought": "...", "public_messages": { "buyer": "I can move to 124 USDT.", "seller": "Agreed at 124 USDT." } }
  ],
  "thinking": null,
  "gate": { "passed": true, "trust_tier": "High Authenticity", "reasons": [] },
  "terms": {
    "session_id": "sess_3f9a1c2b7d10", "asset_id": "rgb:NEiuTRxB-...", "rgb_amount": 1000000,
    "payment_asset_id": "rgb:Cfkujjki-...", "payment_amount": 124, "agreed_price_usd": 124,
    "network_fee_sat": 2000, "buyer_address": "bcrt1q7mvx...ecejxy", "seller_address": "bcrt1qlnpz...8fdzuf",
    "expiry_unix": 1792227409
  },
  "terms_hash": "5d1e...64 hex",
  "buyer_signed": false,
  "seller_signed": false,
  "settlement_steps": [],
  "txid": null,
  "failure": null
}
```

Field rules:
- **Rounds:** `rounds[i]` gets its fields as each side speaks. A field stays `null` until that side has spoken in the round.
- **ACCEPT:** the accepting side's offer field holds the agreed price. When the buyer accepts it is the seller's last ask; when the seller accepts it is the buyer's bid.
- **`thinking`:** set to `"buyer"` or `"seller"` while that agent is generating its turn, so the UI can show a thinking state; otherwise `null`.
- **`gate`:** `null` until the gate runs. `gate.trust_tier` is the tier of the viewer's counterparty.
- **Settlement:** `settlement_steps` stays empty until `SETTLING`. `txid` is set from step 6 (broadcast). `failure` is `{code, message}` when the state is `FAILED`.

`GET /api/sessions?wallet_id=` returns `SessionSummary` items. Each has the first nine fields above, from `session_id` to `updated_at`.

### POST /api/sessions/{id}/sign

```json
{ "wallet_id": "wallet_a", "terms_hash": "5d1e...64 hex" }
```

- Records that wallet's signature over the `terms_hash` the user reviewed.
- Errors:
  - `409 not_awaiting_signatures`: the session is not in `AWAITING_SIGNATURES`;
  - `409 terms_hash_mismatch`: the hash differs from the active one;
  - `409 already_signed`: this wallet has already signed;
  - `409 expired`: past `expiry_unix`. The session also moves to `EXPIRED`.
- When both have signed, the state moves to `SETTLING` and the swap runs in the background. The endpoint returns right away and the frontend polls the steps.

### POST /api/sessions/{id}/cancel

```json
{ "wallet_id": "wallet_a" }
```

Allowed for either participant while the state is `NEGOTIATING` or `AWAITING_SIGNATURES`; otherwise the response is `409 not_cancellable`.

## Session state machine

```
create ──► NEGOTIATING ──► AWAITING_SIGNATURES ──► SETTLING ──► SETTLED
   │            │                 │                    └──────► FAILED
   │            │                 ├──► EXPIRED   (now > terms.expiry_unix before both signatures)
   │            ├──► BLOCKED_BY_GATE   (gate failed, or no agreement within 4 rounds)
   │            └──► CANCELLED_BY_USER   (also from AWAITING_SIGNATURES)
   └──► BLOCKED_BY_GATE   (counterparty is a ring member or Unverified)
```

The terminal states are `SETTLED`, `CANCELLED_BY_USER`, `BLOCKED_BY_GATE`, `FAILED` and `EXPIRED`. The swap starts only when `buyer_signed && seller_signed`, and both signatures must cover the same `terms_hash`.

## Perspective masking

Every session read carries `wallet_id`, and the response depends on it:
- `my_role` is that wallet's role in the session.
- `my_private_thought` in each round is **that wallet's own** agent thought; the counterparty's thought is never returned.
- The buyer's ceiling and target, and the seller's reserve, never appear in any session payload: not in a field, and not in `public_messages`.

## Negotiation (QVAC)

- There are at most 4 rounds. In each round the buyer speaks first, then the seller. The only actions are `OFFER` and `ACCEPT`, never `REJECT`.
- **Rationality:** every buyer `OFFER` is below the seller's last offer, and every seller `OFFER` is above the buyer's last offer. Offers move monotonically towards each other.
- **Leak guard:** the public JSON never contains the speaker's secret, compared as integers rather than substrings.
- **Model output:** `{private_thought, action, offer_usd, public_message}` with `reasoning_budget: 0`. `private_thought` becomes `my_private_thought` for its own side only.
- **No agreement:** if there is no agreement after round 4, the session moves to `BLOCKED_BY_GATE` with the reason `"No agreement within 4 rounds."`.

## Deterministic gate

1. **When the session is created:** it blocks if either party is a ring member or Unverified. This happens before any negotiation.
2. **After the agreement:**
   - it blocks if the price is above the buyer's ceiling or below the seller's reserve;
   - it blocks if the amounts are not positive integers, or if either balance can't cover its leg.
3. **If the gate passes:**
   - it builds `CanonicalSwapTerms`: `session_id, asset_id, rgb_amount, payment_asset_id, payment_amount, agreed_price_usd, network_fee_sat, buyer_address, seller_address, expiry_unix`;
   - `terms_hash` is the SHA-256 hex of `json.dumps(terms, sort_keys=True, separators=(",", ":"))`.

## Settlement: the 7 rgb-lib steps

The maker is the seller and the taker is the buyer. Each `settlement_steps[i]` is `{index, name, status}`, where `index` is 1..7, `name` comes from the table and `status` is `pending`, `running`, `done` or `failed`.

| # | `name` | Actor | Note |
|---|---|---|---|
| 1 | `create_swap_offer` | seller | |
| 2 | `accept_swap_offer` | buyer | |
| 3 | `accept_swap_request` | seller | |
| 4 | `complete_swap_proposal` | buyer | the RGB consignment is validated **before** signing |
| 5 | `process_swap_completion` | seller | |
| 6 | `broadcast_swap_completion` | seller | sets `txid`; mines on regtest |
| 7 | `accept_swap_transfers` | both | plus `refresh`, on both wallets (RGB ↔ RGB) |

When the state reaches `SETTLED`, the backend updates for both wallets:
- balances, `avg_cost_basis`, `history_points` and `activity`;
- the PEPE price in `/api/market`.

## Polling (frontend)

| Data | Interval |
|---|---|
| `GET /api/sessions/{id}` | 1 s |
| `GET /api/sessions`, `GET /api/wallets/{id}` | 1.5 s |
| `GET /api/health`, `GET /api/wallets/{id}/contacts` | 5 s |
| `GET /api/market`, `GET /api/wallets` | 10 s |

Every successful mutation triggers an immediate refetch. Polling pauses while the tab is hidden.

## Confirmed with the backend

On 2026-10-17 the backend (`backend/api_server.py`) confirmed and implemented these points:

- **Seller Desk:** `PUT /api/wallets/{id}/agent_profile` replaces `POST /api/seller-desk`.
- **Signing:** `sign` takes `{wallet_id, terms_hash}`. A hash that differs from the active one gets `409 terms_hash_mismatch`.
- **Seeded wallets:** `wallet_a`, `wallet_b` and `wallet_sybil`.
- **Assets and fee:** USDT-RGB and PEPE use precision 0, BTC is the pseudo-asset `btc`, and `network_fee_sat` is 2000.
- **Gate outcomes:**
  - a ring member or Unverified counterparty blocks the session at creation, without calling QVAC;
  - no agreement within 4 rounds ends in `BLOCKED_BY_GATE`.
- **Terms TTL:** 600 s (`expiry_unix = now + 600`).
- **PEPE price:** `null` until the first trade, then `agreed_price_usd / rgb_amount`.

## Open points

- **Secrets in `GET /api/wallets/{id}`:** the response includes the owner's secrets and there is no auth. That is acceptable for the regtest demo on a LAN, as long as the README states it.
