import { motion } from 'motion/react'
import { useId, useMemo, useState, type PointerEvent } from 'react'
import type { AssetBalance, HistoryPoint } from '@/api'
import { SegmentedControl } from '@/components/ui'
import { formatUsd } from '@/lib/format'
import { DUR, EASE_OUT } from '@/lib/motion'
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

/**
 * Smooth curve through the points: horizontal tangents at every point, so it never overshoots a value.
 * A single point is drawn as a flat line, so the path keeps the same command count for every series.
 */
function linePath(coords: Coord[]): string {
  if (coords.length === 1) return `M${PAD_X} ${coords[0].y.toFixed(1)} L${W - PAD_X} ${coords[0].y.toFixed(1)}`
  return coords
    .map((c, i) => {
      if (i === 0) return `M${c.x.toFixed(1)} ${c.y.toFixed(1)}`
      const prev = coords[i - 1]
      const mid = (prev.x + c.x) / 2
      return `C${mid.toFixed(1)} ${prev.y.toFixed(1)} ${mid.toFixed(1)} ${c.y.toFixed(1)} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`
    })
    .join(' ')
}

function areaPath(coords: Coord[]): string {
  const first = coords.length === 1 ? PAD_X : coords[0].x
  const last = coords.length === 1 ? W - PAD_X : coords[coords.length - 1].x
  return `${linePath(coords)} L${last.toFixed(1)} ${H} L${first.toFixed(1)} ${H} Z`
}

const GRID_LINES = [0.25, 0.5, 0.75]

interface BalanceChartProps {
  walletId: string
  points: HistoryPoint[]
  assets: AssetBalance[]
}

export function BalanceChart({ walletId, points, assets }: BalanceChartProps) {
  const id = useId()
  const areaId = `${id}-area`
  const lineId = `${id}-line`
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
        <defs>
          <linearGradient id={lineId} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={W} y2={0}>
            <stop offset="0" className="[stop-color:var(--color-chart-from)]" />
            <stop offset="1" className="[stop-color:var(--color-chart-to)]" />
          </linearGradient>
          <linearGradient id={areaId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="[stop-color:var(--color-accent)]" stopOpacity="0.28" />
            <stop offset="1" className="[stop-color:var(--color-accent)]" stopOpacity="0" />
          </linearGradient>
        </defs>
        {GRID_LINES.map((g) => (
          <line key={g} x1={0} x2={W} y1={H * g} y2={H * g} className="stroke-separator" strokeDasharray="2 4" />
        ))}
        <motion.path
          fill={`url(#${areaId})`}
          initial={false}
          animate={{ d: areaPath(coords) }}
          transition={{ duration: DUR.open, ease: EASE_OUT }}
        />
        <motion.path
          className="fill-none"
          stroke={`url(#${lineId})`}
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          initial={false}
          animate={{ d: linePath(coords) }}
          transition={{ duration: DUR.open, ease: EASE_OUT }}
        />
        {hover !== null && (
          <motion.line
            className="stroke-accent-cool/60"
            strokeDasharray="3 3"
            y1={0}
            y2={H}
            initial={false}
            animate={{ x1: marker.x, x2: marker.x }}
            transition={{ duration: DUR.quick, ease: EASE_OUT }}
          />
        )}
        <motion.circle
          className="fill-accent-cool/25"
          r={9}
          initial={false}
          animate={{ cx: marker.x, cy: marker.y }}
          transition={{ duration: DUR.quick, ease: EASE_OUT }}
        />
        <motion.circle
          className="fill-accent-cool stroke-surface"
          strokeWidth={2}
          r={4.5}
          initial={false}
          animate={{ cx: marker.x, cy: marker.y }}
          transition={{ duration: DUR.quick, ease: EASE_OUT }}
        />
      </svg>

      <div className="-mt-1 flex justify-between text-xs text-hint">
        <span>{dateFormat.format(new Date(points[0].t * 1000))}</span>
        <span>{dateFormat.format(new Date(points[points.length - 1].t * 1000))}</span>
      </div>

      <SegmentedControl
        fullWidth
        layoutId={`chart-series-${walletId}`}
        options={series.map((s) => ({ value: s.key, label: s.label }))}
        value={active.key}
        onChange={(key) => {
          setSelected(key)
          setHover(null)
        }}
      />
    </section>
  )
}
