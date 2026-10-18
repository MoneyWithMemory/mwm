import { PenLine } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { CANCELLABLE_STATES, useCancel, useSession, useSign, useWallets, type SessionView } from '@/api'
import { ApprovalCard, Button, EmptyState, ErrorState, Skeleton, toast } from '@/components/ui'
import { cn } from '@/lib/cn'
import { viewSwap } from '@/lib/motion'
import { useWalletContext } from '@/lib/navigation'
import { useCounterpartyName } from '../shared/useCounterpartyName'
import { CounterpartySignSheet } from './CounterpartySignSheet'
import { DetailedFlow } from './DetailedFlow'
import { NegotiationChat } from './NegotiationChat'
import { SessionHeader } from './SessionHeader'
import { SettlementPanel } from './SettlementPanel'
import { SpreadMeter } from './SpreadMeter'
import { TerminalNotice } from './TerminalNotice'
import { sideNames, toMessages } from './negotiation'

/** Within this distance of the bottom the user is following the chat, and new offers scroll into view. */
const FOLLOW_ZONE_PX = 160

function SessionSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading session">
      <Skeleton className="h-11 w-56" />
      <Skeleton className="h-20 rounded-card" />
      <Skeleton className="ml-0 h-12 w-40 rounded-card" />
      <Skeleton className="ml-auto h-12 w-40 rounded-card" />
    </div>
  )
}

function scrollerOf(element: HTMLElement | null): HTMLElement | null {
  return element?.closest<HTMLElement>('.overflow-y-auto') ?? null
}

/**
 * Keeps the newest offer in view while the user follows along at the bottom of the pane; someone
 * who scrolled up to read is never pulled back down. A live negotiation opens at its newest offer.
 */
function useFollowNewest(rootRef: RefObject<HTMLElement | null>, key: string, startAtNewest: boolean) {
  const reduce = useReducedMotion()
  const following = useRef(false)
  const startRef = useRef(startAtNewest)
  const lastKey = useRef(key)

  useEffect(() => {
    const scroller = scrollerOf(rootRef.current)
    if (!scroller) return
    const update = () => {
      following.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_ZONE_PX
    }
    // Only on a fresh page: a scroll position the pane restored (Back, wallet switch) wins.
    if (startRef.current && scroller.scrollTop === 0) scroller.scrollTop = scroller.scrollHeight
    update()
    scroller.addEventListener('scroll', update, { passive: true })
    return () => scroller.removeEventListener('scroll', update)
  }, [rootRef])

  useEffect(() => {
    if (lastKey.current === key) return
    lastKey.current = key
    const scroller = scrollerOf(rootRef.current)
    if (scroller && following.current) scroller.scrollTo({ top: scroller.scrollHeight, behavior: reduce ? 'auto' : 'smooth' })
  }, [key, reduce, rootRef])
}

