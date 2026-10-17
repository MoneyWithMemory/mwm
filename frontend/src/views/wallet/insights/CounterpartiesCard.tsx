import { motion } from 'motion/react'
import type { ActivityItem, Market } from '@/api'
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui'
import { formatUsd, shortAddress } from '@/lib/format'
import { DUR, EASE_OUT } from '@/lib/motion'
import { topCounterparties } from './data'

interface CounterpartiesCardProps {
  activity: ActivityItem[]
  aliases: Record<string, string>
  market: Market
}

export function CounterpartiesCard({ activity, aliases, market }: CounterpartiesCardProps) {
  const rows = topCounterparties(activity, market)
  const max = rows[0]?.value ?? 0

  return (
    <Card>
      <CardHeader>
        <CardTitle>Top counterparties</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {rows.length === 0 ? (
          <EmptyState title="No counterparties yet" description="People you trade with or receive from show up here." />
        ) : (
          rows.map((row) => (
            <div key={row.address} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-2">
                <span className="select-text truncate text-sm font-medium">{aliases[row.address] ?? shortAddress(row.address)}</span>
                <span className="amount text-xs text-hint">{formatUsd(row.value)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
                <motion.div
                  className="h-full origin-left rounded-full bg-accent"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: row.value / max }}
                  transition={{ duration: DUR.open * 2, ease: EASE_OUT }}
                />
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  )
}
