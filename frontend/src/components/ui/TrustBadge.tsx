import { HelpCircle, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { TrustTier } from '@/api/types'
import { cn } from '@/lib/cn'
import { trustExplanation, trustLabel } from '@/lib/trust'
import { InfoTip } from './InfoTip'

export interface TrustBadgeProps {
  tier: TrustTier
  reliabilityPct?: number | null
  size?: 'sm' | 'md'
  /** "inline": plain secondary text for dense lists; only low reliability keeps its color, as a warning. */
  variant?: 'badge' | 'inline'
  /** A (?) that explains the label. Leave it off inside another button (rows): the title says it on hover. */
  explain?: boolean
  showIcon?: boolean
  className?: string
}

const TIER_STYLE: Record<TrustTier, { color: string; inlineColor: string; Icon: typeof HelpCircle }> = {
  'High Authenticity': { color: 'bg-success/15 text-success border-success/30', inlineColor: 'text-hint', Icon: ShieldCheck },
  'Ring Anomaly Detected': { color: 'bg-danger/15 text-danger border-danger/30', inlineColor: 'text-danger', Icon: ShieldAlert },
  Unverified: { color: 'bg-surface-muted text-hint border-separator', inlineColor: 'text-hint', Icon: HelpCircle },
}

/**
 * Trust indicator driven by the Layer-0 memory graph: the tier's label plus the reliability
 * (never loop % or raw trade counts), e.g. "High Authenticity · 92%", "Low reliability · 14%",
 * "Unverified". On narrow screens the percentage wraps to a second line; each segment itself
 * never breaks.
 */
export function TrustBadge({
  tier,
  reliabilityPct,
  size = 'md',
  variant = 'badge',
  explain = false,
  showIcon = true,
  className,
}: TrustBadgeProps) {
  const { color, inlineColor, Icon } = TIER_STYLE[tier]
  const label = trustLabel(tier)
  const explanation = trustExplanation(tier)
  const pct = tier !== 'Unverified' && reliabilityPct !== null && reliabilityPct !== undefined ? Math.round(reliabilityPct) : null
  const isSmall = size === 'sm' || variant === 'inline'

  return (
    <span
      title={explain ? undefined : `${pct === null ? label : `${label} · ${pct}% reliability`}. ${explanation}`}
      className={cn(
        'inline-flex max-w-full items-center select-none shrink-0 leading-tight',
        variant === 'inline'
          ? cn('gap-1 text-xs', inlineColor)
          : cn('gap-1.5 font-medium rounded-full border', isSmall ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs', color),
        className
      )}
    >
      {showIcon && <Icon size={isSmall ? 12 : 14} aria-hidden={true} className="shrink-0 text-current" />}
      <span className="flex min-w-0 flex-wrap items-center gap-x-1">
        <span className="badge-nowrap">{label}</span>
        {/* The space is not rendered in flex layout but keeps the text readable when read aloud or copied. */}
        {pct !== null && ' '}
        {pct !== null && <span className="badge-nowrap amount">· {pct}%</span>}
      </span>
      {explain && <InfoTip label={`About ${label}`} text={explanation} />}
    </span>
  )
}
