import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'

/** Deterministic hue (0–359) for dynamic RGB assets */
function hueFor(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return hash % 360
}

export type AssetBadgeSize = 'sm' | 'md' | 'lg'

export interface AssetBadgeProps {
  ticker: string
  asset_id: string
  size?: AssetBadgeSize
  showTicker?: boolean
  className?: string
}

const CIRCLE_SIZES: Record<AssetBadgeSize, string> = {
  sm: 'size-6 text-[11px]',
  md: 'size-8 text-xs font-bold',
  lg: 'size-10 text-sm font-bold',
}

const TEXT_SIZES: Record<AssetBadgeSize, string> = {
  sm: 'text-xs',
  md: 'text-sm font-semibold',
  lg: 'text-base font-semibold',
}

/**
 * Circular asset badge identifying tokens with official colors:
 * - BTC: bg-btc with the Bitcoin symbol ₿
 * - USDT: bg-usdt with the typographic Tether ₮
 * - PEPE-RGB: bg-pepe with a P
 * - other assets: initial on a hue derived from asset_id (.avatar)
 * - Other assets: deterministic hue from asset_id with ticker initial
 */
export function AssetBadge({
  ticker,
  asset_id,
  size = 'md',
  showTicker = false,
  className,
}: AssetBadgeProps) {
  const normTicker = ticker.toUpperCase()
  const isBtc = normTicker === 'BTC' || asset_id.toLowerCase() === 'btc'
  const isUsdt = normTicker.includes('USDT')
  const isPepe = normTicker.includes('PEPE')

  let bgClass: string
  let customStyle: CSSProperties | undefined
  let symbolContent: string = ticker.charAt(0).toUpperCase()

  if (isBtc) {
    bgClass = 'bg-btc text-on-accent'
    symbolContent = '₿'
  } else if (isUsdt) {
    bgClass = 'bg-usdt text-on-accent'
    symbolContent = '₮'
  } else if (isPepe) {
    bgClass = 'bg-pepe text-on-accent'
    symbolContent = 'P'
  } else {
    const hue = hueFor(asset_id || ticker)
    bgClass = 'avatar'
    customStyle = { '--avatar-hue': hue } as CSSProperties
  }

  const circle = (
    <span
      style={customStyle}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-bold select-none leading-none shadow-sm',
        CIRCLE_SIZES[size],
        bgClass
      )}
      aria-hidden="true"
    >
      {symbolContent}
    </span>
  )

  if (!showTicker) {
    return circle
  }

  return (
    <span className={cn('badge-nowrap inline-flex items-center gap-2 select-none', className)}>
      {circle}
      <span className={cn('text-fg tracking-tight', TEXT_SIZES[size])}>
        {ticker}
      </span>
    </span>
  )
}
