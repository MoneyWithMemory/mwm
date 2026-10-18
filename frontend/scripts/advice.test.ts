// The mock advisor (src/api/mock/advice.ts) against the backend's numbers and copy
// (backend/tests/test_advisor.py): same data, same signals.
// Run with `node --import ./scripts/node-alias.mjs --test 'scripts/*.test.ts'`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActivityItem, AssetBalance, AssetRef, Market, SessionState, WalletState } from '../src/api/types.ts'
import { computeAdvice, computeSignals, templateSummary, type OwnSession } from '../src/api/mock/advice.ts'

const NOW = 1_800_000_000
const DAY = 86_400
const USDT: AssetRef = { asset_id: 'rgb:usdt', ticker: 'USDT', schema: 'NIA', precision: 0 }
const PEPE: AssetRef = { asset_id: 'rgb:pepe', ticker: 'PEPE', schema: 'NIA', precision: 0 }
const TRUST = { trusted: true, sybil_ring_detected: false, reliability_pct: 92, trust_tier: 'High Authenticity' as const, assessment_summary: '' }
const STRICT = 'Strict: open low and raise only in small steps, and only after the seller moves.'
const FLEXIBLE = 'Flexible: closing matters more than the last dollar. Raise in larger steps toward a reasonable seller.'

function market(pepePrice: number | null = null): Market {
  return {
    mode: 'fixed_simulated',
    sats_per_usd: 1000,
    assets: [
      { asset_id: USDT.asset_id, ticker: 'USDT', precision: 0, price_usd: 1, source: 'fixed_peg' },
      { asset_id: PEPE.asset_id, ticker: 'PEPE', precision: 0, price_usd: pepePrice, source: 'p2p_negotiation' },
    ],
  }
}

function wallet({ btc = 0, usdt = 0, pepe = 0, activity = [] as ActivityItem[], buyerPrompt = '' } = {}): WalletState {
  const assets: AssetBalance[] = [{ asset_id: 'btc', ticker: 'BTC', schema: 'BTC', precision: 8, amount: btc }]
  if (usdt) assets.push({ ...USDT, amount: usdt })
  if (pepe) assets.push({ ...PEPE, amount: pepe })
  return {
    wallet_id: 'wallet_a',
    label: 'Wallet A',
    address: 'bcrt1qowner',
    assets,
    avg_cost_basis: {},
    history_points: [],
    activity,
    local_aliases: {},
    agent_profile: {
      seller_active: false,
      offered_asset_id: null,
      offered_amount: 0,
      asking_price_usd: 0,
      secret_min_reserve_usd: 113,
      seller_ai_prompt: '',
      allow_partial: false,
      buyer_max_ceiling_usd: 137,
      buyer_target_usd: 121,
      buyer_ai_prompt: buyerPrompt,
    },
  }
}

function swap(asset: AssetRef, amount: number, direction: 'in' | 'out', daysAgo: number): ActivityItem {
  return { id: `${asset.ticker}-${daysAgo}`, t: NOW - daysAgo * DAY, kind: 'swap', direction, asset, amount, counterparty_address: null, txid: null, session_id: null, status: 'confirmed' }
}

/** A SessionView as its owner sees it, with the strategy the owner gave their agent in it. */
function session(
  role: 'buyer' | 'seller',
  state: SessionState,
  { agreed = null as number | null, ask = 150, rounds = 4, amount = 1_000_000, prompt = '' } = {},
): OwnSession {
  return {
    session_id: `sess_${role}_${state}_${rounds}`,
    state,
    my_role: role,
    counterparty_address: 'bcrt1qother',
    asset: PEPE,
    rgb_amount: amount,
    agreed_price_usd: agreed,
    created_at: NOW,
    updated_at: NOW,
    payment_asset: USDT,
    counterparty_trust: TRUST,
    rounds: Array.from({ length: rounds }, (_, i) => ({
      n: i + 1, buyer_offer_usd: null, seller_offer_usd: null, buyer_action: null, seller_action: null, my_private_thought: null, public_messages: { buyer: null, seller: null },
    })),
    thinking: null,
    gate: null,
    terms: null,
    terms_hash: null,
    buyer_signed: false,
    seller_signed: false,
    settlement_steps: [],
    txid: null,
    failure: null,
    list_price_usd: ask,
    my_ai_prompt: prompt,
  }
}

const kinds = (signals: { kind: string }[]) => signals.map((s) => s.kind)

test('an empty wallet has no signals', () => {
  assert.deepEqual(computeSignals(wallet(), [], market(), NOW), [])
  assert.equal(templateSummary([]), 'Nothing needs your attention right now.')
})

