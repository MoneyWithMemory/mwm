/**
 * MwM API contract: the source of truth shared with the backend.
 * Field names are snake_case like the Python API. Amounts are integers in
 * atomic units (divide by 10 ** precision to display). Timestamps are unix
 * seconds. Prices are in USD; USDT-RGB is pegged at 1.00.
 */

export type WalletId = string
export type AssetId = string
export type SessionId = string

// ── Assets ─────────────────────────────────────────────────────────

/** RGB schemas, plus "BTC" for the on-chain balance used for fees. */
export type AssetSchema = 'NIA' | 'UDA' | 'CFA' | 'IFA' | 'BTC'

export interface AssetRef {
  asset_id: AssetId
  ticker: string
  schema: AssetSchema
  precision: number
}

export interface AssetBalance extends AssetRef {
  amount: number
}

// ── Market ─────────────────────────────────────────────────────────

/** fixed_peg: USDT-RGB at 1.00. p2p_negotiation: last settlement price. */
export type PriceSource = 'fixed_peg' | 'p2p_negotiation'

export interface AssetPrice {
  asset_id: AssetId
  ticker: string
  /** Same as AssetRef.precision, so a buyer can convert amounts before holding the asset. */
  precision: number
  /** USD per display unit; null until the asset has a price (e.g. PEPE before its first trade). */
  price_usd: number | null
  source: PriceSource
}

/** GET /api/market. BTC is valued with the fixed simulated sats_per_usd rate. */
export interface Market {
  mode: 'fixed_simulated'
  sats_per_usd: number
  assets: AssetPrice[]
}

// ── Health ─────────────────────────────────────────────────────────

/** GET /api/health: reachability of the backend's dependencies. */
export interface Health {
  regtest: boolean
  qvac: boolean
  proxy: boolean
}

// ── Wallets ────────────────────────────────────────────────────────

/** GET /api/wallets item. Seeded labels: "Wallet A", "Wallet B", "Sybil". */
export interface WalletSummary {
  wallet_id: WalletId
  label: string
  /** On-chain regtest address (bcrt1q...). */
  address: string
}

export interface HistoryPoint {
  t: number
  /** Balance of each asset at time t, in atomic units. */
  balances: Record<AssetId, number>
  /** Wallet value in USD at time t (assets without a price count as 0). */
  total_usd: number
}

export type ActivityKind = 'swap' | 'receive' | 'issue'

/** One asset movement. A swap produces two items (one out, one in) sharing session_id and txid. */
export interface ActivityItem {
  id: string
  t: number
  kind: ActivityKind
  direction: 'in' | 'out'
  asset: AssetRef
  amount: number
  counterparty_address: string | null
  txid: string | null
  session_id: SessionId | null
  status: 'pending' | 'confirmed'
}

/** Private to the wallet owner: secrets never appear in session payloads. */
export interface AgentProfile {
  // Seller Desk
  seller_active: boolean
  offered_asset_id: AssetId | null
  offered_amount: number
  asking_price_usd: number
  secret_min_reserve_usd: number
  seller_ai_prompt: string
  // Buyer side (defaults for new sessions)
  buyer_max_ceiling_usd: number
  buyer_target_usd: number
  buyer_ai_prompt: string
}

/** GET /api/wallets/{id} */
export interface WalletState extends WalletSummary {
  assets: AssetBalance[]
  /** Average USD cost per display unit; null if never bought. */
  avg_cost_basis: Record<AssetId, number | null>
  /** Seed point plus one point per completed settlement, oldest first. */
  history_points: HistoryPoint[]
  /** Newest first. */
  activity: ActivityItem[]
  /** Private No-KYC labels, local to this wallet: address -> name. */
  local_aliases: Record<string, string>
  agent_profile: AgentProfile
}

// ── Trust (Layer-0 memory graph) ───────────────────────────────────

export type TrustTier = 'High Authenticity' | 'Ring Anomaly Detected' | 'Unverified'

/** Never exposes loop percentages or raw trade counts. */
export interface TrustAudit {
  trusted: boolean
  sybil_ring_detected: boolean
  /** null means Unverified (cold start). */
  reliability_pct: number | null
  trust_tier: TrustTier
  assessment_summary: string
}