function SessionBody({ session, walletId, connectionLost }: { session: SessionView; walletId: string; connectionLost: boolean }) {
  const wallets = useWallets()
  const counterpartyName = useCounterpartyName(walletId)
  const sign = useSign()
  const cancel = useCancel()
  const [counterpartySignOpen, setCounterpartySignOpen] = useState(false)
  const [detailed, setDetailed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const messages = useMemo(() => toMessages(session), [session])
  const negotiating = session.state === 'NEGOTIATING'
  useFollowNewest(rootRef, `${messages.length}:${session.thinking}:${session.state}`, negotiating && messages.length > 0)

  const { name, alias } = counterpartyName(session.counterparty_address)
  const names = sideNames(session.my_role, name)
  const mySigned = session.my_role === 'buyer' ? session.buyer_signed : session.seller_signed
  const counterpartySigned = session.my_role === 'buyer' ? session.seller_signed : session.buyer_signed
  const cancellable = CANCELLABLE_STATES.includes(session.state)
  // Demo: when the other side's wallet is on this device too, it can sign from here.
  const localCounterparty = wallets.data?.find((w) => w.address === session.counterparty_address && w.wallet_id !== walletId)
  const myLabel = wallets.data?.find((w) => w.wallet_id === walletId)?.label
  const hasNegotiation = session.rounds.length > 0 || negotiating

  const onCancel = () => {
    cancel.run(session.session_id, walletId).catch((err: Error) => toast(err.message, { type: 'danger' }))
  }
  const onSign = () => {
    if (!session.terms_hash) return
    sign.run(session.session_id, walletId, session.terms_hash).catch((err: Error) => toast(err.message, { type: 'danger' }))
  }

  let phase: string
  let main: ReactNode
  switch (session.state) {
    case 'NEGOTIATING':
      phase = 'negotiating'
      main = cancellable && (
        <Button variant="ghost" size="sm" loading={cancel.pending} onClick={onCancel} className="self-center text-hint hover:text-danger">
          Cancel negotiation
        </Button>
      )
      break
    case 'AWAITING_SIGNATURES':
      phase = 'approval'
      main = session.terms && (
        <ApprovalCard
          terms={session.terms}
          termsHash={session.terms_hash}
          assetTicker={session.asset.ticker}
          paymentTicker={session.payment_asset.ticker}
          myRole={session.my_role}
          mySigned={mySigned}
          counterpartySigned={counterpartySigned}
          counterpartyLabel={name}
          detailed={detailed}
          signing={sign.pending}
          cancelling={cancel.pending}
          onSign={onSign}
          onCancel={cancellable ? onCancel : undefined}
          waitingAction={
            localCounterparty && (
              <Button variant="secondary" size="lg" fullWidth onClick={() => setCounterpartySignOpen(true)}>
                <PenLine size={16} aria-hidden="true" />
                Sign as {localCounterparty.label}
              </Button>
            )
          }
        />
      )
      break
    case 'SETTLING':
    case 'SETTLED':
      phase = 'settlement'
      main = <SettlementPanel session={session} detailed={detailed} />
      break
    default:
      phase = 'closed'
      main = <TerminalNotice session={session} />
  }

  return (
    <div ref={rootRef} className="flex flex-col justify-start gap-3 p-4">
      <SessionHeader session={session} name={name} alias={alias} />
      <p className="-my-1 min-h-4 text-xs text-warning" role="status">
        {connectionLost ? 'Connection lost. Retrying…' : ''}
      </p>

      {hasNegotiation && (
        <>
          <SpreadMeter
            session={session}
            names={names}
            detailed={detailed}
            onDetailedChange={setDetailed}
            className={cn(negotiating && 'sticky top-2 z-10')}
          />
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={detailed ? 'detailed' : 'chat'} variants={viewSwap} initial="initial" animate="animate" exit="exit">
              {detailed ? (
                <DetailedFlow session={session} names={names} />
              ) : (
                <NegotiationChat session={session} messages={messages} names={names} />
              )}
            </motion.div>
          </AnimatePresence>
        </>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={phase} variants={viewSwap} initial="initial" animate="animate" exit="exit" className="flex flex-col">
          {main}
        </motion.div>
      </AnimatePresence>

      {localCounterparty && (
        <CounterpartySignSheet
          open={counterpartySignOpen}
          onClose={() => setCounterpartySignOpen(false)}
          sessionId={session.session_id}
          counterparty={localCounterparty}
          otherLabel={myLabel}
        />
      )}
    </div>
  )
}

/**
 * A deal, as a chat between the two agents: the scoreboard on top, the offers arriving from each
 * side, then the one thing to do next (sign, wait, done). "Details" swaps in the full flow.
 */
export function SessionPanel({ sessionId, walletId }: { sessionId: string; walletId: string }) {
  const { reset } = useWalletContext()
  const sessionPoll = useSession(sessionId, walletId)
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
          <ErrorState title="Couldn't load this session" message="Check your connection and try again." onRetry={sessionPoll.refresh} />
        ) : (
          <SessionSkeleton />
        )}
      </div>
    )
  }

  return <SessionBody session={session} walletId={walletId} connectionLost={Boolean(sessionPoll.error)} />
}
