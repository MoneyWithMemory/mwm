import { ChevronRight } from 'lucide-react'
import { TERMINAL_STATES, useSessions, useWallet, type SessionSummary } from '@/api'
import { Avatar, Badge, Button, EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { formatAssetAmount, formatUsd, shortAddress } from '@/lib/format'
import { useWalletContext } from '@/lib/navigation'
import { SESSION_STATE_LABEL, SESSION_STATE_VARIANT } from '../shared/sessionState'

function DealRow({ deal, name, alias, onOpen }: { deal: SessionSummary; name: string; alias?: string; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        className="pressable pressable-flat flex w-full items-center gap-3 p-3 text-left"
        onClick={onOpen}
        aria-label={`Open deal with ${name}`}
      >
        <Avatar seed={deal.counterparty_address} label={alias} size="lg" />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold">{name}</span>
            <Badge variant="outline" size="sm">
              {deal.my_role === 'buyer' ? 'Buying' : 'Selling'}
            </Badge>
          </span>
          <span className="amount text-xs text-hint">
            {formatAssetAmount(deal.rgb_amount, deal.asset.precision, deal.asset.ticker)}
            {deal.agreed_price_usd !== null && ` · ${formatUsd(deal.agreed_price_usd)}`}
          </span>
        </span>
        <Badge variant={SESSION_STATE_VARIANT[deal.state]}>{SESSION_STATE_LABEL[deal.state]}</Badge>
        <ChevronRight size={16} className="shrink-0 text-hint" aria-hidden="true" />
      </button>
    </li>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h2 className="px-1 text-sm font-semibold text-hint">{title}</h2>
      <ul className="flex flex-col divide-y divide-separator rounded-card bg-surface shadow-card">{children}</ul>
    </section>
  )
}

/** Every negotiation this wallet is in, as buyer or seller. Starting one happens in the Shop. */
export function DealsView() {
  const { walletId, navigate, reset } = useWalletContext()
  const sessions = useSessions(walletId)
  const wallet = useWallet(walletId)

  const deals = [...(sessions.data ?? [])].sort((a, b) => b.updated_at - a.updated_at)
  const inProgress = deals.filter((d) => !TERMINAL_STATES.includes(d.state))
  const finished = deals.filter((d) => TERMINAL_STATES.includes(d.state))
  const aliases = wallet.data?.local_aliases ?? {}

  const row = (deal: SessionSummary) => {
    const alias = aliases[deal.counterparty_address]
    return (
      <DealRow
        key={deal.session_id}
        deal={deal}
        name={alias ?? shortAddress(deal.counterparty_address)}
        alias={alias}
        onOpen={() => navigate('trade', { sessionId: deal.session_id })}
      />
    )
  }

  let body
  if (sessions.data && deals.length === 0) {
    body = (
      <EmptyState
        className="rounded-card bg-surface shadow-card"
        title="No deals yet"
        description="Start one from the Shop: buy an offer, sell yours, or let your agent search."
        action={
          <Button trailingArrow onClick={() => reset('shop')}>
            Open the Shop
          </Button>
        }
      />
    )
  } else if (sessions.data) {
    body = (
      <>
        {inProgress.length > 0 && <Section title="In progress">{inProgress.map(row)}</Section>}
        {finished.length > 0 && <Section title="Finished">{finished.map(row)}</Section>}
      </>
    )
  } else if (sessions.error) {
    body = <ErrorState title="Couldn't load your deals" message="Check your connection and try again." onRetry={sessions.refresh} />
  } else {
    body = (
      <div className="flex flex-col gap-2" role="status" aria-label="Loading deals">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[72px] rounded-card" />
        ))}
      </div>
    )
  }

  return (
    <div className="@container">
      <div className="flex flex-col justify-start gap-5 p-4 @4xl:p-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Deals</h1>
          <p className="text-sm text-hint">Every negotiation you are in, as buyer or seller.</p>
        </header>
        {body}
      </div>
    </div>
  )
}
