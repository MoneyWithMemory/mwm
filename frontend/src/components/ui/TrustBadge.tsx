import { HelpCircle, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { TrustTier } from '@/api/types'
import { cn } from '@/lib/cn'

export interface TrustBadgeProps {
  tier: TrustTier
  reliabilityPct?: number | null
  size?: 'sm' | 'md'
  showIcon?: boolean
  className?: string
}

/**
 * Trust indicator driven by Layer-0 memory graph.
 * Enforces strict privacy rules: NEVER exposes loop % or raw transaction counts.
 * Displays only:
 * - High Authenticity (Reliability N%)
 * - Ring Anomaly Detected (Reliability N%)
 * - Unverified
 */
export function TrustBadge({
  tier,
  reliabilityPct,
  size = 'md',
  showIcon = true,
  className,
}: TrustBadgeProps) {
  let colorClass: string
  let IconComponent: typeof HelpCircle
  let label: string

  if (tier === 'High Authenticity') {
    colorClass = 'bg-success/15 text-success border-success/30'
    IconComponent = ShieldCheck
    label =
      reliabilityPct !== null && reliabilityPct !== undefined
        ? `High Authenticity · ${Math.round(reliabilityPct)}%`
        : tier
  } else if (tier === 'Ring Anomaly Detected') {
    colorClass = 'bg-danger/15 text-danger border-danger/30'
    IconComponent = ShieldAlert
    label =
      reliabilityPct !== null && reliabilityPct !== undefined
        ? `Ring Anomaly · ${Math.round(reliabilityPct)}%`
        : tier
  } else {
    colorClass = 'bg-surface-muted text-hint border-separator/40'
    IconComponent = HelpCircle
    label = 'Unverified'
  }

  const isSmall = size === 'sm'

  return (
    <span
      title={tier}
      className={cn(
        'badge-nowrap inline-flex items-center gap-1.5 font-medium rounded-full border select-none shrink-0 leading-none',
        isSmall ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
        colorClass,
        className
      )}
    >
      {showIcon && (
        <IconComponent
          size={isSmall ? 12 : 14}
          aria-hidden={true}
          className="shrink-0 text-current"
        />
      )}
      <span>{label}</span>
    </span>
  )
}
