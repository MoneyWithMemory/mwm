import { ChevronRight } from 'lucide-react'
import { useSessions } from '@/api'
import { Avatar, Badge, Card, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { formatAssetAmount, formatUsd, shortAddress } from '@/lib/format'
import { useWalletContext } from '@/lib/navigation'
import { SESSION_STATE_LABEL, SESSION_STATE_VARIANT } from '../shared/sessionState'

export function IncomingSessions({ aliases }: { aliases: Record<string, string> }) {
  const { walletId, navigate } = useWalletContext()
  const sessions = useSessions(walletId)

  const incoming = (sessions.data ?? [])
    .filter((s) => s.my_role === 'seller')
    .sort((a, b) => b.updated_at - a.updated_at)

  let body
  if (!sessions.data && sessions.error) {
    return (
      <Section>
        <ErrorState
          className="rounded-card bg-surface shadow-card"
          title="Couldn't load sessions"
          message="Check your connection and try again."
          onRetry={sessions.refresh}
        />
      </Section>
    )
  }
  if (!sessions.data) {
    body = (
      <div className="flex flex-col gap-2" role="status" aria-label="Loading sessions">
        {[0, 1].map((i) => (
          <Skeleton key={i} className="h-16 rounded-card" />
        ))}
      </div>
    )
  } else if (incoming.length === 0) {
    body = (
      <EmptyState
        className="rounded-card bg-surface shadow-card"
        title="No incoming sessions"
        description="When a buyer opens a negotiation with you, it appears here."
      />
    )
  } else {
    body = (
      <ul className="flex flex-col gap-2">
        {incoming.map((s) => {
          const name = aliases[s.counterparty_address] ?? shortAddress(s.counterparty_address)
          return (
            <li key={s.session_id}>
              <Card
                className="flex items-center gap-3 p-3"
                onClick={() => navigate('trade', { sessionId: s.session_id })}
                aria-label={`Open session with ${name}`}
              >
                <Avatar seed={s.counterparty_address} label={aliases[s.counterparty_address]} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-semibold">{name}</span>
                  <span className="amount text-xs text-hint">
                    {formatAssetAmount(s.rgb_amount, s.asset.precision, s.asset.ticker)}
                    {s.agreed_price_usd !== null && ` · ${formatUsd(s.agreed_price_usd)}`}
                  </span>
                </div>
                <Badge variant={SESSION_STATE_VARIANT[s.state]}>{SESSION_STATE_LABEL[s.state]}</Badge>
                <ChevronRight size={16} className="shrink-0 text-hint" aria-hidden="true" />
              </Card>
            </li>
          )
        })}
      </ul>
    )
  }

  return <Section>{body}</Section>
}

function Section({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Incoming sessions">
      <h2 className="px-1 text-sm font-semibold text-hint">Incoming sessions</h2>
      {children}
    </section>
  )
}
