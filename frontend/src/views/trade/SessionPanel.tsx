import { PenLine, ShieldCheck } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { CANCELLABLE_STATES, useCancel, useSession, useSign, useWallets } from '@/api'
import { ApprovalCard, Button, EmptyState, ErrorState, Skeleton, ThinkingState, toast } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { useCounterpartyName } from '../shared/useCounterpartyName'
import { CounterpartySignSheet } from './CounterpartySignSheet'
import { RoundsTimeline } from './RoundsTimeline'
import { SessionHeader } from './SessionHeader'
import { SettlementPanel } from './SettlementPanel'
import { TerminalNotice } from './TerminalNotice'

function SessionSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading session">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-16 rounded-card" />
      <Skeleton className="h-48 rounded-card" />
      <Skeleton className="h-40 rounded-card" />
    </div>
  )
}

export function SessionPanel({ sessionId, walletId }: { sessionId: string; walletId: string }) {
  const { reset } = useWalletContext()
  const sessionPoll = useSession(sessionId, walletId)
  const wallets = useWallets()
  const counterpartyName = useCounterpartyName(walletId)
  const sign = useSign()
  const cancel = useCancel()
  const [counterpartySignOpen, setCounterpartySignOpen] = useState(false)
  const session = sessionPoll.data

  if (!session) {
    return (
      <div className="flex flex-col justify-start p-4">
        {sessionPoll.error?.status === 403 ? (
          <EmptyState
            title="This deal is not yours"
            description="Only the buyer and the seller can open it."
            action={<Button onClick={() => reset('deals')}>Back to Deals</Button>}
          />
        ) : sessionPoll.error ? (
          <ErrorState
            title="Couldn't load this session"
            message="Check your connection and try again."
            onRetry={sessionPoll.refresh}
          />
        ) : (
          <SessionSkeleton />
        )}
      </div>
    )
  }

  const { name, alias } = counterpartyName(session.counterparty_address)
  const mySigned = session.my_role === 'buyer' ? session.buyer_signed : session.seller_signed
  const counterpartySigned = session.my_role === 'buyer' ? session.seller_signed : session.buyer_signed
  const cancellable = CANCELLABLE_STATES.includes(session.state)
  // Demo: when the other side's wallet is on this device too, it can sign from here.
  const localCounterparty = wallets.data?.find((w) => w.address === session.counterparty_address && w.wallet_id !== walletId)
  const maxRounds = session.max_rounds
  // The buyer opens each round: while it thinks, the round in progress is the next one.
  const currentRound = session.thinking === 'buyer' ? session.rounds.length + 1 : Math.max(session.rounds.length, 1)

  const onCancel = () => {
    cancel.run(session.session_id, walletId).catch((err: Error) => toast(err.message, { type: 'danger' }))
  }
  const onSign = () => {
    if (!session.terms_hash) return
    sign.run(session.session_id, walletId, session.terms_hash).catch((err: Error) => toast(err.message, { type: 'danger' }))
  }

  let main: ReactNode
  switch (session.state) {
    case 'NEGOTIATING':
      main = (
        <div className="flex flex-col gap-3">
          {session.queue_position ? (
            <ThinkingState
              key="queued"
              statusText="Waiting for the local AI…"
              detail={`${session.queue_position === 1 ? 'Next' : `#${session.queue_position}`} in line · negotiations run one at a time`}
            />
          ) : (
            session.thinking && (
              <ThinkingState
                key={`${session.rounds.length}-${session.thinking}`}
                statusText={session.thinking === session.my_role ? 'Your agent is reasoning…' : 'The other agent is reasoning…'}
                detail={`Round ${currentRound}${maxRounds ? ` of ${maxRounds}` : ''}`}
              />
            )
          )}
          {cancellable && (
            <Button variant="ghost" size="sm" loading={cancel.pending} onClick={onCancel}>
              Cancel session
            </Button>
          )}
        </div>
      )
      break
    case 'AWAITING_SIGNATURES':
      main = session.terms && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-card bg-success/10 p-3 text-sm font-medium text-success">
            <ShieldCheck size={16} aria-hidden="true" />
            Safety check passed
          </div>
          <ApprovalCard
            terms={session.terms}
            termsHash={session.terms_hash}
            assetTicker={session.asset.ticker}
            paymentTicker={session.payment_asset.ticker}
            myRole={session.my_role}
            mySigned={mySigned}
            counterpartySigned={counterpartySigned}
            signing={sign.pending}
            cancelling={cancel.pending}
            onSign={onSign}
            onCancel={cancellable ? onCancel : undefined}
          />
          {mySigned && !counterpartySigned && localCounterparty && (
            <Button variant="secondary" fullWidth onClick={() => setCounterpartySignOpen(true)}>
              <PenLine size={16} aria-hidden="true" />
              Sign as {localCounterparty.label}
            </Button>
          )}
        </div>
      )
      break
    case 'SETTLING':
    case 'SETTLED':
      main = <SettlementPanel session={session} />
      break
    default:
      main = <TerminalNotice session={session} />
  }

  return (
    <div className="flex flex-col justify-start gap-4 p-4">
      <SessionHeader session={session} name={name} alias={alias} />
      <p className="min-h-4 text-xs text-warning" role="status">
        {sessionPoll.error ? 'Connection lost. Retrying…' : ''}
      </p>
      {main}
      {session.rounds.length > 0 && (
        <RoundsTimeline rounds={session.rounds} myRole={session.my_role} counterpartyName={name} maxRounds={maxRounds} />
      )}
      {localCounterparty && (
        <CounterpartySignSheet
          open={counterpartySignOpen}
          onClose={() => setCounterpartySignOpen(false)}
          sessionId={session.session_id}
          counterparty={localCounterparty}
        />
      )}
    </div>
  )
}
