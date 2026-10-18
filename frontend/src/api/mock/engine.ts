import { ApiError, WHOLE_USD_MESSAGE } from '../client'
import {
  CANCELLABLE_STATES,
  MAX_ROUNDS,
  SETTLEMENT_STEPS,
  TERMINAL_STATES,
  type AdviceView,
  type AskRequest,
  type AskView,
  type AgentAction,
  type AgentProfile,
  type AssetBalance,
  type AgentSearchRequest,
  type AgentSearchResult,
  type AssetAmountRequest,
  type AssetId,
  type AssetRef,
  type CanonicalSwapTerms,
  type Contact,
  type CreateSessionRequest,
  type CreateWalletRequest,
  type CreateWantRequest,
  type Health,
  type Market,
  type PublicDesk,
  type ReceiveInvoice,
  type RefreshResult,
  type Role,
  type SessionId,
  type SessionState,
  type SessionSummary,
  type SessionView,
  type SetAliasRequest,
  type SettlementStep,
  type ShopListing,
  type ShopQuery,
  type TransferResult,
  type TrustAudit,
  type TrustTier,
  type UpdateAgentProfileRequest,
  type WalletId,
  type WalletState,
  type WalletSummary,
} from '../types'
import {
  ASSET_LIST,
  ASSETS,
  ECONOMY,
  EXTERNAL_CONTACTS,
  createEmptyWallet,
  createSeedWallets,
  createSeedWants,
  randomHex,
  totalUsd,
  trustFor,
  withWalkAways,
  type MockWallet,
  type MockWant,
} from './seed'
import { computeAdvice, type OwnSession } from './advice'
import { computeAnswer } from './ask'
import { MIN_PART_USD, minLotAmount, proRataPrice } from '@/lib/lots'
import { canonicalJson, sha256Hex, sha256HexSync } from './sha256'

/** In-memory backend shared by every pane in the tab. All timings in ms. */
const TIMING = {
  buyerThink: 1200,
  sellerThink: 1300,
  gate: 500,
  step: 800,
  termsTtlSeconds: 600,
}

/** Agents close the deal once the gap between offers is this small (USD). */
const CLOSE_GAP_USD = 4

interface MockRound {
  n: number
  buyer_offer_usd: number | null
  seller_offer_usd: number | null
  buyer_action: AgentAction | null
  seller_action: AgentAction | null
  buyer_thought: string | null
  seller_thought: string | null
  public_messages: { buyer: string | null; seller: string | null }
}

interface MockSession {
  id: SessionId
  buyerId: WalletId
  /** null when the counterparty is an external address with no wallet here. */
  sellerId: WalletId | null
  sellerAddress: string
  asset: AssetRef
  paymentAsset: AssetRef
  rgbAmount: number
  ceilingUsd: number
  targetUsd: number
  /** The desk's list price and secret reserve for this amount (pro rata for part of the lot). */
  listPriceUsd: number
  reserveUsd: number
  /** Each owner's strategy for their own agent, fixed when the session starts. */
  buyerPrompt: string
  sellerPrompt: string
  state: SessionState
  rounds: MockRound[]
  thinking: Role | null
  agreedPriceUsd: number | null
  gate: { passed: boolean; reasons: string[] } | null
  /** The buyer chose to trade with a seller that is not High Authenticity (accept_risk). */
  riskAccepted: boolean
  terms: CanonicalSwapTerms | null
  termsHash: string | null
  buyerSigned: boolean
  sellerSigned: boolean
  steps: SettlementStep[]
  txid: string | null
  failure: { code: string; message: string } | null
  createdAt: number
  updatedAt: number
  timers: Set<ReturnType<typeof setTimeout>>
}

const now = () => Math.floor(Date.now() / 1000)

const wallets = new Map<WalletId, MockWallet>(createSeedWallets(now()).map((w) => [w.summary.wallet_id, w]))
const sessions = new Map<SessionId, MockSession>()
const wants = new Map<string, MockWant>(createSeedWants(now()).map((w) => [w.id, w]))
let pepePriceUsd: number | null = null
let createdWallets = 0

// ── Errors ─────────────────────────────────────────────────────────

const notFound = (code: string, message: string) => new ApiError(code, message, 404)
const badRequest = (code: string, message: string) => new ApiError(code, message, 400)
const conflict = (code: string, message: string) => new ApiError(code, message, 409)

function walletOrThrow(walletId: WalletId): MockWallet {
  const wallet = wallets.get(walletId)
  if (!wallet) throw notFound('wallet_not_found', `No wallet ${walletId}`)
  return wallet
}

function walletByAddress(address: string): MockWallet | undefined {
  for (const wallet of wallets.values()) if (wallet.summary.address === address) return wallet
  return undefined
}

// ── Trust ──────────────────────────────────────────────────────────

/** Agreed deals each address walked away from: it cancelled them, or left them unsigned to expiry while the other side signed. */
const walkAways = new Map<string, number>()

/** As session_store: leaving a deal whose counterparty is not High Authenticity is declining a risk, not walking away. */
function walkAway(address: string, counterparty: string) {
  if (trustOf(counterparty).trust_tier !== 'High Authenticity') return
  walkAways.set(address, (walkAways.get(address) ?? 0) + 1)
}

/** The address's trust as the backend scores it now: the seeded one, minus its walk-aways. */
function trustOf(address: string): TrustAudit {
  return withWalkAways(trustFor(address), walkAways.get(address) ?? 0)
}

/** Only the public fields of an active desk: the reserve and the prompt stay private. */
function publicDesk(address: string): PublicDesk | null {
  const profile = walletByAddress(address)?.agent_profile
  const asset = ASSET_LIST.find((a) => a.asset_id === profile?.offered_asset_id)
  if (!profile?.seller_active || !asset) return null
  return { asset, offered_amount: profile.offered_amount, asking_price_usd: profile.asking_price_usd, allow_partial: profile.allow_partial }
}

// ── Shop ───────────────────────────────────────────────────────────

const NO_OVERLAP_REASON = "No deal possible: the buyer's maximum is below the seller's minimum."

