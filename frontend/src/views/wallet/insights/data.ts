import type { ActivityItem, AssetBalance, Market } from '@/api'
import { assetValueUsd } from '../valuation'

const WEEK = 7 * 24 * 60 * 60
export const WEEKS = 5

/** USD value of one movement at today's prices, or null while its asset has no price. */
function movementUsd(item: ActivityItem, market: Market): number | null {
  return assetValueUsd({ ...item.asset, amount: item.amount }, market)
}

export interface AllocationSlice {
  asset: AssetBalance
  value: number
  share: number
}

/** Share of the wallet value held in each priced asset, largest first. */
export function allocation(assets: AssetBalance[], market: Market): { slices: AllocationSlice[]; total: number } {
  const priced = assets
    .map((asset) => ({ asset, value: assetValueUsd(asset, market) ?? 0 }))
    .filter((entry) => entry.value > 0)
  const total = priced.reduce((sum, entry) => sum + entry.value, 0)
  const slices = priced
    .map((entry) => ({ ...entry, share: entry.value / total }))
    .sort((a, b) => b.value - a.value)
  return { slices, total }
}

export interface WeekBucket {
  /** Unix seconds of the week start. */
  start: number
  received: number
  sent: number
}

/** Received and sent value per week for the last WEEKS weeks, oldest first. Issuance is not income. */
export function weeklyFlow(activity: ActivityItem[], market: Market, nowSeconds: number): WeekBucket[] {
  const buckets: WeekBucket[] = Array.from({ length: WEEKS }, (_, i) => ({
    start: nowSeconds - (WEEKS - i) * WEEK,
    received: 0,
    sent: 0,
  }))
  for (const item of activity) {
    if (item.kind === 'issue') continue
    const age = Math.floor((nowSeconds - item.t) / WEEK)
    if (age < 0 || age >= WEEKS) continue
    const value = movementUsd(item, market)
    if (value === null) continue
    const bucket = buckets[WEEKS - 1 - age]
    if (item.direction === 'in') bucket.received += value
    else bucket.sent += value
  }
  return buckets
}

export interface CounterpartyVolume {
  address: string
  value: number
}

/** Counterparties ranked by the value exchanged with them, in either direction. */
export function topCounterparties(activity: ActivityItem[], market: Market, limit = 4): CounterpartyVolume[] {
  const totals = new Map<string, number>()
  for (const item of activity) {
    if (!item.counterparty_address) continue
    const value = movementUsd(item, market)
    if (value === null) continue
    totals.set(item.counterparty_address, (totals.get(item.counterparty_address) ?? 0) + value)
  }
  return [...totals]
    .map(([address, value]) => ({ address, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, limit)
}
