// The UI's words for the backend's trust tiers (src/lib/trust.ts), whose trust a gate reason
// names (src/views/shared/sessionState.ts), and the mock's walk-away penalty (src/api/mock/seed.ts).
// Run with `node --import ./scripts/node-alias.mjs --test 'scripts/*.test.ts'`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GateResult, Role, TrustTier } from '../src/api/types.ts'
import { ADDRESSES, trustFor, withWalkAways } from '../src/api/mock/seed.ts'
import { ownTrustExplanation, trustExplanation, trustLabel, withTrustLabels } from '../src/lib/trust.ts'
import { isNoAgreement, isNoOverlap, ownTrustFailure } from '../src/views/shared/sessionState.ts'

const TIERS: TrustTier[] = ['High Authenticity', 'Low Reliability', 'Ring Anomaly Detected', 'Unverified']

test('every way of being untrustworthy is one label with one explanation', () => {
  assert.equal(trustLabel('Low Reliability'), 'Low reliability')
  assert.equal(trustLabel('Ring Anomaly Detected'), 'Low reliability')
  assert.equal(trustExplanation('Low Reliability'), trustExplanation('Ring Anomaly Detected'))
  assert.match(trustExplanation('Low Reliability'), /trading in loops/)
  assert.match(trustExplanation('Low Reliability'), /walking away from agreed deals/)
  assert.equal(trustLabel('High Authenticity'), 'High Authenticity')
  assert.equal(trustLabel('Unverified'), 'Unverified')
})

test('gate reasons name each tier in the UI words', () => {
  assert.equal(withTrustLabels('Counterparty trust check failed: Low Reliability'), 'Counterparty trust check failed: Low reliability')
  assert.equal(withTrustLabels('Buyer trust check failed: Ring Anomaly Detected'), 'Buyer trust check failed: Low reliability')
  assert.equal(withTrustLabels('Buyer trust check failed: Unverified'), 'Buyer trust check failed: Unverified')
})

test("the owner's own explanation says what the score does to their trades, never that they are a risk", () => {
  for (const tier of TIERS) assert.doesNotMatch(ownTrustExplanation(tier), /risk/, tier)
  assert.equal(ownTrustExplanation('Low Reliability'), ownTrustExplanation('Ring Anomaly Detected'))
  assert.match(ownTrustExplanation('Low Reliability'), /can't trade until it rises/)
  assert.match(ownTrustExplanation('Low Reliability'), /walking away from agreed deals lowers it/)
})

test("a gate reason names the viewer's own wallet by role: the backend writes both from the buyer's side", () => {
  const view = (my_role: Role, reasons: string[]) => ({ my_role, gate: { passed: false, trust_tier: 'High Authenticity', reasons } satisfies GateResult })
  assert.equal(ownTrustFailure(view('buyer', ['Buyer trust check failed: Ring Anomaly Detected'])), 'Ring Anomaly Detected')
  assert.equal(ownTrustFailure(view('buyer', ['Counterparty trust check failed: Low Reliability'])), null)
  assert.equal(ownTrustFailure(view('seller', ['Counterparty trust check failed: Low Reliability'])), 'Low Reliability')
  assert.equal(ownTrustFailure(view('seller', ['Buyer trust check failed: Unverified'])), null)
  assert.equal(ownTrustFailure(view('buyer', ['Counterparty trust check failed: Unverified', 'Buyer trust check failed: Unverified'])), 'Unverified')
  assert.equal(ownTrustFailure({ my_role: 'buyer', gate: null }), null)
  assert.ok(isNoAgreement(['No agreement within 10 rounds.']) && isNoAgreement(['No agreement: the offers stopped moving.']))
  assert.ok(!isNoAgreement(["No deal possible: the buyer's maximum is below the seller's minimum."]))
  assert.ok(isNoOverlap(["No deal possible: the buyer's maximum is below the seller's minimum."]))
})

test('mock: each walk-away takes 10% off the score, at most 50%, and below 60 the gate sees Low Reliability', () => {
  const a = trustFor(ADDRESSES.a)
  assert.deepEqual([0, 1, 2, 3, 4].map((n) => withWalkAways(a, n).reliability_pct), [89, 80, 71, 62, 53])
  assert.deepEqual([withWalkAways(a, 3).trust_tier, withWalkAways(a, 3).trusted], ['High Authenticity', true])
  assert.deepEqual([withWalkAways(a, 4).trust_tier, withWalkAways(a, 4).trusted], ['Low Reliability', false])
  assert.equal(withWalkAways(a, 9).reliability_pct, withWalkAways(a, 5).reliability_pct)
  assert.equal(withWalkAways(trustFor(ADDRESSES.sybil), 1).trust_tier, 'Ring Anomaly Detected')
  assert.equal(withWalkAways(trustFor(ADDRESSES.newcomer), 2).reliability_pct, null)
})
