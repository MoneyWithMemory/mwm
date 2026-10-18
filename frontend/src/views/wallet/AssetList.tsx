import type { ReactNode } from 'react'
import type { AssetBalance, Market } from '@/api'
import { AssetBadge } from '@/components/ui'
import { formatUsd } from '@/lib/format'
import { assetValueUsd, formatBalance } from './valuation'

interface AssetListProps {
  assets: AssetBalance[]
  costBasis: Record<string, number | null>
  market: Market | undefined
  /** Right end of the title row, e.g. "Move to Vault". */
  action?: ReactNode
}

export function AssetList({ assets, costBasis, market, action }: AssetListProps) {
  return (
    <section className="flex flex-col gap-2" aria-label="Assets">
      <div className="flex min-h-8 items-center justify-between gap-2 px-1">
        <h2 className="text-sm font-semibold text-hint">Assets</h2>
        {action}
      </div>
      <ul className="flex flex-col divide-y divide-separator rounded-card bg-surface shadow-card">
        {assets.map((asset) => {
          const value = assetValueUsd(asset, market)
          const basis = costBasis[asset.asset_id]
          return (
            <li key={asset.asset_id} className="flex items-center gap-3 p-3">
              <AssetBadge ticker={asset.ticker} asset_id={asset.asset_id} size="lg" />
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
