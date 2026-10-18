import type { AdviceSeverity, AdviceSignal, AdviceView, AssetBalance, Market, Role, SessionView, WalletId, WalletState } from '../types'

/**
 * The backend's advisor (backend/advisor.py) for mock mode: the same signals from the same data
 * (the wallet, its sessions as the owner sees them, the market), with the rules summary. There is
 * no local model in the browser, so generated_by is always "rules". Keep the rules and copy in step
 * with the backend.
 */

/** A session as its owner sees it, with the strategy the owner gave their own agent in it. */
export type OwnSession = SessionView & { my_ai_prompt: string }

const MAX_SIGNALS = 4
const TITLE_MAX = 40
const DETAIL_MAX = 90
const SEVERITY_RANK: Record<AdviceSeverity, number> = { warning: 0, tip: 1, info: 2 }

const MIN_WALLET_USD = 100
const IDLE_WINDOW_DAYS = 7
const IDLE_MIN_SHARE = 0.4
const IDLE_MAX_SPENT_SHARE = 0.25
const CONCENTRATION_SHARE = 0.7
const PACE_MIN_NEGOTIATIONS = 2
const DAY = 86_400

const NO_SIGNALS_SUMMARY = 'Nothing needs your attention right now.'

/** Half up, like the backend's _round. */
const round = (value: number) => Math.floor(value + 0.5)

/** Atomic units to display units: a whole number when it is one, else 2 decimals. */
export function units(amount: number, precision: number): number {
  const value = amount / 10 ** precision
  return Number.isInteger(value) ? value : Math.round(value * 100) / 100
}

const numberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 })
export const fmt = (value: number) => numberFormat.format(value)
const clip = (text: string, limit: number) => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`)

export function signal(kind: AdviceSignal['kind'], key: string, severity: AdviceSeverity, title: string, detail: string, numbers: Record<string, number>): AdviceSignal {
  return { id: `${kind}:${key}`, kind, severity, title: clip(title, TITLE_MAX), detail: clip(detail, DETAIL_MAX), numbers }
}

const ROLES: Role[] = ['buyer', 'seller']

/** Settled deals against the desk's public list price, one signal per role (never a secret limit). */
function savings(sessions: OwnSession[]): AdviceSignal[] {
  const signals: AdviceSignal[] = []
  for (const role of ROLES) {
    const deals = sessions.filter(
      (s) => s.my_role === role && s.state === 'SETTLED' && s.agreed_price_usd !== null && (s.list_price_usd ?? 0) > 0,
    )
    if (deals.length === 0) continue
    const paid = deals.reduce((sum, s) => sum + (s.agreed_price_usd ?? 0), 0)
    const asks = deals.reduce((sum, s) => sum + (s.list_price_usd ?? 0), 0)
    const pct = Math.max(round(((asks - paid) / asks) * 100), 0)
    const buyer = role === 'buyer'
    let title: string
    if (pct > 0) title = buyer ? `Paid ${pct}% below the list price` : `Sold ${pct}% below your asking price`
    else title = buyer ? 'Paid the full list price' : 'Sold at your asking price'
    const numbers: Record<string, number> = {
      [buyer ? 'paid_usd' : 'received_usd']: paid,
      ask_usd: asks,
      [buyer ? 'saved_usd' : 'below_ask_usd']: Math.max(asks - paid, 0),
      pct_below: pct,
      deals: deals.length,
    }
    let detail: string
    if (deals.length === 1) {
      const { asset, rgb_amount } = deals[0]
      const amount = units(rgb_amount, asset.precision)
      numbers.amount = amount
      detail = `$${fmt(paid)} for ${fmt(amount)} ${asset.ticker}, listed at $${fmt(asks)}.`
    } else {
      detail = `$${fmt(paid)} for $${fmt(asks)} listed, over ${deals.length} ${buyer ? 'buys' : 'sales'}.`
    }
    signals.push(signal('negotiation_savings', role, 'info', title, detail, numbers))
  }
  return signals
}

type Holding = { asset: AssetBalance; value: number | null }

/** Each balance with its USD value, null while its asset has no price (e.g. PEPE before a trade). */
function holdings(wallet: WalletState, market: Market): Holding[] {
  return wallet.assets.map((asset) => {
    if (asset.asset_id === 'btc') return { asset, value: asset.amount / market.sats_per_usd }
    const price = market.assets.find((a) => a.asset_id === asset.asset_id)?.price_usd ?? null
    return { asset, value: price === null ? null : (asset.amount / 10 ** asset.precision) * price }
  })
}

/**
 * A large RGB balance that trades barely used lately: a Vault tip. The amount and the share are the
 * balance's own, as the wallet's Assets and Allocation show them.
 */
function idleFunds(wallet: WalletState, held: Holding[], totalUsd: number, now: number): AdviceSignal[] {
  const since = now - IDLE_WINDOW_DAYS * DAY
  const signals: AdviceSignal[] = []
  for (const { asset, value } of held) {
    if (asset.asset_id === 'btc' || !value || asset.amount <= 0) continue
    const spent = wallet.activity
      .filter((item) => item.kind === 'swap' && item.direction === 'out' && item.asset.asset_id === asset.asset_id && item.t >= since)
      .reduce((sum, item) => sum + item.amount, 0)
    const share = value / totalUsd
    if (share < IDLE_MIN_SHARE || spent > IDLE_MAX_SPENT_SHARE * (asset.amount + spent)) continue
    const amount = units(asset.amount, asset.precision)
    const sharePct = round(share * 100)
    signals.push(
      signal(
        'idle_funds',
        asset.asset_id,
        'tip',
        `${fmt(amount)} ${asset.ticker} sits idle`,
        `${sharePct}% of your wallet. Move part to your Vault, where agents can't touch it.`,
        { idle_amount: amount, share_pct: sharePct, spent_amount: units(spent, asset.precision), window_days: IDLE_WINDOW_DAYS },
      ),
    )
  }
  return signals
}

