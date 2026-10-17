import { ArrowLeft } from 'lucide-react'
import type { SessionView } from '@/api'
import { Avatar, Badge, IconButton, TrustBadge } from '@/components/ui'
import { formatAssetAmount } from '@/lib/format'
import { useWalletContext } from '@/lib/navigation'
import { SESSION_STATE_LABEL, SESSION_STATE_VARIANT } from '../shared/sessionState'

export function SessionHeader({ session, name, alias }: { session: SessionView; name: string; alias?: string }) {
  const { canGoBack, back } = useWalletContext()
  const trust = session.counterparty_trust

  return (
    <header className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {canGoBack && (
          <IconButton aria-label="Back" onClick={back}>
            <ArrowLeft size={18} aria-hidden="true" />
          </IconButton>
        )}
        <h1 className="flex-1 text-lg font-semibold">P2P Trade</h1>
        <Badge variant={SESSION_STATE_VARIANT[session.state]}>{SESSION_STATE_LABEL[session.state]}</Badge>
      </div>
      <div className="flex items-center gap-3 rounded-card bg-surface p-3 shadow-card">
        <Avatar seed={session.counterparty_address} label={alias} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-sm font-semibold">{name}</span>
          <span className="amount text-xs text-hint">
            {session.my_role === 'buyer' ? 'Buying' : 'Selling'}{' '}
            {formatAssetAmount(session.rgb_amount, session.asset.precision, session.asset.ticker)}
          </span>
        </div>
        <TrustBadge tier={trust.trust_tier} reliabilityPct={trust.reliability_pct} size="sm" />
      </div>
    </header>
  )
}
