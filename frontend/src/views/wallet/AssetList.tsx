import type { AssetBalance, Market } from '@/api'
import { formatUsd } from '@/lib/format'
import { AssetDot } from './AssetDot'
import { assetValueUsd, formatBalance } from './valuation'

interface AssetListProps {
  assets: AssetBalance[]
  costBasis: Record<string, number | null>
  market: Market | undefined
}

export function AssetList({ assets, costBasis, market }: AssetListProps) {
  return (
    <section className="flex flex-col gap-2" aria-label="Assets">
      <h2 className="px-1 text-sm font-semibold text-hint">Assets</h2>
      <ul className="flex flex-col divide-y divide-separator rounded-card bg-surface shadow-card">
        {assets.map((asset) => {
          const value = assetValueUsd(asset, market)
          const basis = costBasis[asset.asset_id]
          return (
            <li key={asset.asset_id} className="flex items-center gap-3 p-3">
              <AssetDot ticker={asset.ticker} />
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="badge-nowrap text-sm font-semibold">{asset.ticker}</span>
                <span className="amount text-xs text-hint">
                  {basis != null ? `Avg. cost ${formatUsd(basis)}` : 'No cost basis'}
                </span>
              </div>
              <div className="flex flex-col items-end">
                <span className="amount text-sm font-semibold">{formatBalance(asset, asset.amount)}</span>
                <span className="amount text-xs text-hint">{value === null ? 'No price yet' : formatUsd(value)}</span>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