const REGTEST_ADDRESS = /^bcrt1[0-9a-z]{20,90}$/i

function wantListing(want: MockWant, viewer: MockWallet): ShopListing {
  return {
    listing_id: want.id,
    kind: 'want',
    owner_address: want.ownerAddress,
    owner_alias: viewer.local_aliases[want.ownerAddress] ?? null,
    is_mine: want.ownerAddress === viewer.summary.address,
    asset: want.asset,
    amount: want.amount,
    price_usd: want.targetUsd,
    // A request is answered with its whole amount.
    allow_partial: false,
    note: want.note,
    trust: trustOf(want.ownerAddress),
    created_at: want.createdAt,
  }
}

/** Active Seller Desks, public fields only. */
function sellListings(viewer: MockWallet): ShopListing[] {
  const listings: ShopListing[] = []
  for (const owner of wallets.values()) {
    const desk = publicDesk(owner.summary.address)
    if (!desk) continue
    listings.push({
      listing_id: `desk_${owner.summary.wallet_id}`,
      kind: 'sell',
      owner_address: owner.summary.address,
      owner_alias: viewer.local_aliases[owner.summary.address] ?? null,
      is_mine: owner.summary.wallet_id === viewer.summary.wallet_id,
      asset: desk.asset,
      amount: desk.offered_amount,
      price_usd: desk.asking_price_usd,
      allow_partial: desk.allow_partial,
      note: null,
      trust: trustOf(owner.summary.address),
      created_at: null,
    })
  }
  return listings
}

function sessionOrThrow(sessionId: SessionId): MockSession {
  const session = sessions.get(sessionId)
  if (!session) throw notFound('session_not_found', `No session ${sessionId}`)
  return session
}

function roleOrThrow(s: MockSession, walletId: WalletId): Role {
  if (s.buyerId === walletId) return 'buyer'
  if (s.sellerId === walletId) return 'seller'
  throw new ApiError('forbidden', 'This wallet is not part of the session', 403)
}

const isTerminal = (state: SessionState) => TERMINAL_STATES.includes(state)
const units = (amount: number, asset: AssetRef) => amount / 10 ** asset.precision

// ── Views ──────────────────────────────────────────────────────────

/** The wallet's sessions as it sees them, with the strategy it gave its own agent in each. */
function ownSessions(walletId: WalletId): OwnSession[] {
  return [...sessions.values()]
    .filter((s) => s.buyerId === walletId || s.sellerId === walletId)
    .map((s) => {
      const role = roleOrThrow(s, walletId)
      return { ...sessionView(s, role), my_ai_prompt: role === 'buyer' ? s.buyerPrompt : s.sellerPrompt }
    })
}

function walletState(w: MockWallet): WalletState {
  const assets: AssetBalance[] = ASSET_LIST.filter(
    (a) => a.asset_id === ASSETS.btc.asset_id || (w.balances[a.asset_id] ?? 0) > 0,
  ).map((a) => ({ ...a, amount: w.balances[a.asset_id] ?? 0 }))
  return {
    ...w.summary,
    assets,
    avg_cost_basis: w.avg_cost_basis,
    history_points: w.history_points,
    activity: w.activity,
    local_aliases: w.local_aliases,
    agent_profile: w.agent_profile,
    trust: trustOf(w.summary.address),
  }
}

function summaryView(s: MockSession, role: Role): SessionSummary {
  const counterparty = role === 'buyer' ? s.sellerAddress : walletOrThrow(s.buyerId).summary.address
  return {
    session_id: s.id,
    state: s.state,
    my_role: role,
    counterparty_address: counterparty,
    asset: s.asset,
    rgb_amount: s.rgbAmount,
    agreed_price_usd: s.agreedPriceUsd,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
    needs_my_signature: s.state === 'AWAITING_SIGNATURES' && !(role === 'buyer' ? s.buyerSigned : s.sellerSigned),
  }
}

/** Perspective masking: only the viewer's own thought; never the other side's secrets. */
function sessionView(s: MockSession, role: Role): SessionView {
  const summary = summaryView(s, role)
  const counterpartyTrust = trustOf(summary.counterparty_address)
  return {
    ...summary,
    payment_asset: s.paymentAsset,
    list_price_usd: s.listPriceUsd,
    risk_accepted: s.riskAccepted,
    counterparty_trust: counterpartyTrust,
    rounds: s.rounds.map((r) => ({
      n: r.n,
      buyer_offer_usd: r.buyer_offer_usd,
      seller_offer_usd: r.seller_offer_usd,
      buyer_action: r.buyer_action,
      seller_action: r.seller_action,
      my_private_thought: role === 'buyer' ? r.buyer_thought : r.seller_thought,
      public_messages: { ...r.public_messages },
    })),
    thinking: s.thinking,
    gate: s.gate && { ...s.gate, trust_tier: counterpartyTrust.trust_tier },
    terms: s.terms,
    terms_hash: s.termsHash,
    buyer_signed: s.buyerSigned,
    seller_signed: s.sellerSigned,
    settlement_steps: s.steps,
    txid: s.txid,
    failure: s.failure,
  }
}

// ── Session lifecycle ──────────────────────────────────────────────

function touch(s: MockSession) {
  s.updatedAt = now()
}

function setState(s: MockSession, state: SessionState) {
  s.state = state
  touch(s)
  if (isTerminal(state)) {
    s.thinking = null
    s.timers.forEach(clearTimeout)
    s.timers.clear()
  }
}

function schedule(s: MockSession, ms: number, fn: () => void) {
  const timer = setTimeout(() => {
    s.timers.delete(timer)
    if (!isTerminal(s.state)) fn()
  }, ms)
  s.timers.add(timer)
}

/** Terms past their expiry: a party that left them unsigned while the other signed walked away. */
function expire(s: MockSession) {
  const buyerAddress = walletOrThrow(s.buyerId).summary.address
  if (s.buyerSigned !== s.sellerSigned) {
    if (s.buyerSigned) walkAway(s.sellerAddress, buyerAddress)
    else walkAway(buyerAddress, s.sellerAddress)
  }
  setState(s, 'EXPIRED')
}

