// Lot rules shared by the buy forms and the mock backend, against the backend's numbers
// (backend/tests/test_api_server.py). Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ShopListing } from '../src/api/types.ts'
import { ApiError, readableMessage, WHOLE_USD_MESSAGE } from '../src/api/client.ts'
import { mockEngine } from '../src/api/mock/engine.ts'
import { ADDRESSES, ASSETS, ECONOMY } from '../src/api/mock/seed.ts'
import { lotIssue, MIN_PART_USD, minLotAmount, proRataPrice, suggestedLimits, type LotTerms } from '../src/lib/lots.ts'
import { parseUsd } from '../src/lib/usd.ts'
import { unitPriceText } from '../src/views/shop/unitPrice.ts'

// The demo desk: 1,000,000 PEPE (precision 0) for 150 USDT.
const LOT = 1_000_000
const ASK = 150

function desk(allowPartial: boolean, ask = ASK): LotTerms {
  return { offered_amount: LOT, asking_price_usd: ask, allow_partial: allowPartial }
}

function sellListing(amount: number, priceUsd: number, precision = 0): ShopListing {
  return {
    listing_id: 'desk_wallet_b',
    kind: 'sell',
    owner_address: 'bcrt1qdesk',
    owner_alias: 'Wallet B',
    is_mine: false,
    asset: { asset_id: 'rgb:pepe', ticker: 'PEPE', schema: 'NIA', precision },
    amount,
    price_usd: priceUsd,
    allow_partial: false,
    note: null,
    trust: { trusted: true, sybil_ring_detected: false, reliability_pct: 98, trust_tier: 'High Authenticity', assessment_summary: '' },
    created_at: null,
  }
}

test('without the seller consent only the whole lot can be bought', () => {
  assert.equal(lotIssue(desk(false), LOT), null)
  assert.equal(lotIssue(desk(false), LOT - 1), 'partial_not_allowed')
  assert.equal(lotIssue(desk(false), LOT / 2), 'partial_not_allowed')
  assert.equal(lotIssue(desk(false), LOT + 1), 'exceeds_lot')
})

test('with consent any part worth MIN_PART_USD or more, up to the whole lot', () => {
  assert.equal(MIN_PART_USD, 10) // same value as backend/api_server.py
  assert.equal(minLotAmount(ASK, LOT), 66_667) // ceil(1,000,000 × 10 / 150)
  assert.equal(lotIssue(desk(true), LOT), null)
  assert.equal(lotIssue(desk(true), LOT / 2), null)
  assert.equal(lotIssue(desk(true), 66_667), null)
  assert.equal(lotIssue(desk(true), 66_666), 'amount_too_small')
  assert.equal(lotIssue(desk(true), 12_500), 'amount_too_small') // 1.25% of the lot: about $2
  assert.equal(lotIssue(desk(true), LOT + 1), 'exceeds_lot')
})

test('a lot worth less than MIN_PART_USD sells whole only', () => {
  assert.equal(minLotAmount(8, LOT), LOT)
  assert.equal(minLotAmount(10, LOT), LOT)
  assert.equal(minLotAmount(20, LOT), LOT / 2)
  assert.equal(minLotAmount(0, LOT), LOT)
  assert.equal(lotIssue(desk(true, 8), LOT - 1), 'amount_too_small')
  assert.equal(lotIssue(desk(true, 8), LOT), null)
})

test('the part chips under the minimum are the ones a desk refuses', () => {
  // A $20 lot: 25% is worth $5 (refused), 50% is the smallest part, "All" always passes.
  const shares = [0.25, 0.5, 0.75, 1].map((share) => lotIssue(desk(true, 20), Math.floor(LOT * share)))
  assert.deepEqual(shares, ['amount_too_small', null, null, null])
})

test('a part costs the unit price times the amount; the whole lot keeps its price', () => {
  assert.equal(proRataPrice(ASK, LOT, LOT), 150)
  assert.equal(proRataPrice(ASK, LOT, LOT / 2), 75)
  assert.equal(proRataPrice(ASK, LOT, 250_000), 38) // 37.5 rounds half up, as the backend
  assert.equal(proRataPrice(ASK, LOT, 66_667), 10) // the smallest part is worth MIN_PART_USD
  assert.equal(proRataPrice(ASK, LOT, LOT + 1), 150) // never more than the lot's price
})

