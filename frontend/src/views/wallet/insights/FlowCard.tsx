import { motion } from 'motion/react'
import { useId } from 'react'
import type { ActivityItem, Market } from '@/api'
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui'
import { formatUsd } from '@/lib/format'
import { DUR, EASE_OUT } from '@/lib/motion'
import { weeklyFlow } from './data'

const W = 300
const H = 110
const BAR_W = 12
const GAP = 3

const dayFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })

export function FlowCard({ activity, market, nowSeconds }: { activity: ActivityItem[]; market: Market; nowSeconds: number }) {
  const gradientId = useId()
  const weeks = weeklyFlow(activity, market, nowSeconds)
  const max = Math.max(...weeks.flatMap((w) => [w.received, w.sent]))
  const slot = W / weeks.length

  return (
    <Card>
      <CardHeader>
        <CardTitle>Received vs Sent</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {max === 0 ? (
          <EmptyState title="No activity in the last 5 weeks" description="Weekly totals appear after your next transaction." />
        ) : (
          <>
            <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label="Received and sent value per week">
              <defs>
                <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={0} y2={H}>
                  <stop offset="0" className="[stop-color:var(--color-chart-from)]" />
                  <stop offset="1" className="[stop-color:var(--color-chart-to)]" />
                </linearGradient>
              </defs>
              <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-separator" />
              {weeks.map((week, i) => {
                const x = i * slot + slot / 2
                const bars = [
                  { key: 'received', value: week.received, x: x - BAR_W - GAP / 2, className: '', label: 'Received' },
                  { key: 'sent', value: week.sent, x: x + GAP / 2, className: 'fill-hint/60', label: 'Sent' },
                ]
                return bars.map((bar) => {
                  const height = Math.max((bar.value / max) * (H - 8), bar.value > 0 ? 2 : 0)
                  return (
                    <motion.rect
                      key={`${i}-${bar.key}`}
                      x={bar.x}
                      width={BAR_W}
                      rx={3}
                      className={bar.className}
                      fill={bar.key === 'received' ? `url(#${gradientId})` : undefined}
                      initial={{ y: H, height: 0 }}
                      animate={{ y: H - height, height }}
                      transition={{ duration: DUR.open * 2, ease: EASE_OUT, delay: i * 0.04 }}
                    >
                      <title>{`${bar.label} · week of ${dayFormat.format(new Date(week.start * 1000))}: ${formatUsd(bar.value)}`}</title>
                    </motion.rect>
                  )
                })
              })}
            </svg>
            <div className="flex text-[11px] text-hint">
              {weeks.map((week) => (
                <span key={week.start} className="amount flex-1 text-center">
                  {dayFormat.format(new Date(week.start * 1000))}
                </span>
              ))}
            </div>
            <div className="flex gap-4 text-xs text-hint">
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-linear-to-b from-chart-from to-chart-to" aria-hidden="true" />
                Received
              </span>
              <span className="flex items-center gap-1.5">
                <span className="size-2 rounded-full bg-hint/60" aria-hidden="true" />
                Sent
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