function block(s: MockSession, reasons: string[]) {
  s.gate = { passed: false, reasons }
  setState(s, 'BLOCKED_BY_GATE')
}

/** As the gate after the agreement: an untrusted seller fails, naming only its tier, unless the buyer accepted the risk. */
function trustReasons(address: string, riskAccepted: boolean): string[] {
  const trust = trustOf(address)
  return trust.trusted || riskAccepted ? [] : [`Counterparty trust check failed: ${trust.trust_tier}`]
}

/** As api_server.create_session: the 409 confirm_risk sentence for a seller that is not High Authenticity. */
function riskMessage(label: string, tier: TrustTier): string {
  if (tier === 'Ring Anomaly Detected') {
    return `${label} trades in loops with itself, a pattern used to fake reliability. Trading with it is a high risk.`
  }
  return `${label} ${tier === 'Unverified' ? 'has no trade history yet' : 'has low reliability'}: trading with it is a risk.`
}

/** As api_server._lot_prices: unit prices of the lot times the amount; the reserve rounds up. */
function lotPrices(desk: AgentProfile, amount: number): { list: number; reserve: number } {
  if (desk.offered_amount <= 0 || amount >= desk.offered_amount) {
    return { list: desk.asking_price_usd, reserve: desk.secret_min_reserve_usd }
  }
  const list = proRataPrice(desk.asking_price_usd, desk.offered_amount, amount)
  return { list, reserve: Math.min(Math.ceil((desk.secret_min_reserve_usd * amount) / desk.offered_amount), list) }
}

/** After a sale the lot shrinks at the same unit prices; a sold-out desk switches off. */
function consumeLot(desk: AgentProfile, assetId: string, amount: number) {
  if (desk.offered_asset_id !== assetId || desk.offered_amount <= 0) return
  const left = Math.max(desk.offered_amount - amount, 0)
  if (left === 0) {
    desk.seller_active = false
    desk.offered_amount = 0
    return
  }
  const share = left / desk.offered_amount
  desk.offered_amount = left
  desk.asking_price_usd = Math.max(1, Math.floor(desk.asking_price_usd * share + 0.5))
  desk.secret_min_reserve_usd = Math.min(Math.floor(desk.secret_min_reserve_usd * share + 0.5), desk.asking_price_usd)
}

function buyerTurn(s: MockSession) {
  const previous = s.rounds.at(-1)
  const round: MockRound = {
    n: s.rounds.length + 1,
    buyer_offer_usd: null,
    seller_offer_usd: null,
    buyer_action: null,
    seller_action: null,
    buyer_thought: null,
    seller_thought: null,
    public_messages: { buyer: null, seller: null },
  }
  s.rounds.push(round)
  s.thinking = 'buyer'
  touch(s)

  schedule(s, TIMING.buyerThink, () => {
    const lastAsk = previous?.seller_offer_usd ?? s.listPriceUsd
    const prevBid = previous?.buyer_offer_usd ?? null
    const finalRound = round.n >= MAX_ROUNDS
    const closeEnough = prevBid !== null && lastAsk - prevBid <= CLOSE_GAP_USD

    if (lastAsk <= s.ceilingUsd && (lastAsk <= s.targetUsd || closeEnough || finalRound)) {
      round.buyer_action = 'ACCEPT'
      round.buyer_offer_usd = lastAsk
      round.public_messages.buyer = `Deal at ${lastAsk} USDT.`
      round.buyer_thought = `${lastAsk} USDT is inside my limit and the gap is small. Closing now beats risking the deal.`
      agree(s, lastAsk)
      return
    }

    let bid =
      prevBid === null
        ? Math.round(Math.min(s.targetUsd, lastAsk) * 0.85)
        : Math.round(prevBid + (Math.min(s.ceilingUsd, lastAsk) - prevBid) * 0.5)
    if (finalRound) bid = s.ceilingUsd
    bid = Math.max(bid, (prevBid ?? 0) + 1)
    bid = Math.max(1, Math.min(bid, s.ceilingUsd, lastAsk - 1))

    round.buyer_action = 'OFFER'
    round.buyer_offer_usd = bid
    if (prevBid === null) {
      round.public_messages.buyer = `I can offer ${bid} USDT for the lot.`
      round.buyer_thought = `The public ask is ${lastAsk} USDT. Opening at ${bid} leaves room to concede without showing how far I can go.`
    } else if (finalRound) {
      round.public_messages.buyer = `Final offer: ${bid} USDT.`
      round.buyer_thought = `Last round. ${bid} is as far as I will go; above that I walk away.`
    } else {
      round.public_messages.buyer = `I can move to ${bid} USDT.`
      round.buyer_thought = `They came down to ${lastAsk}. Moving to ${bid} is a real step, still comfortably inside my limit.`
    }
    sellerTurn(s, round, lastAsk)
  })
}

function sellerTurn(s: MockSession, round: MockRound, lastAsk: number) {
  s.thinking = 'seller'
  touch(s)

  schedule(s, TIMING.sellerThink, () => {
    const bid = round.buyer_offer_usd as number
    const prevAsk = Math.min(lastAsk, s.listPriceUsd)
    const reserve = s.reserveUsd
    const finalRound = round.n >= MAX_ROUNDS

    if (bid >= reserve && (prevAsk - bid <= CLOSE_GAP_USD || finalRound)) {
      round.seller_action = 'ACCEPT'
      round.seller_offer_usd = bid
      round.public_messages.seller = `Agreed at ${bid} USDT.`
      round.seller_thought = `${bid} clears my floor and the gap is small. Taking it.`
      agree(s, bid)
      return
    }
    if (finalRound) {
      s.thinking = null
      round.seller_thought = `${bid} is still below my floor. No deal this time.`
      round.public_messages.seller = 'I cannot go lower. No deal.'
      block(s, [`No agreement within ${MAX_ROUNDS} rounds.`])
      return
    }

    let ask = Math.round(prevAsk - (prevAsk - Math.max(reserve, bid)) * (round.n === 1 ? 0.35 : 0.5))
    ask = Math.min(Math.max(ask, reserve, bid + 1), prevAsk)
    round.seller_action = 'OFFER'
    round.seller_offer_usd = ask
    round.public_messages.seller = `I can go to ${ask} USDT for the lot.`
    round.seller_thought =
      bid < reserve
        ? `${bid} is below where I can sell. Countering at ${ask} keeps momentum without showing my floor.`
        : `${bid} is getting close. Conceding to ${ask} so we can meet soon, still above my floor.`
    buyerTurn(s)
  })
}

