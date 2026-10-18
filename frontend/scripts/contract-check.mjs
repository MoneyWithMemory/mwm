#!/usr/bin/env node
// Contract check: runs the frontend's API contract (src/api/types.ts, API_CONTRACT.md)
// against a live backend, and changes no reliability score. It writes three short sessions:
// one blocked by the gate, one cancelled before any agreement, and one agreed and left
// unsigned, a deal in progress of Wallet A and Wallet B until it expires 600 s later without
// a walk-away (unless someone signs one side of it in the UI). Cancelling agreed terms would
// be a walk-away, saved for good in that wallet's score, so the check never does it.
// --e2e instead signs both sides and waits for the on-chain settlement, which moves
// regtest balances and sets the PEPE market price.
//
//   node scripts/contract-check.mjs [http://<backend>:8000] [--e2e]
//
// Needs Node 23.6+ (imports the TypeScript contract directly). Exit code 1 on any FAIL.

import { createHash } from 'node:crypto'
import { canonicalJson } from '../src/api/mock/sha256.ts'
import { MAX_ROUNDS, SETTLEMENT_STEPS } from '../src/api/types.ts'

const args = process.argv.slice(2)
const E2E = args.includes('--e2e')
const ORIGIN = (args.find((a) => !a.startsWith('--')) ?? process.env.API_TARGET ?? 'http://127.0.0.1:8000').replace(/\/$/, '')
const API = `${ORIGIN}/api`

const WALLET_IDS = { a: 'wallet_a', b: 'wallet_b', sybil: 'wallet_sybil' }
const SECRET_KEYS = /"(secret_min_reserve_usd|seller_ai_prompt|buyer_max_ceiling_usd|buyer_target_usd|buyer_ai_prompt|agent_profile)"/
const LOOP_WORDING = /loop|\d+\s*%|\btrades?\b.*\d/i

// ── Reporting ──────────────────────────────────────────────────────

let failed = 0
let warned = 0

function section(title) {
  console.log(`\n${title}`)
}

function check(cond, label, detail) {
  if (cond) console.log(`  PASS  ${label}`)
  else {
    failed += 1
    console.log(`  FAIL  ${label}${detail ? ` → ${detail}` : ''}`)
  }
  return cond
}

function warn(cond, label, detail) {
  if (!cond) {
    warned += 1
    console.log(`  WARN  ${label}${detail ? ` → ${detail}` : ''}`)
  }
  return cond
}

// ── HTTP ───────────────────────────────────────────────────────────

async function call(method, path, body, timeoutMs = 15_000) {
  const res = await fetch(API + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let data = text
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    // keep the raw text for the report
  }
  return { status: res.status, data }
}

const get = (path) => call('GET', path)
const post = (path, body, timeoutMs) => call('POST', path, body, timeoutMs)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// ── Shapes (mirror src/api/types.ts) ───────────────────────────────

const isInt = Number.isInteger
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isStr = (v) => typeof v === 'string'
const isBool = (v) => typeof v === 'boolean'
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const nullable = (test) => (v) => v === null || test(v)
const oneOf = (...values) => (v) => values.includes(v)
const listOf = (test) => (v) => Array.isArray(v) && v.every(test)
/** A nested spec that may also be null. */
const maybe = (spec) => Object.assign((v) => v === null, { spec })

/** Problems found in obj against spec: {key: predicate | nested spec | maybe(spec)}. */
function shape(obj, spec, path = '') {
  if (!isObj(obj)) return [`${path || 'value'} is not an object`]
  const problems = []
  for (const [key, test] of Object.entries(spec)) {
    const p = path ? `${path}.${key}` : key
    const value = obj[key]
    if (!(key in obj)) problems.push(`${p} missing`)
    else if (typeof test === 'function' && test.spec) {
      if (value !== null) problems.push(...shape(value, test.spec, p))
    } else if (typeof test === 'function') {
      if (!test(value)) problems.push(`${p} = ${JSON.stringify(value)?.slice(0, 80)}`)
    } else problems.push(...shape(value, test, p))
  }
  return problems
}

function checkShape(obj, spec, label) {
  const problems = shape(obj, spec)
  return check(problems.length === 0, label, problems.slice(0, 4).join('; '))
}

