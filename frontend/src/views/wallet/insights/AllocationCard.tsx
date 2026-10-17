import { motion } from 'motion/react'
import type { AssetBalance, Market } from '@/api'
import { AssetBadge, Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui'
import { formatUsd } from '@/lib/format'
import { DUR, EASE_OUT } from '@/lib/motion'
import { allocation } from './data'

const R = 40
const CIRCUMFERENCE = 2 * Math.PI * R

/** Token colors per ticker; any other asset falls back to the accent. */
const SEGMENT_CLASS: Record<string, string> = {
  BTC: 'stroke-btc',
  USDT: 'stroke-usdt',
  PEPE: 'stroke-pepe',
}

export function AllocationCard({ assets, market }: { assets: AssetBalance[]; market: Market }) {
  const { slices, total } = allocation(assets, market)
  // Each segment starts where the previous one ends.
  const starts = slices.map((_, i) => slices.slice(0, i).reduce((sum, s) => sum + s.share * CIRCUMFERENCE, 0))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Allocation</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {slices.length === 0 ? (
          <EmptyState title="No priced assets yet" description="Allocation appears once your assets have a price." />
        ) : (
          <>
            <div className="relative mx-auto size-40">
              <svg viewBox="0 0 100 100" className="size-full -rotate-90" role="img" aria-label="Allocation by asset">
                <circle cx={50} cy={50} r={R} className="fill-none stroke-surface-muted" strokeWidth={12} />
                {slices.map((slice, i) => {
                  // A small gap between segments keeps neighbours readable.
                  const length = Math.max(slice.share * CIRCUMFERENCE - 1.5, 0)
                  return (
                    <motion.circle
                      key={slice.asset.asset_id}
                      cx={50}
                      cy={50}
                      r={R}
                      className={`fill-none ${SEGMENT_CLASS[slice.asset.ticker] ?? 'stroke-accent'}`}
                      strokeWidth={12}
                      strokeDashoffset={-starts[i]}
                      initial={{ strokeDasharray: `0 ${CIRCUMFERENCE}` }}
                      animate={{ strokeDasharray: `${length} ${CIRCUMFERENCE - length}` }}
                      transition={{ duration: DUR.open * 2, ease: EASE_OUT }}
                    />
                  )
                })}
              </svg>
              <div className="absolute inset-0 flex flex-col items-center justify-center">
                <span className="amount text-base font-semibold">{formatUsd(total)}</span>
                <span className="text-xs text-hint">Total</span>
              </div>
            </div>
            <ul className="grid grid-cols-2 gap-x-4 gap-y-2">
              {slices.map((slice) => (
                <li key={slice.asset.asset_id} className="flex items-center justify-between gap-2">
                  <AssetBadge ticker={slice.asset.ticker} asset_id={slice.asset.asset_id} size="sm" showTicker />
                  <span className="amount text-xs text-hint">{Math.round(slice.share * 100)}%</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  )
}
