import type { AssetBalance, Market } from '@/api'
import { formatAssetAmount, formatSats } from '@/lib/format'

/** USD value of a balance, or null while the asset has no price (e.g. PEPE before its first trade). */
export function assetValueUsd(asset: AssetBalance, market: Market | undefined): number | null {
  if (!market) return null
  if (asset.schema === 'BTC') return asset.amount / market.sats_per_usd
  const price = market.assets.find((p) => p.asset_id === asset.asset_id)?.price_usd ?? null
  return price === null ? null : (asset.amount / 10 ** asset.precision) * price
}

export function totalValueUsd(assets: AssetBalance[], market: Market | undefined): number {
  return assets.reduce((sum, asset) => sum + (assetValueUsd(asset, market) ?? 0), 0)
}

/** BTC is shown in sats (it only pays fees); every other asset in display units. */
export function formatBalance(asset: { schema: string; precision: number; ticker: string }, amount: number): string {
  return asset.schema === 'BTC' ? formatSats(amount) : formatAssetAmount(amount, asset.precision, asset.ticker)
}
