// Lot rules shared by the buy forms and the mock backend, against the backend's numbers
// (backend/tests/test_api_server.py). Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ShopListing } from '../src/api/types.ts'
import { lotIssue, minLotAmount, proRataPrice, type LotTerms } from '../src/lib/lots.ts'
import { unitPriceText } from '../src/views/shop/unitPrice.ts'

// The demo desk: 1,000,000 PEPE (precision 0) for 150 USDT.
const LOT = 1_000_000
const ASK = 150

function desk(allowPartial: boolean): LotTerms {
  return { offered_amount: LOT, asking_price_usd: ASK, allow_partial: allowPartial }
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

test('with consent any part from 1 USDT worth up to the whole lot', () => {
  assert.equal(minLotAmount(ASK, LOT), 6_667) // ceil(1,000,000 / 150)
  assert.equal(lotIssue(desk(true), LOT), null)
  assert.equal(lotIssue(desk(true), LOT / 2), null)
  assert.equal(lotIssue(desk(true), 6_667), null)
  assert.equal(lotIssue(desk(true), 6_666), 'amount_too_small')
  assert.equal(lotIssue(desk(true), LOT + 1), 'exceeds_lot')
})

test('a part costs the unit price times the amount; the whole lot keeps its price', () => {
  assert.equal(proRataPrice(ASK, LOT, LOT), 150)
  assert.equal(proRataPrice(ASK, LOT, LOT / 2), 75)
  assert.equal(proRataPrice(ASK, LOT, 250_000), 38) // 37.5 rounds half up, as the backend
  assert.equal(proRataPrice(ASK, LOT, 6_667), 1)
  assert.equal(proRataPrice(ASK, LOT, LOT + 1), 150) // never more than the lot's price
})

test('the unit price shown on a listing gives back its totals', () => {
  const listing = sellListing(LOT, ASK)
  const text = unitPriceText(listing)
  assert.equal(text, '$0.00015')
  const unit = Number(text?.slice(1))
  assert.ok(Math.abs(unit * LOT - ASK) < 0.01, 'unit price × lot = list price')
  for (const amount of [LOT / 2, 250_000, 6_667]) {
    assert.ok(Math.abs(unit * amount - proRataPrice(ASK, LOT, amount)) <= 0.5, `unit price × ${amount} ≈ its pro-rata price`)
  }
})

test('the unit price is per display unit, and there is none for an empty lot', () => {
  assert.equal(unitPriceText(sellListing(250, 10, 2)), '$4.00') // 2.50 units for $10
  assert.equal(unitPriceText(sellListing(0, 10)), null)
})
