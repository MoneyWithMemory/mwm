import { Ban, CircleAlert, ShieldAlert, TimerOff, type LucideIcon } from 'lucide-react'
import type { SessionView } from '@/api'
import { Button, Card, CardContent, TrustBadge } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { TxidRow } from './TxidRow'

interface Notice {
  icon: LucideIcon
  title: string
  body: string
}

function noticeFor(session: SessionView): Notice | null {
  switch (session.state) {
    case 'BLOCKED_BY_GATE':
      return {
        icon: ShieldAlert,
        title: 'Trade blocked',
        body: 'The safety check did not pass, so no funds moved.',
      }
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

export function TerminalNotice({ session }: { session: SessionView }) {
  const { reset } = useWalletContext()
  const notice = noticeFor(session)
  if (!notice) return null
  const Icon = notice.icon
  const reasons = session.state === 'BLOCKED_BY_GATE' ? (session.gate?.reasons ?? []) : []

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
        {session.state === 'BLOCKED_BY_GATE' && (
          <TrustBadge tier={session.counterparty_trust.trust_tier} reliabilityPct={session.counterparty_trust.reliability_pct} />
        )}
        {reasons.length > 0 && (
          <ul className="flex flex-col gap-1 text-sm">
            {reasons.map((reason) => (
              <li key={reason} className="select-text">
                {reason}
              </li>
            ))}
          </ul>
        )}
        <div className="flex w-full gap-2 pt-1">
          <Button variant="secondary" fullWidth onClick={() => reset('wallet')}>
            Back to Wallet
          </Button>
          <Button fullWidth onClick={() => reset('shop')}>
            Find another deal
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