function agree(s: MockSession, priceUsd: number) {
  s.thinking = null
  s.agreedPriceUsd = priceUsd
  touch(s)
  schedule(s, TIMING.gate, () => {
    void runGate(s)
  })
}

async function runGate(s: MockSession) {
  const price = s.agreedPriceUsd as number
  const buyer = walletOrThrow(s.buyerId)
  const seller = walletOrThrow(s.sellerId as WalletId)
  const paymentAmount = price * 10 ** s.paymentAsset.precision
  const reasons = trustReasons(s.sellerAddress, s.riskAccepted)

  if (price > s.ceilingUsd) reasons.push('Agreed price is above the buyer ceiling.')
  if (price < s.reserveUsd) reasons.push('Agreed price is below the seller reserve.')
  if (!Number.isInteger(s.rgbAmount) || s.rgbAmount <= 0 || !Number.isInteger(paymentAmount) || paymentAmount <= 0) {
    reasons.push('Amounts must be positive integers.')
  }
  if ((buyer.balances[s.paymentAsset.asset_id] ?? 0) < paymentAmount) reasons.push('Buyer balance is too low for the payment.')
  if ((seller.balances[s.asset.asset_id] ?? 0) < s.rgbAmount) reasons.push('Seller balance is too low for the lot.')
  if (reasons.length > 0) {
    block(s, reasons)
    return
  }

  const terms: CanonicalSwapTerms = {
    session_id: s.id,
    asset_id: s.asset.asset_id,
    rgb_amount: s.rgbAmount,
    payment_asset_id: s.paymentAsset.asset_id,
    payment_amount: paymentAmount,
    agreed_price_usd: price,
    network_fee_sat: ECONOMY.networkFeeSat,
    buyer_address: buyer.summary.address,
    seller_address: seller.summary.address,
    expiry_unix: now() + TIMING.termsTtlSeconds,
  }
  const hash = await sha256Hex(canonicalJson(terms))
  if (isTerminal(s.state)) return
  s.gate = { passed: true, reasons: [] }
  s.terms = terms
  s.termsHash = hash
  setState(s, 'AWAITING_SIGNATURES')
  schedule(s, TIMING.termsTtlSeconds * 1000, () => {
    if (s.state === 'AWAITING_SIGNATURES') expire(s)
  })
}

function runSettlement(s: MockSession) {
  setState(s, 'SETTLING')
  s.steps = SETTLEMENT_STEPS.map((step) => ({ index: step.index, name: step.name, status: 'pending' }))
  const advance = (i: number) => {
    if (i > 0) s.steps[i - 1].status = 'done'
    if (i === s.steps.length) {
      applySettlement(s)
      return
    }
    s.steps[i].status = 'running'
    if (s.steps[i].name === 'broadcast_swap_completion') s.txid = randomHex(32)
    touch(s)
    schedule(s, TIMING.step, () => advance(i + 1))
  }
  advance(0)
}

function applySettlement(s: MockSession) {
  const terms = s.terms as CanonicalSwapTerms
  const buyer = walletOrThrow(s.buyerId)
  const seller = walletOrThrow(s.sellerId as WalletId)
  const pay = s.paymentAsset.asset_id
  const lot = s.asset.asset_id
  const btc = ASSETS.btc.asset_id

  if ((buyer.balances[pay] ?? 0) < terms.payment_amount || (seller.balances[lot] ?? 0) < terms.rgb_amount) {
    s.failure = { code: 'insufficient_funds', message: 'A balance changed before settlement completed.' }
    s.steps.forEach((step) => {
      if (step.status !== 'done') step.status = 'failed'
    })
    setState(s, 'FAILED')
    return
  }

  // Cost basis for the buyer: weighted average USD per display unit.
  const heldUnits = units(buyer.balances[lot] ?? 0, s.asset)
  const boughtUnits = units(terms.rgb_amount, s.asset)
  const prevBasis = buyer.avg_cost_basis[lot] ?? 0
  buyer.avg_cost_basis[lot] = (prevBasis * heldUnits + terms.agreed_price_usd) / (heldUnits + boughtUnits)

  buyer.balances[pay] -= terms.payment_amount
  buyer.balances[lot] = (buyer.balances[lot] ?? 0) + terms.rgb_amount
  buyer.balances[btc] = (buyer.balances[btc] ?? 0) - terms.network_fee_sat
  seller.balances[lot] -= terms.rgb_amount
  seller.balances[pay] = (seller.balances[pay] ?? 0) + terms.payment_amount
  consumeLot(seller.agent_profile, lot, terms.rgb_amount)
  if (lot === ASSETS.pepe.asset_id) pepePriceUsd = terms.agreed_price_usd / boughtUnits

  const t = now()
  const item = (direction: 'in' | 'out', asset: AssetRef, amount: number, counterparty: string) => ({
    id: `${s.id}-${direction}-${asset.ticker}`,
    t,
    kind: 'swap' as const,
    direction,
    asset,
    amount,
    counterparty_address: counterparty,
    txid: s.txid,
    session_id: s.id,
    status: 'confirmed' as const,
  })
  buyer.activity.unshift(item('in', s.asset, terms.rgb_amount, seller.summary.address), item('out', s.paymentAsset, terms.payment_amount, seller.summary.address))
  seller.activity.unshift(item('in', s.paymentAsset, terms.payment_amount, buyer.summary.address), item('out', s.asset, terms.rgb_amount, buyer.summary.address))
  for (const w of [buyer, seller]) {
    w.history_points.push({ t, balances: { ...w.balances }, total_usd: totalUsd(w.balances, pepePriceUsd) })
  }
  setState(s, 'SETTLED')
}