const STATES = ['NEGOTIATING', 'AWAITING_SIGNATURES', 'SETTLING', 'SETTLED', 'CANCELLED_BY_USER', 'BLOCKED_BY_GATE', 'FAILED', 'EXPIRED']
const TRUST_TIERS = ['High Authenticity', 'Low Reliability', 'Ring Anomaly Detected', 'Unverified']
const ROLE = oneOf('buyer', 'seller')
const ACTION = nullable(oneOf('OFFER', 'ACCEPT'))

const ERROR = { code: isStr, message: isStr }
const HEALTH = { regtest: isBool, qvac: isBool, proxy: isBool }
const ASSET_REF = { asset_id: isStr, ticker: isStr, schema: oneOf('NIA', 'UDA', 'CFA', 'IFA', 'BTC'), precision: isInt }
const ASSET_BALANCE = { ...ASSET_REF, amount: isInt }
const MARKET_ASSET = { asset_id: isStr, ticker: isStr, precision: isInt, price_usd: nullable(isNum), source: oneOf('fixed_peg', 'p2p_negotiation') }
const MARKET = { mode: oneOf('fixed_simulated'), sats_per_usd: isNum, assets: Array.isArray }
const WALLET_SUMMARY = { wallet_id: isStr, label: isStr, address: (v) => isStr(v) && v.startsWith('bcrt1') }
const PROFILE = {
  seller_active: isBool,
  offered_asset_id: nullable(isStr),
  offered_amount: isInt,
  asking_price_usd: isNum,
  secret_min_reserve_usd: isNum,
  seller_ai_prompt: isStr,
  allow_partial: isBool,
  buyer_max_ceiling_usd: isNum,
  buyer_target_usd: isNum,
  buyer_ai_prompt: isStr,
}
const HISTORY_POINT = { t: isInt, balances: isObj, total_usd: isNum }
const ACTIVITY = {
  id: isStr,
  t: isInt,
  kind: oneOf('swap', 'receive', 'issue', 'vault'),
  direction: oneOf('in', 'out'),
  asset: ASSET_REF,
  amount: isInt,
  counterparty_address: nullable(isStr),
  txid: nullable(isStr),
  session_id: nullable(isStr),
  status: oneOf('pending', 'confirmed'),
}
const TRUST = {
  trusted: isBool,
  sybil_ring_detected: isBool,
  reliability_pct: nullable(isNum),
  trust_tier: oneOf(...TRUST_TIERS),
  assessment_summary: isStr,
}
const WALLET_STATE = {
  ...WALLET_SUMMARY,
  assets: Array.isArray,
  avg_cost_basis: isObj,
  history_points: Array.isArray,
  activity: Array.isArray,
  local_aliases: isObj,
  agent_profile: PROFILE,
  trust: TRUST,
}
const DESK = { asset: ASSET_REF, offered_amount: isInt, asking_price_usd: isNum, allow_partial: isBool }
const CONTACT = { address: isStr, alias: nullable(isStr), trust: TRUST, desk: maybe(DESK) }
const ADVICE_SIGNAL = {
  id: isStr,
  kind: oneOf('negotiation_savings', 'idle_funds', 'concentration', 'pace', 'activity'),
  severity: oneOf('info', 'tip', 'warning'),
  title: (v) => isStr(v) && v.length <= 40,
  detail: (v) => isStr(v) && v.length <= 90,
  numbers: (v) => isObj(v) && Object.values(v).every(isNum),
}
const ADVICE = {
  wallet_id: isStr,
  generated_at: isInt,
  generated_by: oneOf('qvac', 'rules'),
  phrasing: isBool,
  summary: (v) => isStr(v) && v.length > 0,
  signals: (v) => Array.isArray(v) && v.length <= 4,
}
const ASK = {
  answer: (v) => isStr(v) && v.length > 0,
  generated_by: oneOf('qvac', 'rules'),
  signals: (v) => Array.isArray(v) && v.length <= 4,
  action: (v) => v === null || v === 'move_to_vault',
  note: (v) => v === null || isStr(v),
}
const ROUND = {
  n: isInt,
  buyer_offer_usd: nullable(isNum),
  seller_offer_usd: nullable(isNum),
  buyer_action: ACTION,
  seller_action: ACTION,
  my_private_thought: nullable(isStr),
  public_messages: { buyer: nullable(isStr), seller: nullable(isStr) },
}
const GATE = { passed: isBool, trust_tier: oneOf(...TRUST_TIERS), reasons: listOf(isStr) }
const TERMS = {
  session_id: isStr,
  asset_id: isStr,
  rgb_amount: isInt,
  payment_asset_id: isStr,
  payment_amount: isInt,
  agreed_price_usd: isNum,
  network_fee_sat: isInt,
  buyer_address: isStr,
  seller_address: isStr,
  expiry_unix: isInt,
}
const STEP = { index: isInt, name: oneOf(...SETTLEMENT_STEPS.map((s) => s.name)), status: oneOf('pending', 'running', 'done', 'failed') }
const SESSION_VIEW = {
  session_id: isStr,
  state: oneOf(...STATES),
  my_role: ROLE,
  counterparty_address: isStr,
  asset: ASSET_REF,
  rgb_amount: isInt,
  agreed_price_usd: nullable(isNum),
  created_at: isInt,
  updated_at: isInt,
  payment_asset: ASSET_REF,
  counterparty_trust: TRUST,
  rounds: Array.isArray,
  thinking: nullable(ROLE),
  gate: maybe(GATE),
  terms: maybe(TERMS),
  terms_hash: nullable(isStr),
  buyer_signed: isBool,
  seller_signed: isBool,
  settlement_steps: Array.isArray,
  txid: nullable(isStr),
  failure: maybe(ERROR),
}