/** Public part of a Seller Desk. Never carries the secret reserve or the seller prompt. */
export interface PublicDesk {
  asset: AssetRef
  /** Lot size in atomic units. */
  offered_amount: number
  asking_price_usd: number
}

/** GET /api/wallets/{id}/contacts item. */
export interface Contact {
  address: string
  /** This wallet's local alias for the address, if any. */
  alias: string | null
  trust: TrustAudit
  /** The address's active Seller Desk; null when it is not selling (trust is checked separately, at session creation). */
  desk: PublicDesk | null
}

// ── Shop ───────────────────────────────────────────────────────────

export type ListingKind = 'sell' | 'want'

/**
 * One public Shop entry. "sell" listings are the active Seller Desks (public part only);
 * "want" listings are requests with a public target price. Secrets never appear here:
 * not the seller's reserve, not the buyer's maximum budget, not any agent prompt.
 * Agents read the same list through GET /api/shop and open a session with POST /api/sessions.
 */
export interface ShopListing {
  listing_id: string
  kind: ListingKind
  owner_address: string
  /** The requesting wallet's local alias for the owner, if any. */
  owner_alias: string | null
  /** True for the requesting wallet's own listings. */
  is_mine: boolean
  asset: AssetRef
  /** Lot size in atomic units. */
  amount: number
  /** Public price in USD for the whole lot: the ask for "sell", the target for "want". */
  price_usd: number
  note: string | null
  trust: TrustAudit
  /** null for Seller Desks, which are live rather than posted. */
  created_at: number | null
}

/** GET /api/shop?wallet_id=&kind=&asset_id=&q= */
export interface ShopQuery {
  kind?: ListingKind
  asset_id?: AssetId
  /** Free text over owner alias or address, ticker and note. */
  q?: string
}

/** POST /api/shop/wants */
export interface CreateWantRequest {
  wallet_id: WalletId
  asset_id: AssetId
  amount: number
  target_usd: number
  note?: string
}

/**
 * POST /api/shop/agent_search. The buyer's agent looks for the best matching "sell" listing
 * and opens a session with it. 404 no_match when nothing fits right now.
 */
export interface AgentSearchRequest {
  buyer_wallet_id: WalletId
  asset_id: AssetId
  rgb_amount: number
  buyer_max_ceiling_usd: number
  buyer_target_usd: number
  buyer_ai_prompt: string
}

export interface AgentSearchResult {
  listing: ShopListing
  session: SessionView
}

// ── Sessions ───────────────────────────────────────────────────────

export type SessionState =
  | 'NEGOTIATING'
  | 'AWAITING_SIGNATURES'
  | 'SETTLING'
  | 'SETTLED'
  | 'CANCELLED_BY_USER'
  | 'BLOCKED_BY_GATE'
  | 'FAILED'
  | 'EXPIRED'

export const TERMINAL_STATES: readonly SessionState[] = [
  'SETTLED',
  'CANCELLED_BY_USER',
  'BLOCKED_BY_GATE',
  'FAILED',
  'EXPIRED',
]

/** Cancel is allowed only before SETTLING. */
export const CANCELLABLE_STATES: readonly SessionState[] = ['NEGOTIATING', 'AWAITING_SIGNATURES']

export type Role = 'buyer' | 'seller'

/** Intermediate rounds only OFFER or ACCEPT, never REJECT. */
export type AgentAction = 'OFFER' | 'ACCEPT'

/** Default backend cap (NEGOTIATION_MAX_ROUNDS); each SessionView carries the live value in max_rounds. */
export const MAX_ROUNDS = 10

export interface Round {
  /** 1..MAX_ROUNDS */
  n: number
  buyer_offer_usd: number | null
  seller_offer_usd: number | null
  buyer_action: AgentAction | null
  seller_action: AgentAction | null
  /** Only the requesting wallet's own agent thought; never the counterparty's. */
  my_private_thought: string | null
  /** null while that side has not spoken yet in this round. */
  public_messages: { buyer: string | null; seller: string | null }
}

export interface GateResult {
  passed: boolean
  trust_tier: TrustTier
  /** Human-readable reasons when blocked; never loop % or raw counts. */
  reasons: string[]
}

