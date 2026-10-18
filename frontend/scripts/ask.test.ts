// The mock "Your AI" (src/api/mock/ask.ts) against the backend's rules answers
// (backend/tests/test_assistant.py): same data, same facts and copy.
// Run with `node --import ./scripts/node-alias.mjs --test 'scripts/*.test.ts'`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ActivityItem, AssetBalance, AssetRef, Market, WalletState } from '../src/api/types.ts'
import { computeAnswer, OFF_TOPIC, weekSignals } from '../src/api/mock/ask.ts'

const NOW = 1_800_000_000
const DAY = 86_400
const BTC: AssetRef = { asset_id: 'btc', ticker: 'BTC', schema: 'BTC', precision: 8 }
const USDT: AssetRef = { asset_id: 'rgb:usdt', ticker: 'USDT', schema: 'NIA', precision: 0 }
const PEPE: AssetRef = { asset_id: 'rgb:pepe', ticker: 'PEPE', schema: 'NIA', precision: 0 }

const market: Market = {
  mode: 'fixed_simulated',
  sats_per_usd: 1000,
  assets: [
    { asset_id: USDT.asset_id, ticker: 'USDT', precision: 0, price_usd: 1, source: 'fixed_peg' },
    { asset_id: PEPE.asset_id, ticker: 'PEPE', precision: 0, price_usd: 0.0001, source: 'p2p_negotiation' },
  ],
}

function item(id: string, kind: ActivityItem['kind'], direction: ActivityItem['direction'], asset: AssetRef, amount: number, daysAgo: number, sessionId: string | null = null): ActivityItem {
  return { id, t: NOW - daysAgo * DAY, kind, direction, asset, amount, counterparty_address: null, txid: null, session_id: sessionId, status: 'confirmed' }
}

function wallet(usdt: number, pepe = 0, activity: ActivityItem[] = []): WalletState {
  const assets: AssetBalance[] = [{ ...BTC, amount: 1_000_000 }, { ...USDT, amount: usdt }]
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
      secret_min_reserve_usd: 0,
      seller_ai_prompt: '',
      allow_partial: false,
      buyer_max_ceiling_usd: 0,
      buyer_target_usd: 0,
      buyer_ai_prompt: '',
    },
  }
}

test('analyze and vault answer from the idle funds, with the move action', () => {
  const analyze = computeAnswer(wallet(10_000), [], market, { preset: 'analyze' }, NOW)
  assert.equal(analyze.answer, '10,000 USDT sits idle.')
  assert.equal(analyze.action, 'move_to_vault')
  const vault = computeAnswer(wallet(10_000), [], market, { preset: 'vault' }, NOW)
  assert.equal(vault.answer, "Yes, part of it. 10,000 USDT sits idle, 91% of your wallet: your Vault keeps it where agents can't touch it.")
})

test('week lists swaps per pair and Vault moves, never BTC', () => {
  const activity = [
    item('1o', 'swap', 'out', USDT, 124, 1, 's1'),
    item('1i', 'swap', 'in', PEPE, 1_000_000, 1, 's1'),
    item('2o', 'swap', 'out', USDT, 100, 2, 's2'),
    item('2i', 'swap', 'in', PEPE, 500_000, 2, 's2'),
    item('old', 'swap', 'out', USDT, 99, 9, 'old'),
    item('v', 'vault', 'out', USDT, 500, 0),
    item('r', 'receive', 'in', BTC, 50_000, 0),
  ]
  const state = wallet(9_276, 1_500_000, activity)
  assert.deepEqual(
    weekSignals(state, [], market, NOW).map((s) => s.title),
    ['Bought 1,500,000 PEPE for 224 USDT', 'Moved 500 USDT to your Vault'],
  )
  const week = computeAnswer(state, [], market, { preset: 'week' }, NOW)
  assert.equal(week.answer, 'In the last 7 days you bought 1,500,000 PEPE for 224 USDT and moved 500 USDT to your Vault.')
  assert.equal(week.action, null)
  assert.equal(computeAnswer(wallet(10_000), [], market, { preset: 'week' }, NOW).answer, 'Nothing moved in the last 7 days.')
})

test('free questions route by topic; off-topic ones get the fixed reply', () => {
  assert.equal(computeAnswer(wallet(10_000), [], market, { question: 'Is my money safe?' }, NOW).action, 'move_to_vault')
  assert.equal(computeAnswer(wallet(10_000), [], market, { question: 'What happened lately?' }, NOW).answer, 'Nothing moved in the last 7 days.')
  const off = computeAnswer(wallet(10_000), [], market, { question: "What's the weather in Turin?" }, NOW)
  assert.deepEqual([off.answer, off.signals.length, off.action], [OFF_TOPIC, 0, null])
})