test('negotiation savings compare settled deals with the public list price', () => {
  const sessions = [
    session('buyer', 'SETTLED', { agreed: 123 }),
    session('buyer', 'AWAITING_SIGNATURES', { agreed: 120 }),
    session('seller', 'SETTLED', { agreed: 130 }),
    session('seller', 'SETTLED', { agreed: 140, rounds: 5 }),
  ]
  const [buy, sell] = computeSignals(wallet(), sessions, market(), NOW)
  assert.equal(buy.id, 'negotiation_savings:buyer')
  assert.equal(buy.title, 'Paid 18% below the list price')
  assert.equal(buy.detail, '$123 for 1,000,000 PEPE, listed at $150.')
  assert.deepEqual(buy.numbers, { paid_usd: 123, ask_usd: 150, saved_usd: 27, pct_below: 18, deals: 1, amount: 1_000_000 })
  assert.equal(sell.title, 'Sold 10% below your asking price')
  assert.equal(sell.detail, '$270 for $300 listed, over 2 sales.')
  const [full] = computeSignals(wallet(), [session('buyer', 'SETTLED', { agreed: 150 })], market(), NOW)
  assert.equal(full.title, 'Paid the full list price')
})

test('idle funds quote the balance that trades barely used', () => {
  const [tip] = computeSignals(wallet({ btc: 1_000_000, usdt: 10_000 }), [], market(), NOW)
  assert.equal(tip.id, 'idle_funds:rgb:usdt')
  assert.equal(tip.severity, 'tip')
  assert.equal(tip.title, '10,000 USDT sits idle')
  assert.equal(tip.detail, "91% of your wallet. Move part to your Vault, where agents can't touch it.")
  assert.deepEqual(tip.numbers, { idle_amount: 10_000, share_pct: 91, spent_amount: 0, window_days: 7 })

  // The balance's own amount and share, as Assets and Allocation show them; older trades do not count.
  const week = wallet({ btc: 1_000_000, usdt: 9_000, activity: [swap(USDT, 1_000, 'out', 2), swap(USDT, 5_000, 'out', 30)] })
  const [busyWeek] = computeSignals(week, [], market(), NOW)
  assert.equal(busyWeek.title, '9,000 USDT sits idle')
  assert.deepEqual(busyWeek.numbers, { idle_amount: 9_000, share_pct: 90, spent_amount: 1_000, window_days: 7 })
  // Trades spent more than a quarter of it this week: the agents keep it busy.
  assert.deepEqual(computeSignals(wallet({ btc: 1_000_000, usdt: 6_000, activity: [swap(USDT, 2_001, 'out', 2)] }), [], market(), NOW), [])
  assert.deepEqual(computeSignals(wallet({ btc: 1_000_000, usdt: 500 }), [], market(), NOW), [])
})

test('concentration warns on an asset whose price can move, not on BTC or a USD peg', () => {
  const signals = computeSignals(wallet({ usdt: 1_800, pepe: 8_200_000, activity: [swap(USDT, 1_800, 'out', 1)] }), [], market(0.001), NOW)
  assert.deepEqual(kinds(signals), ['concentration', 'idle_funds'])
  assert.equal(signals[0].title, '82% of your wallet is PEPE')
  assert.equal(signals[0].detail, "If its price drops, most of your wallet's value drops with it.")
  assert.deepEqual(signals[0].numbers, { share_pct: 82, value_usd: 8_200 })
  assert.deepEqual(computeSignals(wallet({ btc: 9_000_000, usdt: 150 }), [], market(), NOW), [])
  assert.deepEqual(kinds(computeSignals(wallet({ btc: 1_000_000, usdt: 10_000 }), [], market(), NOW)), ['idle_funds'])
  assert.deepEqual(computeSignals(wallet({ btc: 200_000, pepe: 1_000_000 }), [], market(null), NOW), [])
})

