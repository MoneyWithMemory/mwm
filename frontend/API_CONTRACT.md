# MwM API contract

The frontend's view of the backend API. The source of truth is [`src/api/types.ts`](src/api/types.ts), and the in-browser mock ([`src/api/mock/`](src/api/mock/)) implements the same behaviour. If the backend needs a different shape, tell the frontend before implementing it.

## Conventions

- **Base URL:** the browser always calls same-origin `/api/...`. In dev, Vite proxies `/api` to `VITE_API_TARGET` (default `http://127.0.0.1:8000`), so the backend needs no CORS.
- **Names:** JSON fields are `snake_case`.
- **Amounts:** integers in atomic units. The display value is `amount / 10 ** precision`; USDT-RGB and PEPE use precision 0, and BTC uses 8, with its amount in sats.
- **Time:** unix seconds.
- **Prices:** in USD, with USDT-RGB pegged at 1.00. Price fields are integers (`*_usd`).
- **BTC:** the on-chain balance appears as a pseudo-asset `{asset_id: "btc", ticker: "BTC", schema: "BTC", precision: 8}`.
- **Response time:** every endpoint returns within 15 s, except the calls that pay or mine on regtest before answering: `POST /api/wallets/{id}/move_to_vault` and the Vault's `create` (it funds the Vault's fees), `move_to_wallet` and `send`. Long work (negotiation, swap) runs in the background. The frontend times out after 15 s, after 120 s for `sign` and those calls, and after 30 s for the Vault's `refresh`.

## Errors

Every non-2xx response has this body:

```json
{ "code": "terms_hash_mismatch", "message": "The signed terms differ from the active terms" }
```

