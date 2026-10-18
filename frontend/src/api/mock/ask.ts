import type { ActivityItem, AdviceSignal, AskRequest, AskView, AssetRef, Market, WalletState } from '../types'
import { computeSignals, fmt, signal, templateSummary, units, type OwnSession } from './advice'

/**
 * The backend's "Your AI" (backend/assistant.py) for mock mode: the same facts and the same rules
 * answers. There is no local model in the browser, so generated_by is always "rules" and note is
 * null. Keep the rules and copy in step with the backend.
 */

const WEEK_DAYS = 7
const MAX_FACTS = 4
const DAY = 86_400

export const OFF_TOPIC = 'I only know your account. Try: Analyze my account.'
const NOTHING_THIS_WEEK = 'Nothing moved in the last 7 days.'
const NO_IDLE_FUNDS = 'No need right now: nothing large sits idle in your wallet.'

const ON_TOPIC = new RegExp(
  '\\b(account|wallet|balances?|money|funds?|cash|vault|deals?|trad\\w*|swap\\w*|buy\\w*|bought|sell\\w*|sold|' +
    'prices?|paid|pay\\w*|spen[dt]\\w*|sav\\w*|idle|week\\w*|today|yesterday|recent\\w*|lately|happened|agents?|' +
    'negotiat\\w*|assets?|tokens?|coins?|portfolio|risk\\w*|strateg\\w*|hold\\w*|worth|value|usdt|pepe|btc|' +
    'bitcoin|dollars?|analy[sz]\\w*|summar\\w*|overview|doing|mov\\w*|safe\\w*|earn\\w*|profit\\w*|loss\\w*|lost)\\b',
  'i',
)
const ABOUT_VAULT = /\b(vault|idle|safe\w*|mov\w*|protect\w*)\b/i
const ABOUT_WEEK = /\b(week\w*|today|yesterday|recent\w*|lately|happened|last \w+ days)\b/i

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