// ── Vault moves ────────────────────────────────────────────────────

/** An RGB invoice issued by POST /api/wallets/{id}/receive_invoice. */
export interface MockInvoice {
  walletId: WalletId
  asset: AssetRef
  amount: number
  paid: boolean
}

const INVOICE_TTL_SECONDS = 3600
const invoices = new Map<string, MockInvoice>()

/** The Vault service as the backend reaches it (VAULT_URL); src/vault/mock.ts connects it. */
export interface MockVaultLink {
  /** Throws as invoice would, vault_missing (404) or vault_locked (409), without issuing one. */
  ready(walletId: WalletId): void
  /** POST /vault/{id}/invoice. Throws vault_missing (404) or vault_locked (409). */
  invoice(walletId: WalletId, assetId: AssetId, amount: number): string
  /** The paid invoice reaches the Vault (the backend then refreshes it). */
  receive(invoice: string): void
}

let vaultLink: MockVaultLink | null = null

/** Until the mock Vault connects, move_to_vault answers 503, like a backend whose Vault is down. */
export function connectMockVault(link: MockVaultLink): void {
  vaultLink = link
}

/** The connected Vault, or the backend's 503 for a Vault service that does not answer. */
function linkOrThrow(): MockVaultLink {
  if (!vaultLink) throw new ApiError('vault_unavailable', 'The Vault is not reachable right now. Try again in a moment.', 503)
  return vaultLink
}

/** As api_server._vault_invoice: the Vault's errors reach the client, its 404 vault_missing as a 409. */
function askVault<T>(ask: () => T): T {
  try {
    return ask()
  } catch (err) {
    if (err instanceof ApiError && err.code === 'vault_missing') throw conflict(err.code, 'You have no Vault yet. Create it first.')
    throw err
  }
}

/** The mock wallet an RGB invoice pays, if one of them issued it. */
export function invoicePayee(invoice: string): MockInvoice | undefined {
  return invoices.get(invoice)
}

function rgbAssetOrThrow(assetId: AssetId): AssetRef {
  const asset = ASSET_LIST.find((a) => a.asset_id === assetId && a.schema !== 'BTC')
  if (!asset) throw badRequest('invalid_request', 'Only USDT and PEPE move between your Wallet and your Vault.')
  return asset
}

function amountOrThrow(amount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('invalid_request', 'Enter a whole amount greater than 0.')
}

/** A move between a wallet and its own Vault: no counterparty, and no memory-graph edge. */
function vaultItem(direction: 'in' | 'out', asset: AssetRef, amount: number, txid: string) {
  return {
    id: `vault-${txid.slice(0, 12)}`,
    t: now(),
    kind: 'vault' as const,
    direction,
    asset,
    amount,
    counterparty_address: null,
    txid,
    session_id: null,
    status: 'confirmed' as const,
  }
}

/** Records a Vault move on the wallet: an activity item and a point of its balance chart, like the backend. */
function recordVaultMove(wallet: MockWallet, direction: 'in' | 'out', asset: AssetRef, amount: number, txid: string) {
  wallet.activity.unshift(vaultItem(direction, asset, amount, txid))
  wallet.history_points.push({ t: now(), balances: { ...wallet.balances }, total_usd: totalUsd(wallet.balances, pepePriceUsd) })
}

/** As api_server.DEALS_IN_PROGRESS: deals that can still settle. */
const DEALS_IN_PROGRESS: readonly SessionState[] = ['NEGOTIATING', 'AWAITING_SIGNATURES', 'SETTLING']

/**
 * As api_server._promised: what the wallet promised of an asset in deals that can still settle,
 * each lot it sells and, as the buyer, the agreed payment, or its ceiling while the price is negotiated.
 */
function promisedAmount(walletId: WalletId, assetId: AssetId): number {
  let promised = 0
  for (const s of sessions.values()) {
    if (!DEALS_IN_PROGRESS.includes(s.state)) continue
    if (s.sellerId === walletId && s.asset.asset_id === assetId) promised += s.rgbAmount
    if (s.buyerId === walletId && s.paymentAsset.asset_id === assetId) {
      promised += s.state === 'NEGOTIATING' ? s.ceilingUsd * 10 ** s.paymentAsset.precision : (s.terms?.payment_amount ?? 0)
    }
  }
  return promised
}

/**
 * move_to_vault's own refusals, in the backend's order, before the Vault is asked for an invoice:
 * the balance, then what must stay in the wallet (api_server._keep_promises), i.e. the lot its
 * active Seller Desk lists and what its deals in progress promise.
 */
function moveToVaultChecks(walletId: WalletId, body: AssetAmountRequest): { wallet: MockWallet; asset: AssetRef } {
  const wallet = walletOrThrow(walletId)
  const asset = rgbAssetOrThrow(body.asset_id)
  amountOrThrow(body.amount)
  const amountText = (amount: number) => `${amount.toLocaleString('en-US')} ${asset.ticker}`
  const held = wallet.balances[asset.asset_id] ?? 0
  if (held < body.amount) throw conflict('insufficient_funds', `Your wallet does not hold ${amountText(body.amount)}.`)
  const desk = wallet.agent_profile
  const lot = desk.seller_active && desk.offered_asset_id === asset.asset_id ? desk.offered_amount : 0
  if (held - body.amount < lot) {
    throw conflict('desk_lot', `${amountText(lot)} are listed on your Seller Desk. Lower the lot or pause the desk first.`)
  }
  const promised = promisedAmount(walletId, asset.asset_id)
  if (held - body.amount < promised) {
    throw conflict('funds_committed', `${amountText(promised)} are promised in a deal in progress. Wait for it to finish or cancel it.`)
  }
  return { wallet, asset }
}

