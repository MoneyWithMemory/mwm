import { motion } from 'motion/react'
import { useId, useMemo, useState, type PointerEvent } from 'react'
import type { AssetBalance, HistoryPoint } from '@/api'
import { cn } from '@/lib/cn'
import { formatUsd } from '@/lib/format'
import { DUR, EASE_OUT, SPRING_TABS } from '@/lib/motion'
import { formatBalance } from './valuation'

const W = 320
const H = 120
const PAD_X = 8
const PAD_Y = 14
const COMBINED = 'combined'

const dateFormat = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

interface Series {
  key: string
  label: string
  values: number[]
  format: (value: number) => string
}

interface Coord {
  x: number
  y: number
}

function toCoords(points: HistoryPoint[], values: number[]): Coord[] {
  const t0 = points[0].t
  const span = points[points.length - 1].t - t0
  const min = Math.min(...values)
  const max = Math.max(...values)
  const innerW = W - PAD_X * 2
  const innerH = H - PAD_Y * 2
  return points.map((p, i) => ({
    x: PAD_X + (span > 0 ? (p.t - t0) / span : points.length > 1 ? i / (points.length - 1) : 0.5) * innerW,
    y: max === min ? H / 2 : PAD_Y + (1 - (values[i] - min) / (max - min)) * innerH,
  }))
}

/** A single point is drawn as a flat line, so the path always has the same shape per point count. */
function linePath(coords: Coord[]): string {
  const pts = coords.length === 1 ? [{ x: PAD_X, y: coords[0].y }, { x: W - PAD_X, y: coords[0].y }] : coords
  return pts.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ')
}

function areaPath(coords: Coord[]): string {
  const pts = coords.length === 1 ? [{ x: PAD_X, y: coords[0].y }, { x: W - PAD_X, y: coords[0].y }] : coords
  return `${linePath(coords)} L${pts[pts.length - 1].x.toFixed(1)} ${H} L${pts[0].x.toFixed(1)} ${H} Z`
}

interface BalanceChartProps {
  walletId: string
  points: HistoryPoint[]
  assets: AssetBalance[]
}

export function BalanceChart({ walletId, points, assets }: BalanceChartProps) {
  const pillId = useId()
  const [selected, setSelected] = useState(COMBINED)
  const [hover, setHover] = useState<number | null>(null)

  const series = useMemo<Series[]>(
    () => [
      { key: COMBINED, label: 'Combined $', values: points.map((p) => p.total_usd), format: formatUsd },
      ...assets.map((asset) => ({
        key: asset.asset_id,
        label: asset.ticker,
        values: points.map((p) => (asset.schema === 'BTC' ? 1 : 1 / 10 ** asset.precision) * (p.balances[asset.asset_id] ?? 0)),
        format: (value: number) =>
          formatBalance(asset, asset.schema === 'BTC' ? value : Math.round(value * 10 ** asset.precision)),
      })),
    ],
    [points, assets],
  )

  const active = series.find((s) => s.key === selected) ?? series[0]
  const coords = useMemo(() => toCoords(points, active.values), [points, active.values])
  const shown = hover ?? points.length - 1
  const marker = coords[shown]

  const scrub = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / rect.width) * W
    let nearest = 0
    coords.forEach((c, i) => {
      if (Math.abs(c.x - x) < Math.abs(coords[nearest].x - x)) nearest = i
    })
    setHover(nearest)
  }

  return (
    <section className="flex flex-col gap-3 rounded-card bg-surface p-4 shadow-card" aria-label="Balance history">
      <div className="flex h-11 flex-col justify-start">
        <p className="amount text-lg font-semibold">{active.format(active.values[shown])}</p>
        <p className="text-xs text-hint">{dateFormat.format(new Date(points[shown].t * 1000))}</p>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-pan-y"
        role="img"
        aria-label={`${active.label} over time`}
        onPointerMove={scrub}
        onPointerDown={scrub}
        onPointerLeave={() => setHover(null)}
        onPointerUp={() => setHover(null)}
        onPointerCancel={() => setHover(null)}
      >
        <motion.path
          className="fill-accent/10"
          initial={false}
          animate={{ d: areaPath(coords) }}
          transition={{ duration: DUR.open, ease: EASE_OUT }}
        />
        <motion.path
          className="fill-none stroke-accent"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          initial={false}
          animate={{ d: linePath(coords) }}
          transition={{ duration: DUR.open, ease: EASE_OUT }}
        />
        {hover !== null && (
          <motion.line
            className="stroke-separator"
            y1={0}
            y2={H}
            initial={false}
            animate={{ x1: marker.x, x2: marker.x }}
            transition={{ duration: DUR.quick, ease: EASE_OUT }}
          />
        )}
        <motion.circle
          className="fill-accent stroke-surface"
          strokeWidth={2}
          r={5}
          initial={false}
          animate={{ cx: marker.x, cy: marker.y }}
          transition={{ duration: DUR.quick, ease: EASE_OUT }}
        />
      </svg>

      <div className="flex gap-1 rounded-control bg-surface-muted p-1" role="tablist" aria-label="Chart series">
        {series.map((s) => {
          const isActive = s.key === active.key
          return (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              className={cn(
                'pressable pressable-flat badge-nowrap relative flex-1 rounded-[calc(var(--radius-control)-4px)] px-2 py-1.5 text-xs font-medium',
                isActive ? 'text-fg' : 'text-hint',
              )}
              onClick={() => {
                setSelected(s.key)
                setHover(null)
              }}
            >
              {isActive && (
                <motion.span
                  layoutId={`chart-series-${pillId}-${walletId}`}
                  className="absolute inset-0 rounded-[calc(var(--radius-control)-4px)] bg-surface shadow-card"
                  transition={SPRING_TABS}
                />
              )}
              <span className="relative">{s.label}</span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
