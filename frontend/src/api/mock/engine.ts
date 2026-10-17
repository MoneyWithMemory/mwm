import { ApiError } from '../client'
import {
  CANCELLABLE_STATES,
  MAX_ROUNDS,
  SETTLEMENT_STEPS,
  TERMINAL_STATES,
  type AgentAction,
  type AgentProfile,
  type AssetBalance,
  type AgentSearchRequest,
  type AgentSearchResult,
  type AssetRef,
  type CanonicalSwapTerms,
  type Contact,
  type CreateSessionRequest,
  type CreateWalletRequest,
  type CreateWantRequest,
  type Health,
  type Market,
  type PublicDesk,
  type Role,
  type SessionId,
  type SessionState,
  type SessionSummary,
  type SessionView,
  type SetAliasRequest,
  type SettlementStep,
  type ShopListing,
  type ShopQuery,
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
  type MockWallet,
  type MockWant,
} from './seed'
import { minLotAmount, proRataPrice } from '@/lib/lots'
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
  state: SessionState
  rounds: MockRound[]
  thinking: Role | null
  agreedPriceUsd: number | null
  gate: { passed: boolean; reasons: string[] } | null
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
    trust: trustFor(want.ownerAddress),
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
      trust: trustFor(owner.summary.address),
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
  const counterpartyTrust = trustFor(summary.counterparty_address)
  return {
    ...summary,
    payment_asset: s.paymentAsset,
    list_price_usd: s.listPriceUsd,
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

function block(s: MockSession, reasons: string[]) {
  s.gate = { passed: false, reasons }
  setState(s, 'BLOCKED_BY_GATE')
}

function trustReasons(address: string): string[] {
  const trust = trustFor(address)
  if (trust.sybil_ring_detected) return ['Ring Anomaly Detected: this address trades inside a closed cluster of related wallets.']
  if (!trust.trusted) return ['Unverified counterparty: not enough validated history yet.']
  return []
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
  const reasons = [...trustReasons(s.sellerAddress), ...trustReasons(buyer.summary.address)]

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
    if (s.state === 'AWAITING_SIGNATURES') setState(s, 'EXPIRED')
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
    if (next.seller_active && next.secret_min_reserve_usd > next.asking_price_usd) {
      throw badRequest('invalid_profile', 'The secret reserve must not exceed the asking price')
    }
    if (next.buyer_target_usd > next.buyer_max_ceiling_usd) {
      throw badRequest('invalid_profile', 'The target must not exceed the ceiling')
    }
    wallet.agent_profile = next
    return next
  },

  getContacts(walletId: WalletId): Contact[] {
    const wallet = walletOrThrow(walletId)
    // Wallets and the demo's external addresses, plus every address this wallet has named.
    const addresses = [
      ...new Set([...wallets.values()].map((w) => w.summary.address).concat(EXTERNAL_CONTACTS, Object.keys(wallet.local_aliases))),
    ]
    return addresses
      .filter((address) => address !== wallet.summary.address)
      .map((address) => ({ address, alias: wallet.local_aliases[address] ?? null, trust: trustFor(address), desk: publicDesk(address) }))
  },

  createSession(body: CreateSessionRequest): SessionView {
    const buyer = walletOrThrow(body.buyer_wallet_id)
    const seller = walletByAddress(body.seller_address)
    const asset = ASSET_LIST.find((a) => a.asset_id === body.asset_id)
    if (!asset || asset.schema === 'BTC') throw badRequest('invalid_asset', 'Unknown RGB asset')
    if (seller?.summary.wallet_id === buyer.summary.wallet_id) throw badRequest('self_trade', 'Cannot trade with yourself')
    if (!Number.isInteger(body.rgb_amount) || body.rgb_amount <= 0) throw badRequest('invalid_amount', 'Amount must be a positive integer')
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
      state: 'NEGOTIATING',
      rounds: [],
      thinking: null,
      agreedPriceUsd: null,
      gate: null,
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

    // Layer-0 gate before any negotiation: rings and unverified addresses never reach the agents.
    const trustBlock = [...trustReasons(body.seller_address), ...trustReasons(buyer.summary.address)]
    if (trustBlock.length > 0 || !seller) {
      sessions.set(s.id, s)
      block(s, trustBlock.length > 0 ? trustBlock : ['Counterparty has no active desk.'])
      return sessionView(s, 'buyer')
    }

    const desk = seller.agent_profile
    if (!desk.seller_active || desk.offered_asset_id !== asset.asset_id) throw conflict('seller_desk_inactive', 'The counterparty is not selling this asset')
    if (body.rgb_amount > desk.offered_amount) throw conflict('exceeds_lot', `The seller offers at most ${desk.offered_amount}`)
    if (body.rgb_amount < desk.offered_amount && !desk.allow_partial) {
      throw conflict('partial_not_allowed', `The seller sells only the whole lot of ${desk.offered_amount}`)
    }
    const minAmount = minLotAmount(desk.asking_price_usd, desk.offered_amount)
    if (body.rgb_amount < minAmount) throw badRequest('amount_too_small', `Buy at least ${minAmount}: a smaller part costs less than 1 USDT`)
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
      setState(s, 'EXPIRED')
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
   * Agents skip owners flagged as a ring, so the demo's tempting Sybil offer is not picked.
   */
  agentSearch(body: AgentSearchRequest): AgentSearchResult {
    const buyer = walletOrThrow(body.buyer_wallet_id)
    const priceFor = (l: ShopListing) => (l.price_usd * body.rgb_amount) / l.amount
    const fits = sellListings(buyer)
      .filter((l) => !l.is_mine && l.asset.asset_id === body.asset_id && l.amount >= body.rgb_amount)
      .filter((l) => l.allow_partial || l.amount === body.rgb_amount)
      .filter((l) => l.trust.trust_tier !== 'Ring Anomaly Detected')
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
    setState(s, 'CANCELLED_BY_USER')
    return sessionView(s, role)
  },
}