/** The Vault paid one of a wallet's invoices: the funds arrive as a "vault in" movement. */
export function receiveFromVault(invoice: string, txid: string): void {
  const entry = invoices.get(invoice)
  if (!entry || entry.paid) throw conflict('invalid_invoice', 'This invoice is unknown or already paid.')
  const wallet = walletOrThrow(entry.walletId)
  entry.paid = true
  wallet.balances[entry.asset.asset_id] = (wallet.balances[entry.asset.asset_id] ?? 0) + entry.amount
  recordVaultMove(wallet, 'in', entry.asset, entry.amount, txid)
}

// ── Public API (sync; MockApiClient adds latency and copies) ───────

export const mockEngine = {
  health(): Health {
    return { regtest: true, qvac: true, proxy: true }
  },

  market(): Market {
    return {
      mode: 'fixed_simulated',
      sats_per_usd: ECONOMY.satsPerUsd,
      assets: [
        { asset_id: ASSETS.usdt.asset_id, ticker: ASSETS.usdt.ticker, precision: ASSETS.usdt.precision, price_usd: 1, source: 'fixed_peg' },
        { asset_id: ASSETS.pepe.asset_id, ticker: ASSETS.pepe.ticker, precision: ASSETS.pepe.precision, price_usd: pepePriceUsd, source: 'p2p_negotiation' },
      ],
    }
  },

  listWallets(): WalletSummary[] {
    return [...wallets.values()].map((w) => w.summary)
  },

  getWallet(walletId: WalletId): WalletState {
    return walletState(walletOrThrow(walletId))
  },

  /** The mnemonic only seeds the fake address; it is never stored. */
  createWallet(body: CreateWalletRequest): WalletSummary {
    const label = body.label.trim()
    if (!label) throw badRequest('invalid_label', 'Label is required')
    const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
    const digest = sha256HexSync(body.mnemonic?.trim() || randomHex(16))
    const address = 'bcrt1q' + Array.from({ length: 38 }, (_, i) => charset[parseInt(digest.slice(i % 60, (i % 60) + 2), 16) % 32]).join('')
    const existing = walletByAddress(address)
    if (existing) return existing.summary
    createdWallets += 1
    const wallet = createEmptyWallet(`wallet_wdk_${createdWallets}`, label, address, now())
    wallets.set(wallet.summary.wallet_id, wallet)
    return wallet.summary
  },

  setAlias(walletId: WalletId, body: SetAliasRequest): Record<string, string> {
    const wallet = walletOrThrow(walletId)
    const name = body.name.trim()
    if (name) {
      if (!REGTEST_ADDRESS.test(body.address)) throw badRequest('invalid_address', 'Enter a valid regtest address (bcrt1…)')
      if (body.address === wallet.summary.address) throw badRequest('own_address', 'That is your own address')
      wallet.local_aliases[body.address] = name
    }
    else delete wallet.local_aliases[body.address]
    return wallet.local_aliases
  },

  updateAgentProfile(walletId: WalletId, body: UpdateAgentProfileRequest): AgentProfile {
    const wallet = walletOrThrow(walletId)
    const next = { ...wallet.agent_profile, ...body }
    const prices = [next.asking_price_usd, next.secret_min_reserve_usd, next.buyer_target_usd, next.buyer_max_ceiling_usd]
    if (!prices.every((usd) => Number.isInteger(usd))) throw badRequest('invalid_request', WHOLE_USD_MESSAGE)
    if (next.seller_active && next.secret_min_reserve_usd > next.asking_price_usd) {
      throw badRequest('invalid_profile', 'The secret reserve must not exceed the asking price')
    }
    if (next.buyer_target_usd > next.buyer_max_ceiling_usd) {
      throw badRequest('invalid_profile', 'The target must not exceed the ceiling')
    }
    wallet.agent_profile = next
    return next
  },

  receiveInvoice(walletId: WalletId, body: AssetAmountRequest): ReceiveInvoice {
    walletOrThrow(walletId)
    const asset = rgbAssetOrThrow(body.asset_id)
    amountOrThrow(body.amount)
    const recipientId = `utxob:${randomHex(16)}`
    const expiresAt = now() + INVOICE_TTL_SECONDS
    const invoice = `rgb:${asset.asset_id.slice(4)}/RGB20/${body.amount}+bcrt:${recipientId}?expiry=${expiresAt}&endpoints=rpc://127.0.0.1:3000/json-rpc`
    invoices.set(invoice, { walletId, asset, amount: body.amount, paid: false })
    return { invoice, recipient_id: recipientId, asset_id: asset.asset_id, amount: body.amount, expires_at: expiresAt }
  },

  /** Incoming transfers settle as they are paid here, so there is nothing left to do. */
  refreshWallet(walletId: WalletId): RefreshResult {
    walletOrThrow(walletId)
    return { wallet_id: walletId, refreshed: true }
  },

  /** move_to_vault's refusals alone, the Vault's included: MockApiClient answers them at once, before the slow move. */
  checkMoveToVault(walletId: WalletId, body: AssetAmountRequest): void {
    moveToVaultChecks(walletId, body)
    const link = linkOrThrow()
    askVault(() => link.ready(walletId))
  },

  /** The only endpoint that sends funds: it pays the Vault of the same wallet id, never an invoice from the client. */
  moveToVault(walletId: WalletId, body: AssetAmountRequest): TransferResult {
    const { wallet, asset } = moveToVaultChecks(walletId, body)
    const link = linkOrThrow()
    const invoice = askVault(() => link.invoice(walletId, asset.asset_id, body.amount))
    const txid = randomHex(32)
    wallet.balances[asset.asset_id] -= body.amount
    recordVaultMove(wallet, 'out', asset, body.amount, txid)
    link.receive(invoice)
    return { txid, asset_id: asset.asset_id, amount: body.amount }
  },

  getContacts(walletId: WalletId): Contact[] {
    const wallet = walletOrThrow(walletId)
    // Wallets and the demo's external addresses, plus every address this wallet has named.
    const addresses = [
      ...new Set([...wallets.values()].map((w) => w.summary.address).concat(EXTERNAL_CONTACTS, Object.keys(wallet.local_aliases))),
    ]
    return addresses
      .filter((address) => address !== wallet.summary.address)
      .map((address) => ({ address, alias: wallet.local_aliases[address] ?? null, trust: trustOf(address), desk: publicDesk(address) }))
  },

  /** The advisor on the owner's own data: its wallet, its sessions as it sees them and its own strategy in each. */
  getAdvice(walletId: WalletId): AdviceView {
    const wallet = walletOrThrow(walletId)
    return computeAdvice(walletId, walletState(wallet), ownSessions(walletId), mockEngine.market(), now())
  },

  /** Your AI on the same data, with the backend's rules answers (no local model in the browser). */
  ask(walletId: WalletId, body: AskRequest): AskView {
    const wallet = walletOrThrow(walletId)
    if (!body.preset && !body.question?.trim()) throw badRequest('invalid_request', 'Pick a preset or ask a question.')
    if ((body.question ?? '').length > 280) throw badRequest('invalid_request', 'Keep the question under 280 characters.')
    return computeAnswer(walletState(wallet), ownSessions(walletId), mockEngine.market(), body, now())
  },

  createSession(body: CreateSessionRequest): SessionView {
    const buyer = walletOrThrow(body.buyer_wallet_id)
    const seller = walletByAddress(body.seller_address)
    const asset = ASSET_LIST.find((a) => a.asset_id === body.asset_id)
    if (!asset || asset.schema === 'BTC') throw badRequest('invalid_asset', 'Unknown RGB asset')
    if (seller?.summary.wallet_id === buyer.summary.wallet_id) throw badRequest('self_trade', 'Cannot trade with yourself')
    if (!Number.isInteger(body.rgb_amount) || body.rgb_amount <= 0) throw badRequest('invalid_amount', 'Amount must be a positive integer')
    // The backend's schema takes whole dollars only; the client reads its refusal as this sentence.
    if (!Number.isInteger(body.buyer_target_usd) || !Number.isInteger(body.buyer_max_ceiling_usd)) throw badRequest('invalid_request', WHOLE_USD_MESSAGE)
    if (body.buyer_target_usd <= 0 || body.buyer_target_usd > body.buyer_max_ceiling_usd) {
      throw badRequest('invalid_limits', 'Target must be positive and not above the ceiling')
    }

    const t = now()
    const prices = seller ? lotPrices(seller.agent_profile, body.rgb_amount) : { list: 0, reserve: 0 }
    const s: MockSession = {
      id: `sess_${randomHex(6)}`,
      buyerId: buyer.summary.wallet_id,
      sellerId: seller?.summary.wallet_id ?? null,
      sellerAddress: body.seller_address,
      asset,
      paymentAsset: ASSETS.usdt,
      rgbAmount: body.rgb_amount,
      ceilingUsd: body.buyer_max_ceiling_usd,
      targetUsd: body.buyer_target_usd,
      listPriceUsd: prices.list,
      reserveUsd: prices.reserve,
      buyerPrompt: body.buyer_ai_prompt,
      sellerPrompt: seller?.agent_profile.seller_ai_prompt ?? '',
      state: 'NEGOTIATING',
      rounds: [],
      thinking: null,
      agreedPriceUsd: null,
      gate: null,
      riskAccepted: false,
      terms: null,
      termsHash: null,
      buyerSigned: false,
      sellerSigned: false,
      steps: [],
      txid: null,
      failure: null,
      createdAt: t,
      updatedAt: t,
      timers: new Set(),
    }

    // Layer-0 gate before any negotiation: an unknown address never reaches the agents.
    if (!seller) {
      sessions.set(s.id, s)
      block(s, ['Counterparty has no active desk.'])
      return sessionView(s, 'buyer')
    }
    // A seller that is not High Authenticity: the buyer decides, and nothing is created without consent.
    // The buyer's own tier never blocks, so a new or low wallet can rebuild its score.
    const sellerTrust = trustOf(body.seller_address)
    if (!sellerTrust.trusted) {
      if (!body.accept_risk) throw conflict('confirm_risk', riskMessage(seller.summary.label, sellerTrust.trust_tier))
      s.riskAccepted = true
    }

    const desk = seller.agent_profile
    if (!desk.seller_active || desk.offered_asset_id !== asset.asset_id) throw conflict('seller_desk_inactive', 'The counterparty is not selling this asset')
    if (body.rgb_amount > desk.offered_amount) throw conflict('exceeds_lot', `The seller offers at most ${desk.offered_amount}`)
    if (body.rgb_amount < desk.offered_amount && !desk.allow_partial) {
      throw conflict('partial_not_allowed', `The seller sells only the whole lot of ${desk.offered_amount}`)
    }
    const minAmount = minLotAmount(desk.asking_price_usd, desk.offered_amount)
    if (body.rgb_amount < minAmount) {
      throw badRequest('amount_too_small', `Buy at least ${minAmount} ${asset.ticker}: a smaller part is worth less than ${MIN_PART_USD} USDT.`)
    }
    if ((seller.balances[asset.asset_id] ?? 0) < body.rgb_amount) throw conflict('insufficient_funds', 'The seller does not hold that amount')
    if ((buyer.balances[ASSETS.usdt.asset_id] ?? 0) < body.buyer_max_ceiling_usd * 10 ** ASSETS.usdt.precision) {
      throw conflict('insufficient_funds', 'USDT balance is below the ceiling')
    }

    sessions.set(s.id, s)
    // Pre-negotiation: no overlap between the buyer's maximum and the seller's minimum, so the agents never talk.
    if (body.buyer_max_ceiling_usd < s.reserveUsd) {
      block(s, [NO_OVERLAP_REASON])
      return sessionView(s, 'buyer')
    }
    buyerTurn(s)
    return sessionView(s, 'buyer')
  },

  listSessions(walletId: WalletId): SessionSummary[] {
    walletOrThrow(walletId)
    return [...sessions.values()]
      .filter((s) => s.buyerId === walletId || s.sellerId === walletId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((s) => summaryView(s, roleOrThrow(s, walletId)))
  },

  getSession(sessionId: SessionId, walletId: WalletId): SessionView {
    const s = sessionOrThrow(sessionId)
    return sessionView(s, roleOrThrow(s, walletId))
  },

  sign(sessionId: SessionId, walletId: WalletId, termsHash: string): SessionView {
    const s = sessionOrThrow(sessionId)
    const role = roleOrThrow(s, walletId)
    if (s.state !== 'AWAITING_SIGNATURES') throw conflict('not_awaiting_signatures', `Session is ${s.state}`)
    if (s.terms && now() > s.terms.expiry_unix) {
      expire(s)
      throw conflict('expired', 'The terms expired before both signatures')
    }
    if (termsHash !== s.termsHash) throw conflict('terms_hash_mismatch', 'The signed terms differ from the active terms')
    if (role === 'buyer' ? s.buyerSigned : s.sellerSigned) throw conflict('already_signed', 'This wallet already signed')
    if (role === 'buyer') s.buyerSigned = true
    else s.sellerSigned = true
    touch(s)
    if (s.buyerSigned && s.sellerSigned) runSettlement(s)
    return sessionView(s, role)
  },

  getShop(walletId: WalletId, query: ShopQuery = {}): ShopListing[] {
    const viewer = walletOrThrow(walletId)
    const text = query.q?.trim().toLowerCase()
    const open = [...wants.values()].filter((w) => !w.closed).sort((a, b) => b.createdAt - a.createdAt)
    return [...sellListings(viewer), ...open.map((w) => wantListing(w, viewer))].filter((l) => {
      if (query.kind && l.kind !== query.kind) return false
      if (query.asset_id && l.asset.asset_id !== query.asset_id) return false
      if (!text) return true
      return [l.owner_alias, l.owner_address, l.asset.ticker, l.note].some((field) => field?.toLowerCase().includes(text))
    })
  },

  createWant(body: CreateWantRequest): ShopListing {
    const owner = walletOrThrow(body.wallet_id)
    const asset = ASSET_LIST.find((a) => a.asset_id === body.asset_id)
    if (!asset || asset.schema === 'BTC') throw badRequest('invalid_asset', 'Unknown RGB asset')
    if (!Number.isInteger(body.amount) || body.amount <= 0) throw badRequest('invalid_amount', 'Amount must be a positive integer')
    if (!(body.target_usd > 0)) throw badRequest('invalid_price', 'The target price must be greater than 0')
    const want: MockWant = {
      id: `want_${randomHex(4)}`,
      ownerAddress: owner.summary.address,
      asset,
      amount: body.amount,
      targetUsd: body.target_usd,
      note: body.note?.trim().slice(0, 140) || null,
      createdAt: now(),
      closed: false,
    }
    wants.set(want.id, want)
    return wantListing(want, owner)
  },

  closeListing(walletId: WalletId, listingId: string): ShopListing {
    const viewer = walletOrThrow(walletId)
    if (listingId.startsWith('desk_')) throw badRequest('desk_listing', 'Turn off your Seller Desk to remove this listing')
    const want = wants.get(listingId)
    if (!want || want.closed) throw notFound('listing_not_found', `No open listing ${listingId}`)
    if (want.ownerAddress !== viewer.summary.address) throw new ApiError('forbidden', 'This listing is not yours', 403)
    want.closed = true
    return wantListing(want, viewer)
  },

  /**
   * The buyer's agent shops for the cheapest fitting Seller Desk and opens a session with it.
   * Agents skip untrusted owners (rings, Low Reliability, Unverified), so the demo's tempting
   * Sybil offer is not picked.
   */
  agentSearch(body: AgentSearchRequest): AgentSearchResult {
    const buyer = walletOrThrow(body.buyer_wallet_id)
    const priceFor = (l: ShopListing) => (l.price_usd * body.rgb_amount) / l.amount
    const fits = sellListings(buyer)
      .filter((l) => !l.is_mine && l.asset.asset_id === body.asset_id && l.amount >= body.rgb_amount)
      .filter((l) => l.allow_partial || l.amount === body.rgb_amount)
      .filter((l) => l.trust.trusted)
      .filter((l) => priceFor(l) <= body.buyer_max_ceiling_usd * 1.5)
      // Server-side only: a desk whose secret floor is above the buyer's maximum could never close.
      .filter((l) => {
        const desk = walletByAddress(l.owner_address)?.agent_profile
        if (!desk || body.rgb_amount < minLotAmount(desk.asking_price_usd, desk.offered_amount)) return false
        return lotPrices(desk, body.rgb_amount).reserve <= body.buyer_max_ceiling_usd
      })
      .sort((a, b) => priceFor(a) - priceFor(b))
    const best = fits[0]
    if (!best) throw notFound('no_match', 'No matching listing right now')
    const session = mockEngine.createSession({
      buyer_wallet_id: body.buyer_wallet_id,
      seller_address: best.owner_address,
      asset_id: body.asset_id,
      rgb_amount: body.rgb_amount,
      buyer_max_ceiling_usd: body.buyer_max_ceiling_usd,
      buyer_target_usd: body.buyer_target_usd,
      buyer_ai_prompt: body.buyer_ai_prompt,
    })
    return { listing: best, session }
  },

  cancel(sessionId: SessionId, walletId: WalletId): SessionView {
    const s = sessionOrThrow(sessionId)
    const role = roleOrThrow(s, walletId)
    if (!CANCELLABLE_STATES.includes(s.state)) throw conflict('not_cancellable', `Session is ${s.state}`)
    // Cancelling agreed terms is walking away from them.
    if (s.state === 'AWAITING_SIGNATURES') {
      const buyerAddress = walletOrThrow(s.buyerId).summary.address
      if (role === 'buyer') walkAway(buyerAddress, s.sellerAddress)
      else walkAway(s.sellerAddress, buyerAddress)
    }
    setState(s, 'CANCELLED_BY_USER')
    return sessionView(s, role)
  },
}