| Status | Codes |
|---|---|
| 400 | `invalid_asset`, `invalid_amount`, `amount_too_small`, `invalid_limits`, `invalid_label`, `invalid_profile`, `invalid_address`, `own_address`, `invalid_price`, `desk_listing`, `self_trade`, `sign_error`, `wallet_creation_failed`, `invalid_request` |
| 403 | `forbidden` (the wallet is not part of the session, or the listing is not its own) |
| 404 | `wallet_not_found`, `session_not_found`, `listing_not_found`, `no_match` |
| 409 | `seller_desk_inactive`, `exceeds_lot`, `partial_not_allowed`, `insufficient_funds`, `not_awaiting_signatures`, `terms_hash_mismatch`, `already_signed`, `expired`, `not_cancellable`, `vault_missing`, `vault_locked`, `desk_lot`, `funds_committed` |
| 500 | `internal_server_error`, `move_failed` |
| 502 | `vault_invoice_mismatch` (nothing was sent) |
| 503 | `vault_unavailable`, `wallet_unavailable` |

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
| POST | `/api/wallets/{id}/move_to_vault` | `{asset_id, amount}` | `TransferResult` (see [Vault](#vault)) |
| POST | `/api/wallets/{id}/receive_invoice` | `{asset_id, amount}` | `ReceiveInvoice` |
| POST | `/api/wallets/{id}/refresh` | | `{wallet_id, refreshed: true}` |
| GET | `/api/wallets/{id}/advice` | | `AdviceView` |
| POST | `/api/wallets/{id}/ask` | `AskRequest` | `AskView` (Your AI) |
| POST | `/api/sessions` | `CreateSessionRequest` | `SessionView` (buyer's perspective) |
| GET | `/api/sessions?wallet_id=` | | `SessionSummary[]`, newest first |
| GET | `/api/sessions/{id}?wallet_id=` | | `SessionView` (that wallet's perspective) |
| POST | `/api/sessions/{id}/sign` | `{wallet_id, terms_hash}` | `SessionView` |
| POST | `/api/sessions/{id}/cancel` | `{wallet_id}` | `SessionView` |
| GET | `/api/shop?wallet_id=&kind=&asset_id=&q=` | | `ShopListing[]` |
| POST | `/api/shop/wants` | `CreateWantRequest` | `ShopListing` |
| POST | `/api/shop/{listing_id}/close` | `{wallet_id}` | `ShopListing` |
| POST | `/api/shop/agent_search` | `AgentSearchRequest` | `AgentSearchResult` |

### GET /api/health

Reports whether the backend's dependencies are reachable.

```json
{ "regtest": true, "qvac": true, "proxy": true }
```

### GET /api/market

`sats_per_usd` is the fixed simulated rate (BTC = $100k). `price_usd` is per display unit:
- **USDT-RGB:** always 1.00 (`fixed_peg`).
- **PEPE:** `null` until its first settlement; after that, the last settlement price divided by the lot size (`p2p_negotiation`).

Each asset also carries its `precision` (the same value as in `AssetRef`), so a buyer that does not hold the asset yet can convert the typed amount into atomic units.

```json
{
  "mode": "fixed_simulated",
  "sats_per_usd": 1000,
  "assets": [
    { "asset_id": "rgb:Cfkujjki-...", "ticker": "USDT", "precision": 0, "price_usd": 1, "source": "fixed_peg" },
    { "asset_id": "rgb:NEiuTRxB-...", "ticker": "PEPE", "precision": 0, "price_usd": null, "source": "p2p_negotiation" }
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
    "asking_price_usd": 0, "secret_min_reserve_usd": 0, "seller_ai_prompt": "", "allow_partial": false,
    "buyer_max_ceiling_usd": 135, "buyer_target_usd": 120, "buyer_ai_prompt": "Open low and concede in measured steps."
  }
}
```

- `assets` always includes BTC, plus every RGB asset with a non-zero balance.
- `avg_cost_basis` is the average USD cost per display unit, or `null` if the wallet never bought the asset.
- `history_points` is oldest first: one seed point (what the wallet holds when the backend starts), then a new point after every completed settlement and every Vault move.
- `activity` is newest first, with one item per asset movement. A swap produces two items (one `out`, one `in`) that share `session_id` and `txid`. `kind` is `swap`, `receive`, `issue` or `vault` (a move between the wallet and its own Vault: `out` to the Vault, `in` from it, `counterparty_address: null`); `status` is `pending` or `confirmed`.
- `local_aliases` holds the wallet's private No-KYC labels (address → name).
- `trust` is the wallet's own `TrustAudit`, the same one counterparties get in their contacts; the Contacts tab shows it as the owner's reliability.
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

A non-empty `name` also **adds the address to the wallet's contacts** (this is how "Add contact" works: by pasted code or scanned QR). `GET /api/wallets/{id}/contacts` must therefore include every address that has an alias, plus the demo wallets. An unknown address has trust `Unverified` and `desk: null`. Errors: `400 invalid_address` (not `bcrt1…`) and `400 own_address`.

```json
{ "address": "bcrt1qlnpz...8fdzuf", "name": "PEPE Desk" }
```

### PUT /api/wallets/{id}/agent_profile

Partial update of the Seller Desk and buyer defaults. The response is the full `AgentProfile`.

Validation errors (`400 invalid_profile`):
- when the desk is active, `secret_min_reserve_usd` is higher than `asking_price_usd`;
- `buyer_target_usd` is higher than `buyer_max_ceiling_usd`.

A session keeps the list price, reserve and strategy it started with: changes apply to the sessions created after them.

`seller_ai_prompt` and `buyer_ai_prompt` are each owner's strategy for their own agent, passed to it as its owner's instructions (at most 500 characters). The UI offers Strict, Balanced and Flexible presets plus Other (free text); Balanced is the agents' default and is sent as `""`.

`allow_partial` is the seller's consent to partial purchases: buyers may then take part of the lot at the same unit prices (see POST /api/sessions). It is `false` by default, and then a buyer takes the whole lot.

After a settled sale the desk's lot shrinks by the amount sold and `asking_price_usd` and `secret_min_reserve_usd` scale with it (same unit prices). A sold-out desk switches off (`seller_active: false`, `offered_amount: 0`) and leaves the Shop.

### GET /api/wallets/{id}/contacts

Every known address except the wallet's own, with this wallet's alias, the trust audit and the public part of its Seller Desk:

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
  },
  "desk": {
    "asset": { "asset_id": "rgb:NEiuTRxB-...", "ticker": "PEPE", "schema": "NIA", "precision": 0 },
    "offered_amount": 500000,
    "asking_price_usd": 90,
    "allow_partial": false
  }
}]
```

- `trust_tier` is one of `High Authenticity`, `Low Reliability`, `Ring Anomaly Detected` or `Unverified`.
- `reliability_pct: null` means Unverified (cold start).
- **The score is computed by the backend, in code, from settled trades** (`backend/memory_graph.py`): activity (number of trades), variety (distinct counterparties), the reliability of those counterparties, seniority (days since the first trade), and 10% off per agreed deal the wallet walked away from (it cancelled the agreed terms, or left them unsigned until expiry while the other side signed), at most 50%. No history: `Unverified`. A lot going round a closed trading loop (the same asset, amounts within 10% at every hop): `Ring Anomaly Detected`, capped at 20. Otherwise `High Authenticity` from 60, `Low Reliability` below. `trusted` is true only for `High Authenticity`. The memory persists across backend restarts.
- `desk` is `null` unless the address has `seller_active: true` and an `offered_asset_id`. It carries only `asset`, `offered_amount` (atomic units), `asking_price_usd` and `allow_partial`: **never `secret_min_reserve_usd` or `seller_ai_prompt`**. It is shown regardless of trust; the gate still blocks every untrusted address (ring, Low Reliability, Unverified) when the session is created.
- **No exposed field ever carries loop percentages or raw trade counts**, and that includes `assessment_summary` and `gate.reasons`.

### GET /api/wallets/{id}/advice

The Advisor, the wallet's internal memory. It reads only what the owner already sees (this wallet's `WalletState`, its sessions as it sees them with the strategy it gave its own agent in each, the market) and returns at most 4 observations, most severe first. Code computes every number; the local model (QVAC) only phrases the summary, so the wallet's data never leaves the device.

```json
{
  "wallet_id": "wallet_a",
  "generated_at": 1792226900,
  "generated_by": "qvac",
  "phrasing": false,
  "summary": "Your agent paid 18% below the list price, and 9,877 USDT sits idle.",
  "signals": [
    { "id": "idle_funds:rgb:Cfkujjki-...", "kind": "idle_funds", "severity": "tip",
      "title": "9,877 USDT sits idle", "detail": "90% of your wallet. Move part to your Vault, where agents can't touch it.",
      "numbers": { "idle_amount": 9877, "share_pct": 90, "spent_amount": 123, "window_days": 7 } },
    { "id": "negotiation_savings:buyer", "kind": "negotiation_savings", "severity": "info",
      "title": "Paid 18% below the list price", "detail": "$123 for 1,000,000 PEPE, listed at $150.",
      "numbers": { "paid_usd": 123, "ask_usd": 150, "saved_usd": 27, "pct_below": 18, "deals": 1, "amount": 1000000 } }
  ]
}
```

| `kind` | When | `severity` |
|---|---|---|
| `negotiation_savings` | Settled deals: agreed prices against the desk's public list price (`list_price_usd`), one signal for buys and one for sales | `info` |
| `idle_funds` | An RGB balance worth at least 40% of the wallet's value, when trades of the last 7 days used at most a quarter of it (the balance plus what they sent out): move part of it to the Vault. Amount and share are the balance's own, as Assets and Allocation show them | `tip` |
| `concentration` | One asset whose price can move (not BTC, which pays the fees, nor a USD-pegged asset) is at least 70% of the wallet's value | `warning` |
| `pace` | At least 2 finished negotiations in a role (agreements, signed or not, plus no-deals after the agents spoke): how many reached an agreement and the rounds it took. It names the strategy only when all of them ran with the same one, and suggests Flexible only when none did | `info`; `tip` when most ended with no deal |

- `idle_funds` and `concentration` need a wallet worth at least $100. `title` is at most 40 characters and `detail` at most 90; `numbers` holds the numbers behind them.
- `generated_by: "qvac"`: the local model wrote `summary`, one short sentence (at most 140 characters, two sentences at most). The backend discards it for the rules template when it quotes a number that is not one of the signals' numbers (zero never is), uses a word only a signal can justify (an approximation such as "half", a direction such as "above", an action such as "sell", urgency, a strategy, the Vault or a ticker) that no signal says, or says that money outside the Vault is out of the agents' reach. `"rules"`: the deterministic template, whenever no phrased summary is cached for these signals: always with `QVAC_MOCK=1`, until a phrasing succeeds (QVAC failed, took over 9 s, or its sentence was discarded), and while a negotiation is running or queued, since no phrasing starts then (negotiations have priority on the single local model). A summary already phrased for these signals is still served in those cases. With no signals the summary is `"Nothing needs your attention right now."`
- The response never waits for the model. When no summary is cached for these signals and no negotiation needs the model, the backend answers with the rules template and `phrasing: true`, and phrases in the background: one call at a time for all wallets, the latest signals of each wallet only, and the queue is checked again right before the call. The UI asks again after 3 s while `phrasing` is true.
- The phrased summary is cached per wallet and signals for 10 minutes; after that it is still served while it is phrased again. A failed or discarded phrasing is retried after 1 minute, then 2, 4, 8 and every 10 minutes while it keeps failing. With unchanged signals that is one call per wallet every 10 minutes once a summary is phrased, and 5 calls in the first 20 minutes when every phrasing fails. Each call holds the model for up to 9 s; a negotiation that starts during one waits for it to end.
- The UI shows `summary` above the signals only when `generated_by` is `"qvac"` (the rules summary repeats the titles); with no signals it is the empty state's text.
- Nothing secret: sessions are read as `SessionView`, which never carries a counterparty's limits; the owner's own limits are not used, and of the strategies only the owner's own preset name (Strict, Balanced, Flexible, or "your own" for their own words) is used.
- Errors: `404 wallet_not_found`.

### POST /api/wallets/{id}/ask

Your AI, the floating "Ask your AI" chat. Same sources as the Advisor (this wallet's `WalletState`, its sessions as it sees them, the market; never the Vault, never a counterparty's limits). Code computes every fact; the local model (QVAC) only words the answer, checked by the Advisor's guard.

Request (`AskRequest`): `{"preset": "analyze" | "week" | "vault"}` or `{"question": "<at most 280 characters>"}`. A preset wins over a question.

```json
{
  "answer": "Yes, part of it. 9,877 USDT sits idle, 90% of your wallet: your Vault keeps it where agents can't touch it.",
  "generated_by": "rules",
  "signals": [{ "id": "idle_funds:rgb:Cfkujjki-...", "kind": "idle_funds", "severity": "tip", "title": "9,877 USDT sits idle",
                "detail": "90% of your wallet. Move part to your Vault, where agents can't touch it.", "numbers": { "idle_amount": 9877, "share_pct": 90, "spent_amount": 123, "window_days": 7 } }],
  "action": "move_to_vault",
  "note": null
}
```

| Preset | Facts (`signals`) | Rules `answer` |
|---|---|---|
| `analyze` | The Advisor's signals | The Advisor's rules summary |
| `week` | `kind: "activity"`, the last 7 days from the wallet's own activity and sessions: settled swaps per asset pair ("Bought 1,000,000 PEPE for 124 USDT"), moves to and from the Vault, RGB receives (not BTC), negotiations held; at most 4 | "In the last 7 days you bought … and moved …", or "Nothing moved in the last 7 days." |
| `vault` | The `idle_funds` signals | "Yes, part of it. … sits idle, N% of your wallet: …", or "No need right now: nothing large sits idle in your wallet." |

- `question`: one model call whose system prompt holds only the facts (every Advisor signal plus the week's), asking for at most 2 short sentences. The `signals` and the rules fallback follow the question's topic: the Vault (vault, idle, safe, move…), the week (week, lately, happened…), else analyze. A question that names nothing about the account (no word such as wallet, money, deal, Vault, PEPE, week…) gets `"I only know your account. Try: Analyze my account."`, `signals: []`, without asking the model.
- `generated_by: "qvac"`: the model's answer passed the guard (only the facts' numbers, words such as the Vault, sell or a ticker only when a fact says them, no first person, at most 140 characters for a preset and 220 for a question, two sentences at most). Otherwise `"rules"` with a `note` saying why: `"The local model is busy negotiating, here is the quick version."` (a negotiation is running or queued: negotiations have priority on the single model), `"The local model is answering another question, here is the quick version."` (one answer at a time), `"The local model did not answer in time, here is the quick version."` (error or over 11 s), `"The local model's answer did not match your numbers, here is the quick version."` (guard). `note` is null with `QVAC_MOCK=1` or when there are no facts (nothing to word). Model answers are cached per wallet, question and facts for 10 minutes.
- `action: "move_to_vault"` when the wallet has idle funds and the answer is about the account or the Vault (not for `week`): the UI shows a Move to Vault button that opens the existing move.
- Errors: `400 invalid_request` (neither a preset nor a question, an unknown preset, a question over 280 characters, unknown fields), `404 wallet_not_found`.

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
- Negotiations share one local model, so they run in arrival order, one at a time (`NEGOTIATION_CONCURRENCY`, default 1). While a session waits it stays `NEGOTIATING` with `rounds: []` and `thinking: null`, and `queue_position` is its 1-based place in line (`null` once its negotiation runs). If the seller no longer holds the lot when its turn comes, it moves to `BLOCKED_BY_GATE` with the reason `"The seller no longer holds this lot."`.
- If either side is not trusted (a ring member, Low Reliability or Unverified), the session is created directly in `BLOCKED_BY_GATE`, with `rounds: []` and one reason per side in `gate.reasons`, e.g. `"Counterparty trust check failed: Low Reliability"`. No QVAC call happens.
- **Part of a lot:** only if the desk has `allow_partial: true`; otherwise `rgb_amount` must be the whole `offered_amount`. With it, `rgb_amount` may be any part of the lot, from the smallest part worth `MIN_PART_USD` = 10 USDT at the list price, `ceil(offered_amount * 10 / asking_price_usd)`, up to the whole lot; a lot listed below 10 USDT sells whole only. Prices (`asking_price_usd`, `secret_min_reserve_usd`, `buyer_target_usd`, `buyer_max_ceiling_usd`) are whole dollars: the demo USDT has no decimals. A price with cents gets `400 invalid_request`, whose field list the client shows as one sentence ("Use whole dollars, for example 2."). The session's list price and reserve are the desk's scaled to the amount: `list = floor(asking_price_usd * rgb_amount / offered_amount + 0.5)`, `reserve = min(ceil(secret_min_reserve_usd * rgb_amount / offered_amount), list)`. The whole lot keeps the desk's own prices. The `SessionView` carries the scaled `list_price_usd`.
- **Pre-negotiation:** if the buyer's ceiling is below the seller's secret reserve (for this amount) no deal is possible, so the session is also born `BLOCKED_BY_GATE`, without QVAC, with the reason `"No deal possible: the buyer's maximum is below the seller's minimum."`. Neither number is revealed. The seller's `asking_price_usd` is the public list price: the seller's agent defends it, the buyer's agent works it down.
- Errors:
  - `400`: invalid amount or limits, or self-trade. `400 amount_too_small`: below the smallest part worth 10 USDT ("Buy at least 66667 PEPE: a smaller part is worth less than 10 USDT.").
  - `409 seller_desk_inactive`: the seller's desk is off, or the seller isn't selling this asset.
  - `409 exceeds_lot`: more than the desk's `offered_amount`.
  - `409 partial_not_allowed`: less than the whole lot, and the desk has `allow_partial: false`.
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
  "list_price_usd": 150,
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

`GET /api/sessions?wallet_id=` returns `SessionSummary` items. Each has the first nine fields above, from `session_id` to `updated_at`, plus `needs_my_signature`: true while the terms wait for the requesting wallet's signature (also on `SessionView`).

### GET /api/negotiations/queue

`{ "running": ["sess_..."], "waiting": ["sess_...", "sess_..."] }`: the negotiations using QVAC now and those waiting, in arrival order.

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

## Shop

The Shop is the one place to buy, sell or ask for something. **Agents read the same endpoints the UI does**, so there is nothing agent-only to build. Nothing secret ever appears in it: not the seller's reserve, not the buyer's maximum budget, not any agent prompt.

`ShopListing` (see `src/api/types.ts`):

| Field | Meaning |
|---|---|
| `listing_id` | `desk_<wallet_id>` for a Seller Desk, `want_<id>` for a request |
| `kind` | `sell` or `want` |
| `owner_address`, `owner_alias` | the owner, and the requesting wallet's local alias for it |
| `is_mine` | true for the requesting wallet's own listings |
| `asset`, `amount` | the asset and the lot size in atomic units |
| `price_usd` | **public** price for the whole lot: the ask for `sell`, the target for `want` |
| `allow_partial` | `sell`: the seller consents to partial purchases (else the whole lot only, shown as "Full order only"); always `false` for `want` |
| `note` | optional text, 140 characters at most |
| `trust` | the owner's `TrustAudit` (never loop percentages or raw counts) |
| `created_at` | unix seconds, `null` for Seller Desks (they are live, not posted) |

### GET /api/shop?wallet_id=&kind=&asset_id=&q=

- `sell` listings are the **active Seller Desks**: `seller_active`, an offered asset and amount. Public fields only.
- `want` listings are the open requests.
- `kind` and `asset_id` filter exactly; `q` is a case-insensitive match over the owner alias, the owner address, the ticker and the note.
- The requesting wallet's own listings are included, flagged `is_mine`.

### POST /api/shop/wants

```json
{ "wallet_id": "wallet_a", "asset_id": "rgb:...", "amount": 250000, "target_usd": 55, "note": "A smaller lot is fine too." }
```

Creates an open request owned by that wallet's address. `400 invalid_asset` (unknown or BTC), `400 invalid_amount` (not a positive integer), `400 invalid_price` (`target_usd` ≤ 0).

### POST /api/shop/{listing_id}/close

```json
{ "wallet_id": "wallet_a" }
```

Closes the wallet's own request. `403 forbidden` if it is not the owner, `404 listing_not_found` if it does not exist or is closed, `400 desk_listing` for a `desk_<id>` listing (turn the Seller Desk off instead).

### POST /api/shop/agent_search

The buyer's agent looks for the best matching `sell` listing and opens a session with it.

```json
{ "buyer_wallet_id": "wallet_a", "asset_id": "rgb:...", "rgb_amount": 1000000,
  "buyer_max_ceiling_usd": 135, "buyer_target_usd": 120, "buyer_ai_prompt": "Open low and concede in steps." }
```

Candidates are `sell` listings that are not the buyer's, have the same asset, offer at least `rgb_amount` (a part of a larger lot qualifies when its seller has `allow_partial: true`, from 10 USDT worth), whose owner is trusted (`trust.trusted`: rings, Low Reliability and Unverified owners are skipped), and whose secret reserve for that amount is not above `buyer_max_ceiling_usd` (checked server-side, never returned). The price for the requested amount is `price_usd * rgb_amount / amount`; candidates above `1.5 * buyer_max_ceiling_usd` are dropped. The cheapest candidate wins, and the response is `{ "listing": ShopListing, "session": SessionView }` with the session created exactly as `POST /api/sessions` would (same gate, same errors). `404 no_match` when nothing fits. The UI takes the user straight to the session.

## Vault

One account, two parts, like Wallet and TON Space in Telegram. The **Wallet** is the AI wallet the agents trade with (rgb-lib, owned by the backend). The **Vault** is self-custodial with Tether WDK: its own recovery phrase, encrypted with the user's password in the Vault service (`vault/`). The backend, the agents, the negotiator and the trust memory never see the Vault's phrase, balances or moves, and a Vault move adds no memory-graph edge.

### Backend endpoints

- **`POST /api/wallets/{id}/move_to_vault` `{asset_id, amount}` is the only backend endpoint that sends funds, and it can only pay the Vault of the same wallet id.** The backend asks the Vault for the invoice itself (`POST {VAULT_URL}/vault/{id}/invoice`) and never takes one from the client; the body is exactly `{asset_id, amount}`. It pays under the swap lock, mines a block, refreshes, asks the Vault to refresh, and returns `TransferResult` `{txid, asset_id, amount}`.
- `POST /api/wallets/{id}/receive_invoice` `{asset_id, amount}` only receives: an RGB invoice that pays this wallet, `{invoice, recipient_id, asset_id, amount, expires_at}`. The Vault calls it for Vault → Wallet.
- `POST /api/wallets/{id}/refresh` settles incoming transfers (and records the "vault in" activity of paid Vault invoices): `{wallet_id, refreshed: true}`.
- Each move adds an `ActivityItem` with `kind: "vault"` and a `HistoryPoint`.
- Errors: `400 invalid_request`; `409 vault_missing`, `vault_locked`, `insufficient_funds`, `desk_lot` (the amount would leave less than the lot listed on the wallet's Seller Desk), `funds_committed` (the amount is promised in a deal in progress); `502 vault_invoice_mismatch` (nothing sent); `500 move_failed`; `503 vault_unavailable`, `wallet_unavailable`. Any other 4xx from the Vault keeps its code, but none is expected: the Vault's `invoice` sends nothing, so its send policy never applies there. Their messages are written for people, and the UI shows them as they are.

### Vault service

The browser calls same-origin `/vault/...`, and Vite proxies it to `VITE_VAULT_TARGET` (default `http://127.0.0.1:8200`) for a browser on the same computer only: other devices get `404`. Types: [`src/vault/types.ts`](src/vault/types.ts).

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/vault/{id}` | | `VaultState` |
| POST | `/vault/{id}/create` | `{mnemonic, password}` | `201 VaultState` (unlocked) |
| POST | `/vault/{id}/unlock` | `{password}` | `VaultState` |
| POST | `/vault/{id}/lock` | | `VaultState` |
| POST | `/vault/{id}/refresh` | | `VaultState` (incoming transfers settled) |
| POST | `/vault/{id}/move_to_wallet` | `{asset_id, amount}` | `TransferResult` |
| POST | `/vault/{id}/send` | `{invoice, asset_id?}` | `TransferResult` |
| POST | `/vault/{id}/invoice` | `{asset_id, amount}` | `{invoice, recipient_id}` (called by the backend only) |

```json
{
  "wallet_id": "wallet_a", "exists": true, "unlocked": true,
  "address": "bcrt1p...", "btc_sats": 949673,
  "assets": [{ "asset_id": "rgb:H9ht...", "ticker": "USDT", "amount": 75, "pending": 0 }],
  "policy": {
    "assets": ["USDT", "PEPE"],
    "max_per_move": { "USDT": 5000, "PEPE": 1000000 },
    "max_per_day": { "USDT": 10000, "PEPE": 2000000 },
    "used_today": { "USDT": 80, "PEPE": 0 }
  }
}
```

- `address` and `btc_sats` are `null` and `assets` is `[]` while the Vault is missing or locked. `btc_sats` only pays fees; `pending` is incoming, not settled yet.
- **The phrase is generated and confirmed (or imported and validated) in the browser by Tether WDK** (`src/wdk/`), sent once to `create` and dropped from the UI's state right after. The service keeps it encrypted with the password (at least 8 characters) and never returns or logs it. Restarting the service locks every Vault.
- **The Tether WDK policy checks every send:** only to an invoice issued by the Vault's own wallet (the one `move_to_wallet` gets from `receive_invoice`), only USDT and PEPE, within `max_per_move` and `max_per_day`. Anything else is `403 policy_denied` with a sentence such as "Vault policy: the Vault pays only the invoices it asks your Wallet for. To send to your Wallet, use Move.", and nothing leaves the Vault.
- `send` takes `asset_id` only for an invoice that names no asset (`rgb:~/…`, issued by a wallet that never held it); without it the answer is `400 invalid_invoice` "… which asset to pay: choose one."
- Errors: `400 invalid_request`, `invalid_invoice`, `invalid_mnemonic`, `weak_password`; `401 wrong_password`; `403 policy_denied`, `forbidden` (a request that does not come from the app, see `vault/README.md`); `404 vault_missing`, `not_found` (unknown path); `405 method_not_allowed`; `409 vault_exists`, `vault_locked`, `insufficient_funds`, `insufficient_fees`; `413 body_too_large`; `415 unsupported_media_type` (a body that is not JSON); `429 too_many_attempts` (`unlock`, for a minute after 5 wrong passwords in a row); `500 internal_error`; `502 backend_error`, `transfer_failed`; `503 network_unavailable`, `backend_unavailable` (`move_to_wallet`: the wallet's backend is not reachable). `move_to_wallet` passes the backend's own 4xx through with their code, e.g. `404 wallet_not_found`.
- Mock mode ([`src/vault/mock.ts`](src/vault/mock.ts)) keeps one Vault per wallet id in the browser: it moves balances with the mock backend and enforces the same policy.

## Session state machine

```
create ──► NEGOTIATING ──► AWAITING_SIGNATURES ──► SETTLING ──► SETTLED
   │            │                 │                    └──────► FAILED
   │            │                 ├──► EXPIRED   (now > terms.expiry_unix before both signatures)
   │            ├──► BLOCKED_BY_GATE   (gate failed, offers stalled, or no agreement within the round cap)
   │            └──► CANCELLED_BY_USER   (also from AWAITING_SIGNATURES)
   └──► BLOCKED_BY_GATE   (either party is a ring member, Low Reliability or Unverified)
```

Leaving agreed terms counts against a wallet's reliability: a `CANCELLED_BY_USER` from `AWAITING_SIGNATURES` costs the party that cancelled, an `EXPIRED` with only one signature costs the party that did not sign.

The terminal states are `SETTLED`, `CANCELLED_BY_USER`, `BLOCKED_BY_GATE`, `FAILED` and `EXPIRED`. The swap starts only when `buyer_signed && seller_signed`, and both signatures must cover the same `terms_hash`.

## Perspective masking

Every session read carries `wallet_id`, and the response depends on it:
- `my_role` is that wallet's role in the session.
- `my_private_thought` in each round is **that wallet's own** agent thought; the counterparty's thought is never returned.
- The buyer's ceiling and target, and the seller's reserve, never appear in any session payload: not in a field, and not in `public_messages`.

## Negotiation (QVAC)

- Rounds continue until agreement, up to a safety cap of `max_rounds` (backend `NEGOTIATION_MAX_ROUNDS`, default 10; every `SessionView` carries it). In each round the buyer speaks first, then the seller. The only actions are `OFFER` and `ACCEPT`, never `REJECT`.
- **Rationality:** every buyer `OFFER` is below the seller's last offer, and every seller `OFFER` is above the buyer's last offer. Offers move monotonically towards each other. `ACCEPT` counts only when the other side's price is within the agent's own secret limit; otherwise it is an `OFFER` at the model's price and goes through the same checks. Each new offer moves at least max(2 USD, 15% of the gap) towards the other side (the seller's opening at the list price excepted), never past the agent's own limit, and before the last two rounds never onto it: there each offer covers at most a secret share (25-50%, drawn per session and role) of the room left to a hold line that lies a secret margin inside the limit, a cap that beats the minimum step, so the offers do not reveal the limit. At its hold line an agent takes a price within its limit; when the other side holds a price beyond it too, the limits overlap by less than the margins and the agent offers its limit, which closes the deal. Also before the last two rounds, an agent does not take a price far from its own last offer (more than max(3 USD, 3%)): it counters with a quarter of the gap instead.
- **Leak guard:** a public message that states the speaker's limit (in any digit format, spaced out or in Unicode look-alikes, in English words, or through simple arithmetic), a number within 5% of it with limit language ("can't go below", "up to", "the lowest I'll go"), or any talk about its own limit ("my reserve", "my budget") is replaced by a neutral sentence that quotes only the final offer. The model's words are published only when no guard changed anything and they match the move (an `ACCEPT` that accepts, an `OFFER` that does not claim to).
- **Model output:** `{private_thought, action, offer_usd, public_message}` with `reasoning_budget: 0`. `private_thought` becomes `my_private_thought` for its own side only.
- **No agreement:** if neither side moves for two full rounds, the session moves to `BLOCKED_BY_GATE` with the reason `"No agreement: the offers stopped moving."`; if the cap is reached, the reason is `"No agreement within 10 rounds."` (with the actual cap). In the last round no possible deal is lost: the buyer takes an ask within its ceiling or bids the ceiling, and the seller takes a bid at or above its reserve.

## Deterministic gate

1. **When the session is created:** it blocks if either party is not `High Authenticity` (a ring member, Low Reliability or Unverified), or if the buyer's ceiling is below the seller's reserve. This happens before any negotiation.
2. **After the agreement:**
   - it blocks if the seller is no longer trusted (`"Counterparty trust check failed: <tier>"`);
   - it blocks if the price is above the buyer's ceiling or below the seller's reserve;
   - it blocks if the amounts are not positive integers;
   - it checks no balance. Balances are checked when the session is created (`409 insufficient_funds`), when a queued negotiation starts (the seller's lot: `BLOCKED_BY_GATE`, `"The seller no longer holds this lot."`), and before settlement step 1, which ends the session `FAILED` before anything moves.
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
| `GET /vault/{id}` (`POST /vault/{id}/refresh` while a transfer is arriving) | 2 s |
| `GET /api/wallets/{id}/advice` | 30 s (3 s while `phrasing`) |

Every successful mutation triggers an immediate refetch. Polling pauses while the tab is hidden.

## Confirmed with the backend

On 2026-10-18 the backend replaced the fixed trust values with a score computed from settled trades and kept on disk (see GET /api/wallets/{id}/contacts), added the `Low Reliability` tier, and gave each negotiating agent its counterparty's score and tier.

On 2026-10-17, later in the day, the backend also shipped: the four `/api/shop` endpoints, contacts by alias, `precision` on every `GET /api/market` asset and `desk` on every contact.

On 2026-10-17 the backend (`backend/api_server.py`) confirmed and implemented these points:

- **Seller Desk:** `PUT /api/wallets/{id}/agent_profile` replaces `POST /api/seller-desk`.
- **Signing:** `sign` takes `{wallet_id, terms_hash}`. A hash that differs from the active one gets `409 terms_hash_mismatch`.
- **Seeded wallets:** `wallet_a`, `wallet_b` and `wallet_sybil`.
- **Assets and fee:** USDT-RGB and PEPE use precision 0, BTC is the pseudo-asset `btc`, and `network_fee_sat` is 2000.
- **Gate outcomes:**
  - an untrusted party (ring member, Low Reliability or Unverified) blocks the session at creation, without calling QVAC;
  - no agreement (offers stalled for two rounds, or the round cap) ends in `BLOCKED_BY_GATE`.
- **Terms TTL:** 600 s (`expiry_unix = now + 600`).
- **PEPE price:** `null` until the first trade, then `agreed_price_usd / rgb_amount`.

## Open points

- **Secrets in `GET /api/wallets/{id}`:** the response includes the owner's secrets and there is no auth. That is acceptable for the regtest demo on a LAN, as long as the README states it.