function join(clauses: string[]): string {
  return clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1]}`
}

/** What moved in the last 7 days: settled swaps per asset pair, Vault moves, RGB receives, negotiations held. */
export function weekSignals(wallet: WalletState, sessions: OwnSession[], market: Market, now: number): AdviceSignal[] {
  const since = now - WEEK_DAYS * DAY
  const pegged = new Set(market.assets.filter((a) => a.source === 'fixed_peg').map((a) => a.asset_id))
  const recent = wallet.activity.filter((item) => item.t >= since)

  const swaps = new Map<string, Partial<Record<ActivityItem['direction'], ActivityItem>>>()
  for (const item of recent) {
    if (item.kind !== 'swap') continue
    const key = item.session_id ?? item.txid ?? item.id
    swaps.set(key, { ...swaps.get(key), [item.direction]: item })
  }
  const pairs = new Map<string, { out: AssetRef; in: AssetRef; paid: number; got: number; deals: number }>()
  for (const legs of swaps.values()) {
    if (!legs.in || !legs.out) continue
    const key = `${legs.out.asset.asset_id}:${legs.in.asset.asset_id}`
    const pair = pairs.get(key) ?? { out: legs.out.asset, in: legs.in.asset, paid: 0, got: 0, deals: 0 }
    pairs.set(key, { ...pair, paid: pair.paid + legs.out.amount, got: pair.got + legs.in.amount, deals: pair.deals + 1 })
  }

  const signals: AdviceSignal[] = []
  for (const [key, pair] of pairs) {
    const paid = units(pair.paid, pair.out.precision)
    const got = units(pair.got, pair.in.precision)
    const paidText = `${fmt(paid)} ${pair.out.ticker}`
    const gotText = `${fmt(got)} ${pair.in.ticker}`
    const title = pegged.has(pair.out.asset_id)
      ? `Bought ${gotText} for ${paidText}`
      : pegged.has(pair.in.asset_id)
        ? `Sold ${paidText} for ${gotText}`
        : `Swapped ${paidText} for ${gotText}`
    signals.push(
      signal('activity', `swap:${key}`, 'info', title, `${plural(pair.deals, 'deal')} settled in the last ${WEEK_DAYS} days.`, {
        paid_amount: paid,
        received_amount: got,
        deals: pair.deals,
        window_days: WEEK_DAYS,
      }),
    )
  }

  const moved = new Map<string, { kind: string; direction: string; asset: AssetRef; amount: number; count: number }>()
  for (const item of recent) {
    // BTC only funds the network fees.
    if (item.asset.asset_id === 'btc') continue
    if (item.kind !== 'vault' && !(item.kind === 'receive' && item.direction === 'in')) continue
    const key = `${item.kind}_${item.direction}:${item.asset.asset_id}`
    const entry = moved.get(key) ?? { kind: item.kind, direction: item.direction, asset: item.asset, amount: 0, count: 0 }
    moved.set(key, { ...entry, amount: entry.amount + item.amount, count: entry.count + 1 })
  }
  for (const [key, entry] of moved) {
    const amount = units(entry.amount, entry.asset.precision)
    const text = `${fmt(amount)} ${entry.asset.ticker}`
    const [title, detail] =
      entry.kind === 'vault' && entry.direction === 'out'
        ? [`Moved ${text} to your Vault`, "Your agents can't touch it there."]
        : entry.kind === 'vault'
          ? [`Moved ${text} back from your Vault`, 'Your agents can trade with it again.']
          : [`Received ${text}`, `${plural(entry.count, 'transfer')} in.`]
    signals.push(signal('activity', key, 'info', title, detail, { amount, count: entry.count, window_days: WEEK_DAYS }))
  }

  const held = sessions.filter((s) => (s.updated_at || s.created_at || 0) >= since)
  if (held.length > 0) {
    const deals = held.filter((s) => s.agreed_price_usd !== null).length
    signals.push(
      signal('activity', 'negotiations', 'info', `Negotiated ${plural(held.length, 'time')}`, deals ? `${deals} ended in a deal.` : 'None ended in a deal yet.', {
        negotiations: held.length,
        deals,
        window_days: WEEK_DAYS,
      }),
    )
  }
  return signals.slice(0, MAX_FACTS)
}

export function weekText(signals: AdviceSignal[]): string {
  if (signals.length === 0) return NOTHING_THIS_WEEK
  return `In the last ${WEEK_DAYS} days you ${join(signals.map((s) => s.title[0].toLowerCase() + s.title.slice(1)))}.`
}

export function vaultText(signals: AdviceSignal[]): string {
  if (signals.length === 0) return NO_IDLE_FUNDS
  const [top] = signals
  return `Yes, part of it. ${top.title}, ${top.numbers.share_pct}% of your wallet: your Vault keeps it where agents can't touch it.`
}

/** The rules answer to a preset or a free question, as the backend gives it without its model. */
export function computeAnswer(wallet: WalletState, sessions: OwnSession[], market: Market, body: AskRequest, now: number): AskView {
  const question = (body.question ?? '').split(/\s+/).filter(Boolean).join(' ')
  if (!body.preset && !ON_TOPIC.test(question)) {
    return { answer: OFF_TOPIC, generated_by: 'rules', signals: [], action: null, note: null }
  }
  const topic = body.preset ?? (ABOUT_VAULT.test(question) ? 'vault' : ABOUT_WEEK.test(question) ? 'week' : 'analyze')
  const advice = computeSignals(wallet, sessions, market, now)
  const idle = advice.filter((s) => s.kind === 'idle_funds')
  const shown = topic === 'analyze' ? advice : topic === 'week' ? weekSignals(wallet, sessions, market, now) : idle
  const answer = topic === 'analyze' ? templateSummary(shown) : topic === 'week' ? weekText(shown) : vaultText(shown)
  const action = idle.length > 0 && topic !== 'week' ? 'move_to_vault' : null
  return { answer, generated_by: 'rules', signals: shown, action, note: null }
}