const amountOf = (wallet, assetId) => wallet.assets.find((a) => a.asset_id === assetId)?.amount ?? 0
const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function expectError(res, status, code, label) {
  return check(res.status === status && res.data?.code === code && isStr(res.data?.message), label, `${res.status} ${JSON.stringify(res.data)?.slice(0, 120)}`)
}

/** Polls the session until its state leaves `from`, printing every change. */
async function waitWhile(sessionId, walletId, from, timeoutMs) {
  const started = Date.now()
  let last = ''
  let view = null
  while (Date.now() - started < timeoutMs) {
    view = (await get(`/sessions/${sessionId}?wallet_id=${walletId}`)).data
    const steps = view.settlement_steps?.map((s) => s.status[0]).join('') ?? ''
    const line = `${view.state} thinking=${view.thinking} rounds=${view.rounds?.length} steps=${steps}`
    if (line !== last) console.log(`        ${((Date.now() - started) / 1000).toFixed(1).padStart(5)}s  ${line}`)
    last = line
    if (!from.includes(view.state)) break
    await sleep(1500)
  }
  return { view, seconds: (Date.now() - started) / 1000 }
}

// ── Checks ─────────────────────────────────────────────────────────

async function main() {
  console.log(`Contract check against ${API}${E2E ? ' (with E2E settlement)' : ''}`)

  section('Health')
  const health = await get('/health')
  checkShape(health.data, HEALTH, 'GET /health shape')
  warn(health.data?.regtest && health.data?.qvac && health.data?.proxy, 'all dependencies up', JSON.stringify(health.data))

  section('Market')
  const market = (await get('/market')).data
  checkShape(market, MARKET, 'GET /market shape')
  for (const asset of market.assets) checkShape(asset, MARKET_ASSET, `market asset ${asset.ticker} shape (precision included)`)
  const usdt = market.assets.find((a) => a.ticker === 'USDT')
  const pepe = market.assets.find((a) => a.ticker === 'PEPE')
  check(usdt?.source === 'fixed_peg' && usdt?.price_usd === 1, 'USDT is fixed_peg at 1.00')
  check(pepe?.source === 'p2p_negotiation', 'PEPE price comes from p2p_negotiation', `price_usd=${pepe?.price_usd}`)
  const marketIds = new Set(['btc', ...market.assets.map((a) => a.asset_id)])

  section('Wallets')
  const list = (await get('/wallets')).data
  check(Array.isArray(list) && list.every((w) => shape(w, WALLET_SUMMARY).length === 0), 'GET /wallets items are WalletSummary')
  check(Object.values(WALLET_IDS).every((id) => list.some((w) => w.wallet_id === id)), 'seeded wallet_a, wallet_b, wallet_sybil')
  const wallets = {}
  for (const [key, id] of Object.entries(WALLET_IDS)) {
    const w = (await get(`/wallets/${id}`)).data
    wallets[key] = w
    checkShape(w, WALLET_STATE, `${id} WalletState shape`)
    const assetProblems = w.assets.flatMap((a) => shape(a, ASSET_BALANCE).map((p) => `${a.ticker}: ${p}`))
    check(assetProblems.length === 0, `${id} assets are AssetBalance (schema, not schema_type)`, assetProblems.slice(0, 3).join('; '))
    check(w.assets.some((a) => a.asset_id === 'btc' && a.precision === 8), `${id} includes the btc pseudo-asset (precision 8)`)
    const tickers = w.assets.map((a) => a.ticker)
    check(new Set(tickers).size === tickers.length, `${id} has no duplicate assets`, tickers.join(', '))
    const stray = w.assets.filter((a) => !marketIds.has(a.asset_id)).map((a) => `${a.ticker} ${a.asset_id}`)
    check(stray.length === 0, `${id} holds only demo assets`, stray.join(', '))
    const costKeys = Object.keys(w.avg_cost_basis).filter((k) => !marketIds.has(k))
    check(costKeys.length === 0, `${id} avg_cost_basis keyed by asset_id`, costKeys.join(', '))
    const historyKeys = w.history_points.flatMap((p) => Object.keys(p.balances)).filter((k) => !marketIds.has(k))
    check(w.history_points.length > 0 && w.history_points.every((p) => shape(p, HISTORY_POINT).length === 0) && historyKeys.length === 0, `${id} history_points keyed by asset_id`, [...new Set(historyKeys)].join(', '))
    check(w.activity.every((item) => shape(item, ACTIVITY).length === 0), `${id} activity items shape`, shape(w.activity.find((i) => shape(i, ACTIVITY).length) ?? {}, ACTIVITY).slice(0, 2).join('; '))
  }
  const deskProfile = wallets.b.agent_profile
  check(deskProfile.seller_active && deskProfile.offered_asset_id === pepe.asset_id, 'Wallet B desk sells the demo PEPE')
  // total_usd = BTC at sats_per_usd + USDT at 1.00 (+ PEPE only once it has a price).
  const valuedWithoutPepe = (p) => (p.balances.btc ?? 0) / market.sats_per_usd + (p.balances[usdt.asset_id] ?? 0) / 10 ** usdt.precision
  for (const w of Object.values(wallets)) {
    const off = w.history_points.filter((p) => (pepe.price_usd === null || !p.balances[pepe.asset_id]) && Math.abs(p.total_usd - valuedWithoutPepe(p)) > 0.01)
    check(off.length === 0, `${w.wallet_id} total_usd = BTC + USDT (+ PEPE once priced)`, off.slice(0, 2).map((p) => `t=${p.t} total ${p.total_usd} vs ${valuedWithoutPepe(p)}`).join('; '))
  }

  section('Contacts')
  const contacts = (await get(`/wallets/${WALLET_IDS.a}/contacts`)).data
  check(Array.isArray(contacts) && contacts.length > 0, 'GET /contacts returns a list')
  for (const c of contacts) checkShape(c, CONTACT, `contact ${c.alias ?? c.address.slice(0, 12)} shape (desk included)`)
  check(!contacts.some((c) => c.address === wallets.a.address), 'own address excluded')
  check(!SECRET_KEYS.test(JSON.stringify(contacts)), 'no secret fields in contacts')
  check(!contacts.some((c) => LOOP_WORDING.test(c.trust.assessment_summary)), 'no loop % or trade counts in assessment_summary')
  const contactB = contacts.find((c) => c.address === wallets.b.address)
  check(
    contactB?.desk?.asset.asset_id === deskProfile.offered_asset_id && contactB.desk.offered_amount === deskProfile.offered_amount && contactB.desk.asking_price_usd === deskProfile.asking_price_usd && contactB.desk.allow_partial === deskProfile.allow_partial,
    'Wallet B desk matches its public profile fields',
    JSON.stringify(contactB?.desk),
  )
  const contactSybil = contacts.find((c) => c.address === wallets.sybil.address)
  check(contactSybil?.trust.trust_tier === 'Ring Anomaly Detected' && contactSybil.trust.reliability_pct <= 20, 'Sybil is flagged as a ring, capped at 20%', `${contactSybil?.trust.reliability_pct}%`)
  warn(contactSybil?.desk !== null, 'Sybil shows a desk (trading with it needs consent)')

  section('Advisor')
  for (const [key, id] of Object.entries(WALLET_IDS)) {
    const advice = (await get(`/wallets/${id}/advice`)).data
    checkShape(advice, ADVICE, `${id} AdviceView shape`)
    const problems = (advice.signals ?? []).flatMap((s) => shape(s, ADVICE_SIGNAL).map((p) => `${s.id}: ${p}`))
    check(problems.length === 0, `${id} advice signals shape (title ≤ 40, detail ≤ 90)`, problems.slice(0, 3).join('; '))
    check(!SECRET_KEYS.test(JSON.stringify(advice)), `${id} advice has no secret fields`)
    const profile = wallets[key].agent_profile
    const text = [advice.summary, ...(advice.signals ?? []).flatMap((s) => [s.title, s.detail])].join(' ')
    // A deal may legitimately close at a limit (e.g. at the ceiling): its public prices are not a leak.
    const dealPrices = new Set((advice.signals ?? []).filter((s) => s.kind === 'negotiation_savings').flatMap((s) => Object.values(s.numbers)))
    const quoted = [profile.buyer_max_ceiling_usd, profile.secret_min_reserve_usd].filter((n) => n > 0 && !dealPrices.has(n) && new RegExp(`\\b${n}\\b`).test(text))
    warn(quoted.length === 0, `${id} advice does not quote its own secret limits`, quoted.join(', '))
    console.log(`        ${id}: ${advice.generated_by} · ${(advice.signals ?? []).map((s) => s.kind).join(', ') || 'no signals'} · "${advice.summary}"`)
  }
  expectError(await get('/wallets/does_not_exist/advice'), 404, 'wallet_not_found', 'advice for an unknown wallet → 404 wallet_not_found')

  section('Your AI')
  for (const preset of ['analyze', 'week', 'vault']) {
    const reply = (await post(`/wallets/${WALLET_IDS.a}/ask`, { preset }, 20_000)).data
    checkShape(reply, ASK, `ask ${preset}: AskView shape`)
    const problems = (reply.signals ?? []).flatMap((s) => shape(s, ADVICE_SIGNAL).map((p) => `${s.id}: ${p}`))
    check(problems.length === 0, `ask ${preset}: signals shape`, problems.slice(0, 3).join('; '))
    check(!SECRET_KEYS.test(JSON.stringify(reply)), `ask ${preset}: no secret fields`)
    console.log(`        ${preset}: ${reply.generated_by}${reply.note ? ` (${reply.note})` : ''} · "${reply.answer}"`)
  }
  const offTopic = (await post(`/wallets/${WALLET_IDS.a}/ask`, { question: "What's the weather in Turin?" })).data
  check(offTopic?.answer === 'I only know your account. Try: Analyze my account.' && offTopic.signals.length === 0, 'ask: an off-topic question gets the fixed reply')
  expectError(await post(`/wallets/${WALLET_IDS.a}/ask`, {}), 400, 'invalid_request', 'ask with neither preset nor question → 400 invalid_request')
  expectError(await post('/wallets/does_not_exist/ask', { preset: 'week' }), 404, 'wallet_not_found', 'ask for an unknown wallet → 404 wallet_not_found')

  section('Errors')
  expectError(await get('/wallets/does_not_exist'), 404, 'wallet_not_found', '404 wallet_not_found')
  expectError(await get(`/sessions/does_not_exist?wallet_id=${WALLET_IDS.a}`), 404, 'session_not_found', '404 session_not_found')

  const profileA = wallets.a.agent_profile
  const reserve = deskProfile.secret_min_reserve_usd
  const ceiling = profileA.buyer_max_ceiling_usd
  const request = (sellerAddress) => ({
    buyer_wallet_id: WALLET_IDS.a,
    seller_address: sellerAddress,
    asset_id: pepe.asset_id,
    rgb_amount: deskProfile.offered_amount,
    buyer_max_ceiling_usd: ceiling,
    buyer_target_usd: profileA.buyer_target_usd,
    buyer_ai_prompt: profileA.buyer_ai_prompt,
  })

  section('Gate at creation')
  const blocked = await post('/sessions', request('bcrt1qcontractcheckunknownaddress'))
  checkShape(blocked.data, SESSION_VIEW, 'SessionView shape (blocked)')
  check(blocked.data.state === 'BLOCKED_BY_GATE' && blocked.data.rounds.length === 0, 'an unknown address is born BLOCKED_BY_GATE, without rounds', blocked.data.state)
  check(blocked.data.gate?.passed === false && blocked.data.gate.trust_tier === 'Unverified' && blocked.data.gate.reasons.length > 0, 'gate carries trust_tier and reasons', JSON.stringify(blocked.data.gate))
  const toSybil = { ...request(wallets.sybil.address), rgb_amount: wallets.sybil.agent_profile.offered_amount }
  const refused = await post('/sessions', toSybil)
  expectError(refused, 409, 'confirm_risk', 'a ring without consent → 409 confirm_risk, nothing created')
  check(!/\d/.test(refused.data?.message ?? ''), 'the warning quotes no loop % or trade counts', refused.data?.message)
  const consented = await post('/sessions', { ...toSybil, accept_risk: true })
  if (consented.status === 200) {
    // Cancelled at once: a negotiation with Sybil is not left running.
    const cancelled = await post(`/sessions/${consented.data.session_id}/cancel`, { wallet_id: WALLET_IDS.a })
    check(consented.data.state === 'NEGOTIATING' && consented.data.risk_accepted === true, 'with accept_risk a ring negotiates (risk_accepted)', `${consented.data.state} ${consented.data.risk_accepted}`)
    check(cancelled.data?.state === 'CANCELLED_BY_USER', 'the consented Sybil session is cancelled at once', cancelled.data?.state)
  } else {
    // On a fresh regtest Sybil holds none of the lot it lists: consent passes the gate, the desk check answers.
    check(consented.status === 409 && consented.data?.code === 'insufficient_funds', 'with accept_risk the gate lets a ring through (Sybil holds none of its lot: 409 insufficient_funds)', `${consented.status} ${JSON.stringify(consented.data)?.slice(0, 120)}`)
  }

  section(`Negotiation (Wallet A → Wallet B, up to ${MAX_ROUNDS} rounds)`)
  const created = await post('/sessions', request(wallets.b.address))
  check(created.status === 200 && created.data.state === 'NEGOTIATING', 'POST /sessions returns NEGOTIATING immediately', `${created.status} ${created.data?.state}`)
  const sessionId = created.data.session_id
  const { view: buyerView, seconds } = await waitWhile(sessionId, WALLET_IDS.a, ['NEGOTIATING'], 240_000)
  const sellerView = (await get(`/sessions/${sessionId}?wallet_id=${WALLET_IDS.b}`)).data
  checkShape(buyerView, SESSION_VIEW, 'SessionView shape (buyer)')
  checkShape(sellerView, SESSION_VIEW, 'SessionView shape (seller)')
  for (const r of buyerView.rounds) checkShape(r, ROUND, `round ${r.n} shape`)
  check(buyerView.my_role === 'buyer' && sellerView.my_role === 'seller', 'my_role follows the viewer')
  check(buyerView.rounds.length <= MAX_ROUNDS && buyerView.rounds.every((r, i) => r.n === i + 1), `at most ${MAX_ROUNDS} rounds, numbered from 1`)
  const thoughtsMasked = buyerView.rounds.every((r, i) => r.my_private_thought === null || r.my_private_thought !== sellerView.rounds[i]?.my_private_thought)
  check(thoughtsMasked, 'each side sees only its own private thought')
  check(!SECRET_KEYS.test(JSON.stringify(buyerView) + JSON.stringify(sellerView)), 'no secret fields in session views')
  const buyerOffers = buyerView.rounds.map((r) => r.buyer_offer_usd).filter(isNum)
  const sellerOffers = buyerView.rounds.filter((r) => r.seller_action === 'OFFER').map((r) => r.seller_offer_usd)
  console.log(`        buyer ${buyerOffers.join(' → ')} | seller ${sellerOffers.join(' → ')} | agreed ${buyerView.agreed_price_usd} in ${seconds.toFixed(1)}s`)
  check(buyerOffers.every((o) => o <= ceiling), `buyer never offers above its ceiling (${ceiling})`)
  check(sellerOffers.every((o) => o >= reserve), `seller never offers below its reserve (${reserve})`)
  check(buyerOffers.every((o, i) => i === 0 || o >= buyerOffers[i - 1]), 'buyer offers never go down')
  warn(buyerOffers[0] <= profileA.buyer_target_usd, `buyer opens at or below its target (${profileA.buyer_target_usd})`, `opened at ${buyerOffers[0]}`)
  const publicText = buyerView.rounds.flatMap((r) => [r.public_messages.buyer, r.public_messages.seller]).join(' ')
  // A secret may legitimately be quoted once it is also a public offer (e.g. agreeing at the ceiling).
  const quoted = [ceiling, reserve, profileA.buyer_target_usd].filter((n) => new RegExp(`\\b${n}\\b`).test(publicText) && ![...buyerOffers, ...sellerOffers].includes(n))
  warn(quoted.length === 0, 'public messages do not quote a secret number that was never offered', quoted.join(', '))

  if (buyerView.state === 'BLOCKED_BY_GATE') {
    check(buyerView.gate?.reasons.length > 0, 'no agreement ends BLOCKED_BY_GATE with a reason', JSON.stringify(buyerView.gate))
    warn(false, 'no agreement this run: signing checks skipped, run again')
    return
  }
  check(buyerView.state === 'AWAITING_SIGNATURES', 'agreement reaches AWAITING_SIGNATURES', buyerView.state)
  if (buyerView.state !== 'AWAITING_SIGNATURES') return

  const agreed = buyerView.agreed_price_usd
  const terms = buyerView.terms
  check(agreed >= reserve && agreed <= ceiling, `agreed price inside the secret limits [${reserve}, ${ceiling}]`, `agreed ${agreed}`)
  check(buyerView.gate?.passed === true, 'gate passed on the agreed terms', JSON.stringify(buyerView.gate))
  check(buyerView.terms_hash === sha256(canonicalJson(terms)) && sellerView.terms_hash === buyerView.terms_hash, 'terms_hash = SHA-256 of the canonical terms, same for both sides')
  check(terms.asset_id === pepe.asset_id && terms.payment_asset_id === usdt.asset_id, 'terms use the market asset ids (PEPE, USDT)', `${terms.asset_id} / ${terms.payment_asset_id}`)
  check(terms.payment_amount === agreed * 10 ** usdt.precision && terms.agreed_price_usd === agreed && terms.rgb_amount === deskProfile.offered_amount, 'payment_amount and rgb_amount match the agreement')
  check(terms.buyer_address === wallets.a.address && terms.seller_address === wallets.b.address && terms.network_fee_sat === 2000, 'terms addresses and network_fee_sat 2000')
  const ttl = terms.expiry_unix - Math.floor(Date.now() / 1000)
  check(ttl > 0 && ttl <= 600, 'expiry_unix within the 600 s TTL', `${ttl}s left`)

  section('Signing guards')
  expectError(await post(`/sessions/${sessionId}/sign`, { wallet_id: WALLET_IDS.a, terms_hash: '0'.repeat(64) }), 409, 'terms_hash_mismatch', 'wrong hash → 409 terms_hash_mismatch')
  const noHash = await post(`/sessions/${sessionId}/sign`, { wallet_id: WALLET_IDS.a })
  check(noHash.status >= 400 && noHash.status < 500, 'missing terms_hash is rejected', `${noHash.status}`)
  warn(isStr(noHash.data?.code), 'validation errors use the {code, message} body', JSON.stringify(noHash.data)?.slice(0, 120))
  expectError(await post(`/sessions/${sessionId}/cancel`, { wallet_id: WALLET_IDS.sybil }), 403, 'forbidden', 'cancel by a third wallet → 403 forbidden')
  const still = (await get(`/sessions/${sessionId}?wallet_id=${WALLET_IDS.a}`)).data
  check(still.state === 'AWAITING_SIGNATURES' && !still.buyer_signed && !still.seller_signed, 'rejected calls leave the session untouched')

  if (!E2E) {
    // The agreed session stays unsigned: cancelling it would cost Wallet A 10% of its score for good.
    // Cancel runs on a second session instead, before its agents agree, which costs nothing.
    section('Cancel')
    const second = (await post('/sessions', request(wallets.b.address))).data
    check(second?.state === 'NEGOTIATING', 'a second session starts NEGOTIATING', second?.state)
    if (second?.state !== 'NEGOTIATING') return
    const cancelled = await post(`/sessions/${second.session_id}/cancel`, { wallet_id: WALLET_IDS.a })
    check(cancelled.data?.state === 'CANCELLED_BY_USER', 'cancel while negotiating → CANCELLED_BY_USER', cancelled.data?.state)
    expectError(await post(`/sessions/${second.session_id}/cancel`, { wallet_id: WALLET_IDS.a }), 409, 'not_cancellable', 'second cancel → 409 not_cancellable')
    const before = wallets.a.trust.reliability_pct
    const after = (await get(`/wallets/${WALLET_IDS.a}`)).data.trust.reliability_pct
    check(after >= before, `cancelling before an agreement keeps Wallet A's reliability (${before}% → ${after}%)`)
    console.log(`        ${sessionId} stays agreed and unsigned: it expires in ${ttl}s, without a walk-away`)
    return
  }

  section('E2E settlement')
  const signedA = await post(`/sessions/${sessionId}/sign`, { wallet_id: WALLET_IDS.a, terms_hash: buyerView.terms_hash }, 120_000)
  check(signedA.status === 200 && signedA.data.buyer_signed && !signedA.data.seller_signed && signedA.data.state === 'AWAITING_SIGNATURES', 'buyer signature alone does not settle', `${signedA.status} ${signedA.data?.state}`)
  expectError(await post(`/sessions/${sessionId}/sign`, { wallet_id: WALLET_IDS.a, terms_hash: buyerView.terms_hash }), 409, 'already_signed', 'double sign → 409 already_signed')
  const signedB = await post(`/sessions/${sessionId}/sign`, { wallet_id: WALLET_IDS.b, terms_hash: sellerView.terms_hash }, 120_000)
  check(signedB.status === 200 && signedB.data.seller_signed && ['SETTLING', 'SETTLED'].includes(signedB.data.state), 'second signature starts SETTLING', `${signedB.status} ${signedB.data?.state}`)
  expectError(await post(`/sessions/${sessionId}/cancel`, { wallet_id: WALLET_IDS.a }), 409, 'not_cancellable', 'cancel during SETTLING → 409 not_cancellable')
  const { view: settled, seconds: settleSeconds } = await waitWhile(sessionId, WALLET_IDS.a, ['AWAITING_SIGNATURES', 'SETTLING'], 600_000)
  check(settled.state === 'SETTLED', `SETTLED in ${settleSeconds.toFixed(1)}s`, `${settled.state} ${JSON.stringify(settled.failure)}`)
  for (const step of settled.settlement_steps) checkShape(step, STEP, `step ${step.index} shape`)
  check(
    settled.settlement_steps.length === SETTLEMENT_STEPS.length && settled.settlement_steps.every((s, i) => s.index === SETTLEMENT_STEPS[i].index && s.name === SETTLEMENT_STEPS[i].name),
    'the 7 rgb-lib steps, in order',
    settled.settlement_steps.map((s) => s.name).join(', '),
  )
  check(settled.settlement_steps.every((s) => s.status === 'done'), 'every step done')
  check(/^[0-9a-f]{64}$/.test(settled.txid ?? ''), 'txid is a 64-char hex', settled.txid)

  const a1 = (await get(`/wallets/${WALLET_IDS.a}`)).data
  const b1 = (await get(`/wallets/${WALLET_IDS.b}`)).data
  const paid = terms.payment_amount
  const lot = terms.rgb_amount
  check(amountOf(a1, pepe.asset_id) - amountOf(wallets.a, pepe.asset_id) === lot && amountOf(wallets.b, pepe.asset_id) - amountOf(b1, pepe.asset_id) === lot, `PEPE moved B → A (${lot})`)
  check(amountOf(wallets.a, usdt.asset_id) - amountOf(a1, usdt.asset_id) === paid && amountOf(b1, usdt.asset_id) - amountOf(wallets.b, usdt.asset_id) === paid, `USDT moved A → B (${paid})`)
  warn(amountOf(a1, 'btc') < amountOf(wallets.a, 'btc'), 'buyer paid the BTC network fee', `A btc ${amountOf(wallets.a, 'btc')} → ${amountOf(a1, 'btc')}, B btc ${amountOf(wallets.b, 'btc')} → ${amountOf(b1, 'btc')}`)
  check(a1.history_points.length === wallets.a.history_points.length + 1 && b1.history_points.length === wallets.b.history_points.length + 1, 'one new history point per wallet')
  const swapItems = (w) => w.activity.filter((item) => item.session_id === sessionId)
  check(swapItems(a1).length === 2 && swapItems(b1).length === 2 && swapItems(a1).every((item) => item.kind === 'swap' && item.txid === settled.txid), 'two swap activity items per wallet with the txid')
  const market1 = (await get('/market')).data
  const pepe1 = market1.assets.find((a) => a.asset_id === pepe.asset_id)
  check(Math.abs(pepe1.price_usd - agreed / (lot / 10 ** pepe.precision)) < 1e-12, 'PEPE market price = agreed / lot', `${pepe1.price_usd}`)
  warn(a1.trust.reliability_pct > wallets.a.trust.reliability_pct, 'the settled swap raises Wallet A\'s reliability', `${wallets.a.trust.reliability_pct}% → ${a1.trust.reliability_pct}%`)
}

try {
  await main()
} catch (error) {
  failed += 1
  console.log(`\n  FAIL  aborted: ${error.message}`)
}
console.log(`\n${failed === 0 ? 'OK' : 'FAILED'}: ${failed} failed, ${warned} warnings`)
process.exitCode = failed === 0 ? 0 : 1