test('the unit price shown on a listing gives back its totals', () => {
  const listing = sellListing(LOT, ASK)
  const text = unitPriceText(listing)
  assert.equal(text, '$0.00015')
  const unit = Number(text?.slice(1))
  assert.ok(Math.abs(unit * LOT - ASK) < 0.01, 'unit price × lot = list price')
  for (const amount of [LOT / 2, 250_000, 66_667]) {
    assert.ok(Math.abs(unit * amount - proRataPrice(ASK, LOT, amount)) <= 0.5, `unit price × ${amount} ≈ its pro-rata price`)
  }
})

test('the unit price is per display unit, and there is none for an empty lot', () => {
  assert.equal(unitPriceText(sellListing(250, 10, 2)), '$4.00') // 2.50 units for $10
  assert.equal(unitPriceText(sellListing(0, 10)), null)
})

test('suggested limits are whole dollars from 1, target at most the maximum', () => {
  assert.deepEqual(suggestedLimits(150, 1_000), { target: '120', ceiling: '135' })
  assert.deepEqual(suggestedLimits(10, 1_000), { target: '8', ceiling: '9' })
  assert.deepEqual(suggestedLimits(2, 1_000), { target: '2', ceiling: '2' })
  assert.deepEqual(suggestedLimits(150, 40.7), { target: '40', ceiling: '40' }) // within the balance
  assert.deepEqual(suggestedLimits(1, 0), { target: '1', ceiling: '1' })
  for (const [price, available] of [[3, 1_000], [37, 12.5], [0, 0], [999, 1]]) {
    const { target, ceiling } = suggestedLimits(price, available)
    assert.ok(/^[1-9]\d*$/.test(target) && /^[1-9]\d*$/.test(ceiling) && Number(target) <= Number(ceiling), `${price}, ${available}`)
  }
})

test('USD fields take whole dollars; a decimal separator is flagged', () => {
  assert.deepEqual(parseUsd('12'), { value: 12, cents: false })
  assert.deepEqual(parseUsd(' 2 '), { value: 2, cents: false })
  for (const text of ['0.5', '1.5', '1,5', '2.', '.', '1,000']) assert.deepEqual(parseUsd(text), { value: null, cents: true }, text)
  for (const text of ['', 'abc', '-1', '1e3']) assert.deepEqual(parseUsd(text), { value: null, cents: false }, text)
})

test('a schema refusal from the backend reads as a plain sentence', () => {
  const raw =
    'body.buyer_max_ceiling_usd: Input should be a valid integer, got a number with a fractional part; ' +
    'body.buyer_target_usd: Input should be a valid integer, got a number with a fractional part'
  assert.equal(readableMessage('invalid_request', raw), WHOLE_USD_MESSAGE)
  assert.equal(readableMessage('invalid_request', 'query.wallet_id: Field required'), 'Some values are not valid. Check them and try again.')
  // Messages written for people stay as they are.
  const human = 'Only USDT and PEPE move between your Wallet and your Vault.'
  assert.equal(readableMessage('invalid_request', human), human)
  assert.equal(readableMessage('amount_too_small', 'Buy at least 66667 PEPE: a smaller part is worth less than 10 USDT.'), 'Buy at least 66667 PEPE: a smaller part is worth less than 10 USDT.')
})

test('mock: a part under the minimum and a price with cents are refused as the backend does', () => {
  const request = {
    buyer_wallet_id: 'wallet_a', seller_address: ADDRESSES.b, asset_id: ASSETS.pepe.asset_id, rgb_amount: 12_500,
    buyer_max_ceiling_usd: 9, buyer_target_usd: 8, buyer_ai_prompt: '',
  }
  const refusal = (body: typeof request) => {
    try {
      mockEngine.createSession(body)
    } catch (err) {
      return err instanceof ApiError ? [err.status, err.code, err.message] : err
    }
    return null
  }
  const min = minLotAmount(ECONOMY.askUsd, ECONOMY.lotAmount)
  assert.deepEqual(refusal(request), [400, 'amount_too_small', `Buy at least ${min} PEPE: a smaller part is worth less than 10 USDT.`])
  assert.deepEqual(refusal({ ...request, rgb_amount: min, buyer_max_ceiling_usd: 1.5, buyer_target_usd: 0.5 }), [400, 'invalid_request', WHOLE_USD_MESSAGE])
})