test('pace needs history and names the strategy', () => {
  assert.deepEqual(kinds(computeSignals(wallet(), [session('buyer', 'SETTLED', { agreed: 123 })], market(), NOW)), ['negotiation_savings'])

  const two = [session('buyer', 'SETTLED', { agreed: 123 }), session('buyer', 'AWAITING_SIGNATURES', { agreed: 125, rounds: 6 })]
  const steady = computeSignals(wallet(), two, market(), NOW).find((s) => s.kind === 'pace')
  assert.equal(steady?.title, 'Agreed in 2 of 2 negotiations')
  assert.equal(steady?.detail, 'Balanced buying strategy, about 5 rounds per deal.')

  const stalled = [
    session('buyer', 'SETTLED', { agreed: 123, prompt: STRICT }),
    session('buyer', 'BLOCKED_BY_GATE', { rounds: 10, prompt: STRICT }),
    session('buyer', 'BLOCKED_BY_GATE', { rounds: 3, prompt: STRICT }),
    session('buyer', 'BLOCKED_BY_GATE', { rounds: 0, prompt: FLEXIBLE }),
    session('buyer', 'CANCELLED_BY_USER', { rounds: 2, prompt: FLEXIBLE }),
  ]
  const tip = computeSignals(wallet(), stalled, market(), NOW).find((s) => s.kind === 'pace')
  assert.equal(tip?.severity, 'tip')
  assert.equal(tip?.title, 'Agreed in 1 of 3 negotiations')
  assert.equal(tip?.detail, 'Strict buying strategy: 2 ended with no deal. Flexible may close more.')
  assert.deepEqual(tip?.numbers, { negotiations: 3, deals: 1, no_deals: 2, avg_rounds: 4 })

  const ownWords = 'Hold firm on Fridays.'
  const seller = [session('seller', 'BLOCKED_BY_GATE', { rounds: 5, prompt: ownWords }), session('seller', 'BLOCKED_BY_GATE', { rounds: 7, prompt: ownWords })]
  const [none] = computeSignals(wallet(), seller, market(), NOW)
  assert.equal(none.title, 'No deal in 2 negotiations')
  assert.equal(none.detail, 'Your own selling strategy: 2 ended with no deal. Flexible may close more.')
  assert.equal(templateSummary([none]), 'Your agent made no deal in 2 negotiations.')
})

test('pace reads the strategy each negotiation ran with, not the profile', () => {
  const flexible = Array.from({ length: 2 }, () => session('buyer', 'BLOCKED_BY_GATE', { rounds: 3, prompt: FLEXIBLE }))
  assert.equal(computeSignals(wallet({ buyerPrompt: STRICT }), flexible, market(), NOW)[0].detail, 'Flexible buying strategy: 2 ended with no deal.')
  const mixed = [session('buyer', 'BLOCKED_BY_GATE', { rounds: 3, prompt: STRICT }), session('buyer', 'BLOCKED_BY_GATE', { rounds: 4 })]
  assert.equal(computeSignals(wallet(), mixed, market(), NOW)[0].detail, 'As a buyer: 2 ended with no deal. Flexible may close more.')
  mixed[1] = session('buyer', 'BLOCKED_BY_GATE', { rounds: 4, prompt: FLEXIBLE })
  assert.equal(computeSignals(wallet(), mixed, market(), NOW)[0].detail, 'As a buyer: 2 ended with no deal.')
  const sales = [session('seller', 'SETTLED', { agreed: 140, rounds: 2, prompt: STRICT }), session('seller', 'SETTLED', { agreed: 130, rounds: 4 })]
  assert.equal(computeSignals(wallet(), sales, market(), NOW).find((s) => s.kind === 'pace')?.detail, 'As a seller, about 3 rounds per deal.')
})

test('signals are short, most severe first and at most four', () => {
  const sessions = [
    ...Array.from({ length: 3 }, () => session('buyer', 'SETTLED', { agreed: 90_000, ask: 1_234_567, amount: 987_654_321 })),
    ...Array.from({ length: 2 }, () => session('seller', 'SETTLED', { agreed: 100 })),
    ...Array.from({ length: 3 }, () => session('seller', 'BLOCKED_BY_GATE', { rounds: 9 })),
  ]
  const signals = computeSignals(wallet({ btc: 1_000_000, usdt: 9_999_999, pepe: 987_654_321 }), sessions, market(0.5), NOW)
  assert.equal(signals.length, 4)
  const rank = { warning: 0, tip: 1, info: 2 }
  assert.deepEqual(signals.map((s) => rank[s.severity]), signals.map((s) => rank[s.severity]).sort())
  for (const s of signals) assert.ok(s.title.length <= 40 && s.detail.length <= 90, s.title)
})

test('the advice carries the rules summary of the top two signals', () => {
  const advice = computeAdvice('wallet_a', wallet({ btc: 1_000_000, usdt: 10_000 }), [session('buyer', 'SETTLED', { agreed: 123 })], market(), NOW)
  assert.equal(advice.generated_by, 'rules')
  assert.equal(advice.phrasing, false)
  assert.equal(advice.summary, '10,000 USDT sits idle, and your agent paid 18% below the list price.')
  const sales = [session('seller', 'SETTLED', { agreed: 135 }), session('seller', 'CANCELLED_BY_USER', { agreed: 140 })]
  assert.equal(templateSummary(computeSignals(wallet(), sales, market(), NOW)), 'Your agent sold 10% below your asking price, and agreed in 2 of 2 negotiations.')
  // Nothing secret reaches it: the owner's own limits (137, 121, 113) are in its profile, not in its advice.
  assert.doesNotMatch(JSON.stringify({ ...advice, generated_at: 0 }), /\b(137|121|113)\b/)
})
