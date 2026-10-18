import { Ban, CircleAlert, Scale, ShieldAlert, TimerOff, type LucideIcon } from 'lucide-react'
import { useWallet, type SessionView } from '@/api'
import { Button, Card, CardContent, TrustBadge } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { ownTrustExplanation, withTrustLabels } from '@/lib/trust'
import { isNoAgreement, isNoOverlap, ownTrustFailure } from '../shared/sessionState'
import { TxidRow } from './TxidRow'

interface Notice {
  icon: LucideIcon
  title: string
  body: string
}

/** Why the gate blocked the session, said from the viewer's side: their own wallet may be the one it refused. */
function blockedNotice(session: SessionView): Notice {
  const reasons = session.gate?.reasons
  if (isNoOverlap(reasons)) {
    return {
      icon: Scale,
      title: 'No deal at these limits',
      body:
        session.my_role === 'buyer'
          ? 'Your maximum is below what this seller accepts, so the agents did not start. No funds moved.'
          : "The buyer's maximum is below your minimum, so the agents did not start. No funds moved.",
    }
  }
  // The starter's own tier never blocks: this is a seller whose score fell during the deal, so the
  // check after the agreement refused it (the UI calls every untrusted tier low reliability).
  if (ownTrustFailure(session) !== null) {
    return { icon: ShieldAlert, title: 'Your reliability is too low', body: 'It fell during this deal, so no funds moved.' }
  }
  if (isNoAgreement(reasons)) {
    return { icon: Scale, title: 'No agreement', body: 'The agents could not agree on a price, so no funds moved.' }
  }
  return { icon: ShieldAlert, title: 'Trade blocked', body: 'The safety check did not pass, so no funds moved.' }
}

function noticeFor(session: SessionView): Notice | null {
  switch (session.state) {
    case 'BLOCKED_BY_GATE':
      return blockedNotice(session)
    case 'CANCELLED_BY_USER':
      return { icon: Ban, title: 'Session cancelled', body: 'No funds moved.' }
    case 'FAILED':
      return {
        icon: CircleAlert,
        title: 'Settlement failed',
        body: session.failure?.message ?? 'Something went wrong while settling.',
      }
    case 'EXPIRED':
      return { icon: TimerOff, title: 'Terms expired', body: 'Start a new negotiation to continue.' }
    default:
      return null
  }
}

/** The viewer's own reliability, which the gate refused: its current score, explained for its owner. */
function OwnTrust() {
  const { walletId } = useWalletContext()
  const trust = useWallet(walletId).data?.trust
  if (!trust) return null
  return <TrustBadge tier={trust.trust_tier} reliabilityPct={trust.reliability_pct} explain explanation={ownTrustExplanation(trust.trust_tier)} />
}

export function TerminalNotice({ session }: { session: SessionView }) {
  const { reset, replace } = useWalletContext()
  const notice = noticeFor(session)
  if (!notice) return null
  const Icon = notice.icon
  const blocked = session.state === 'BLOCKED_BY_GATE'
  const noOverlap = blocked && isNoOverlap(session.gate?.reasons)
  const ownBlocked = blocked && ownTrustFailure(session) !== null
  // Any other block: the counterparty's trust and the gate's own reasons.
  const verdict = blocked && !noOverlap && !ownBlocked && !isNoAgreement(session.gate?.reasons)
  const reasons = verdict ? (session.gate?.reasons ?? []) : []

  return (
    <Card>
      <CardContent className="flex flex-col items-start gap-3 pt-4">
        <span className="flex size-10 items-center justify-center rounded-full bg-danger/15 text-danger" aria-hidden="true">
          <Icon size={20} />
        </span>
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">{notice.title}</h2>
          <p className="text-sm text-hint">{notice.body}</p>
        </div>
        {session.state === 'FAILED' && session.txid && (
          <div className="flex w-full flex-col gap-1.5">
            <TxidRow txid={session.txid} label="Broadcast transaction ID" />
            <p className="text-xs text-hint">This transaction was broadcast before the failure. Check it before trying again.</p>
          </div>
        )}
        {ownBlocked && <OwnTrust />}
        {verdict && (
          <TrustBadge tier={session.counterparty_trust.trust_tier} reliabilityPct={session.counterparty_trust.reliability_pct} explain />
        )}
        {reasons.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {reasons.map((reason) => (
              <li key={reason} className="select-text">
                {withTrustLabels(reason)}
              </li>
            ))}
          </ul>
        )}
        {noOverlap && session.my_role === 'buyer' ? (
          <div className="flex w-full gap-2 pt-1">
            <Button variant="secondary" fullWidth onClick={() => reset('shop')}>
              Find another offer
            </Button>
            <Button fullWidth trailingArrow onClick={() => replace('trade', { counterpartyId: session.counterparty_address })}>
              Change my limits
            </Button>
          </div>
        ) : (
          <div className="flex w-full gap-2 pt-1">
            <Button variant="secondary" fullWidth onClick={() => reset('wallet')}>
              Back to Wallet
            </Button>
            {ownBlocked ? (
              <Button fullWidth trailingArrow onClick={() => reset('contacts')}>
                Your reliability
              </Button>
            ) : (
              <Button fullWidth onClick={() => reset('shop')}>
                Find another deal
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