/** Hashed by the backend: terms_hash = SHA-256 of the canonical JSON (sorted keys, no spaces). */
export interface CanonicalSwapTerms {
  session_id: SessionId
  /** Asset being sold (e.g. PEPE-RGB). */
  asset_id: AssetId
  rgb_amount: number
  /** Asset used to pay (USDT-RGB). */
  payment_asset_id: AssetId
  payment_amount: number
  agreed_price_usd: number
  network_fee_sat: number
  buyer_address: string
  seller_address: string
  /** Signatures after this time move the session to EXPIRED. */
  expiry_unix: number
}

/** The 7 rgb-lib calls of the atomic swap. Maker = seller, taker = buyer. */
export const SETTLEMENT_STEPS = [
  { index: 1, name: 'create_swap_offer', actor: 'seller', label: 'Seller publishes the swap offer' },
  { index: 2, name: 'accept_swap_offer', actor: 'buyer', label: 'Buyer accepts the offer' },
  { index: 3, name: 'accept_swap_request', actor: 'seller', label: 'Seller signs their leg' },
  { index: 4, name: 'complete_swap_proposal', actor: 'buyer', label: 'RGB consignment validated before signing' },
  { index: 5, name: 'process_swap_completion', actor: 'seller', label: 'Seller finalizes the transaction' },
  { index: 6, name: 'broadcast_swap_completion', actor: 'seller', label: 'Broadcast and mine on Bitcoin regtest' },
  { index: 7, name: 'accept_swap_transfers', actor: 'both', label: 'Both wallets accept the transfers' },
] as const

export type SettlementStepName = (typeof SETTLEMENT_STEPS)[number]['name']
export type StepStatus = 'pending' | 'running' | 'done' | 'failed'

export interface SettlementStep {
  index: (typeof SETTLEMENT_STEPS)[number]['index']
  name: SettlementStepName
  status: StepStatus
}

/** GET /api/sessions?wallet_id= item. */
export interface SessionSummary {
  session_id: SessionId
  state: SessionState
  my_role: Role
  counterparty_address: string
  asset: AssetRef
  rgb_amount: number
  agreed_price_usd: number | null
  created_at: number
  updated_at: number
  /** True while the terms wait for the requesting wallet's signature. */
  needs_my_signature?: boolean
}

/** GET /api/sessions/{id}?wallet_id=: the session as seen by one wallet. */
export interface SessionView extends SessionSummary {
  payment_asset: AssetRef
  counterparty_trust: TrustAudit
  rounds: Round[]
  /** Which agent is generating its turn right now. */
  thinking: Role | null
  gate: GateResult | null
  terms: CanonicalSwapTerms | null
  terms_hash: string | null
  buyer_signed: boolean
  seller_signed: boolean
  /** Empty until SETTLING. */
  settlement_steps: SettlementStep[]
  txid: string | null
  /** Set when state is FAILED. */
  failure: ApiErrorBody | null
  /** 1-based place in the negotiation queue while waiting for its turn; null once running. */
  queue_position?: number | null
  /** Safety cap on rounds for this backend (default MAX_ROUNDS). */
  max_rounds?: number
  /** The seller's public list price for this amount (pro rata when it is part of the lot). */
  list_price_usd?: number
}

// ── Requests ───────────────────────────────────────────────────────

/** POST /api/sessions. Returns immediately; negotiation runs in the background. */
export interface CreateSessionRequest {
  buyer_wallet_id: WalletId
  seller_address: string
  asset_id: AssetId
  rgb_amount: number
  buyer_max_ceiling_usd: number
  buyer_target_usd: number
  buyer_ai_prompt: string
}

/** POST /api/wallets/create. The mnemonic comes from Tether WDK (regtest only). */
export interface CreateWalletRequest {
  label: string
  mnemonic?: string
}

/**
 * POST /api/sessions/{id}/sign. terms_hash is the hash the user reviewed; the
 * backend rejects it with 409 terms_hash_mismatch if it differs from the active terms.
 */
export interface SignRequest {
  wallet_id: WalletId
  terms_hash: string
}

/** PUT /api/wallets/{id}/aliases. A non-empty name also adds the address to the wallet's contacts. */
export interface SetAliasRequest {
  address: string
  name: string
}

/** PUT /api/wallets/{id}/agent_profile */
export type UpdateAgentProfileRequest = Partial<AgentProfile>

// ── Errors ─────────────────────────────────────────────────────────

/** Body of every non-2xx response. */
export interface ApiErrorBody {
  code: string
  message: string
}