/** One asset whose price can move holding most of the wallet; not BTC (fees) nor a USD peg. */
function concentration(held: Holding[], totalUsd: number, pegged: Set<string>): AdviceSignal[] {
  const signals: AdviceSignal[] = []
  for (const { asset, value } of held) {
    if (asset.asset_id === 'btc' || pegged.has(asset.asset_id) || !value) continue
    const share = value / totalUsd
    if (share < CONCENTRATION_SHARE) continue
    const sharePct = round(share * 100)
    signals.push(
      signal('concentration', asset.asset_id, 'warning', `${sharePct}% of your wallet is ${asset.ticker}`, "If its price drops, most of your wallet's value drops with it.", {
        share_pct: sharePct,
        value_usd: round(value),
      }),
    )
  }
  return signals
}

/** The owner's strategy preset (Strict / Balanced / Flexible), else their own words. */
function strategyLabel(prompt: string): string {
  const text = prompt.trim()
  if (!text) return 'Balanced'
  return ['Strict', 'Flexible'].find((preset) => text.startsWith(`${preset}:`)) ?? 'Your own'
}

/**
 * Deals and no-deals of the owner's finished negotiations in each role, with the strategy the owner
 * gave their agent in them. Sessions blocked before the agents spoke (trust gate, no overlap) and
 * talks cancelled before an agreement are left out.
 */
function pace(sessions: OwnSession[]): AdviceSignal[] {
  const signals: AdviceSignal[] = []
  for (const role of ROLES) {
    const mine = sessions.filter((s) => s.my_role === role)
    const deals = mine.filter((s) => s.agreed_price_usd !== null)
    const noDeals = mine.filter((s) => s.state === 'BLOCKED_BY_GATE' && s.rounds.length > 0 && s.agreed_price_usd === null)
    const talks = deals.length + noDeals.length
    if (talks < PACE_MIN_NEGOTIATIONS) continue
    const buyer = role === 'buyer'
    const used = new Set([...deals, ...noDeals].map((s) => strategyLabel(s.my_ai_prompt)))
    // A strategy is named only when every negotiation counted here ran with it.
    const context = used.size === 1 ? `${[...used][0]} ${buyer ? 'buying' : 'selling'} strategy` : `As a ${role}`
    const numbers: Record<string, number> = { negotiations: talks, deals: deals.length, no_deals: noDeals.length }
    // A deal is an agreement: it may still wait for signatures, or have been cancelled after it.
    let title: string
    if (deals.length > 0) {
      title = `Agreed in ${deals.length} of ${talks} negotiations`
      numbers.avg_rounds = round(deals.reduce((sum, s) => sum + s.rounds.length, 0) / deals.length)
    } else {
      title = `No deal in ${talks} negotiations`
    }
    const tip = noDeals.length > deals.length
    const detail = tip
      ? `${context}: ${noDeals.length} ended with no deal.${used.has('Flexible') ? '' : ' Flexible may close more.'}`
      : `${context}, about ${numbers.avg_rounds} round${numbers.avg_rounds === 1 ? '' : 's'} per deal.`
    signals.push(signal('pace', role, tip ? 'tip' : 'info', title, detail, numbers))
  }
  return signals
}

/** Observations from the owner's own data, most severe first (at most MAX_SIGNALS). */
export function computeSignals(wallet: WalletState, sessions: OwnSession[], market: Market, now: number): AdviceSignal[] {
  const held = holdings(wallet, market)
  const totalUsd = held.reduce((sum, h) => sum + (h.value ?? 0), 0)
  const pegged = new Set(market.assets.filter((a) => a.source === 'fixed_peg').map((a) => a.asset_id))
  const signals = savings(sessions)
  if (totalUsd >= MIN_WALLET_USD) signals.push(...idleFunds(wallet, held, totalUsd, now), ...concentration(held, totalUsd, pegged))
  signals.push(...pace(sessions))
  // Array.prototype.sort is stable: same severity keeps the order above.
  return signals.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]).slice(0, MAX_SIGNALS)
}

/** A signal's title as part of a sentence: "your agent paid 18% below the list price". */
function clause(s: AdviceSignal): string {
  if (s.kind === 'idle_funds' || s.kind === 'concentration') return s.title
  const lowered = s.title[0].toLowerCase() + s.title.slice(1)
  return s.title.startsWith('No ') ? `your agent made ${lowered}` : `your agent ${lowered}`
}

/** The rules summary: the top one or two signals in one sentence. */
export function templateSummary(signals: AdviceSignal[]): string {
  if (signals.length === 0) return NO_SIGNALS_SUMMARY
  const clauses = signals.slice(0, 2).map(clause)
  const subject = 'your agent '
  if (clauses.length === 2 && clauses.every((c) => c.startsWith(subject))) clauses[1] = clauses[1].slice(subject.length)
  const text = clauses.join(', and ')
  return `${text[0].toUpperCase()}${text.slice(1)}.`
}

export function computeAdvice(walletId: WalletId, wallet: WalletState, sessions: OwnSession[], market: Market, now: number): AdviceView {
  const signals = computeSignals(wallet, sessions, market, now)
  return { wallet_id: walletId, generated_at: now, generated_by: 'rules', phrasing: false, summary: templateSummary(signals), signals }
}
