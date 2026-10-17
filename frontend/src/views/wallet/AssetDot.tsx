import { cn } from '@/lib/cn'

const COLORS: Record<string, string> = {
  BTC: 'bg-btc text-on-accent',
  USDT: 'bg-usdt text-on-accent',
  PEPE: 'bg-pepe text-on-accent',
}

/** Round asset badge. Stopgap until the shared AssetBadge lands in components/ui. */
export function AssetDot({ ticker, className }: { ticker: string; className?: string }) {
  return (
    <span
      className={cn(
        'badge-nowrap inline-flex size-10 shrink-0 items-center justify-center rounded-full text-sm font-semibold',
        COLORS[ticker] ?? 'bg-surface-muted text-hint',
        className,
      )}
      aria-hidden="true"
    >
      {ticker.slice(0, 1)}
    </span>
  )
}
