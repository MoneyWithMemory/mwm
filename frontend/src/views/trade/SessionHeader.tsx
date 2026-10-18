import { ArrowLeft } from 'lucide-react'
import type { SessionView } from '@/api'
import { Avatar, IconButton, TrustBadge } from '@/components/ui'
import { formatAssetAmount } from '@/lib/format'
import { useWalletContext } from '@/lib/navigation'

/** One row: who you are dealing with, what for, and how far you can trust them. The page below says where the deal is. */
export function SessionHeader({ session, name, alias }: { session: SessionView; name: string; alias?: string }) {
  const { canGoBack, back } = useWalletContext()
  const trust = session.counterparty_trust

  return (
    <header className="flex items-center gap-3">
      {canGoBack && (
        <IconButton aria-label="Back" onClick={back}>
          <ArrowLeft size={18} aria-hidden="true" />
        </IconButton>
      )}
      <Avatar seed={session.counterparty_address} label={alias} size="md" />
      {/* The trust badge sits beside the name when there is room, under it when there is not. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <div className="flex min-w-0 flex-col">
          <h1 className="truncate text-base font-semibold">{name}</h1>
          <span className="amount truncate text-xs text-hint">
            {session.my_role === 'buyer' ? 'Buying' : 'Selling'}{' '}
            {formatAssetAmount(session.rgb_amount, session.asset.precision, session.asset.ticker)}
          </span>
        </div>
        <TrustBadge tier={trust.trust_tier} reliabilityPct={trust.reliability_pct} size="sm" explain />
      </div>
    </header>
  )
}
