import { AnimatePresence, motion } from 'motion/react'
import type { Role, SessionView } from '@/api'
import { Badge, Card, CardContent, CardHeader, CardTitle, ThinkingState } from '@/components/ui'
import { formatUsd } from '@/lib/format'
import { listItem } from '@/lib/motion'
import { ThoughtPanel } from './PrivateThought'
import { currentRound, SIDES } from './negotiation'

interface DetailedFlowProps {
  session: SessionView
  names: Record<Role, string>
}

function OfferRow({ who, offer, accepted, message }: { who: string; offer: number | null; accepted: boolean; message: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-hint">{who}</span>
        <span className="flex items-center gap-2">
          {accepted && <Badge variant="success">Accepted</Badge>}
          <span className="amount text-sm font-semibold">{offer === null ? '—' : formatUsd(offer)}</span>
        </span>
      </div>
      {message && <p className="select-text text-xs leading-relaxed text-fg/80">{message}</p>}
    </div>
  )
}

/**
 * The full negotiation, verbose: every round in order, each agent's own words and your agent's
 * private reasoning. The detailed view swaps it in for the chat; same data, same order.
 */
export function DetailedFlow({ session, names }: DetailedFlowProps) {
  const { rounds, max_rounds: maxRounds } = session
  const queued = session.state === 'NEGOTIATING' && session.queue_position
  const thinking = session.state === 'NEGOTIATING' && !queued ? session.thinking : null

  return (
    <section className="flex flex-col gap-2" aria-label="Negotiation, in detail">
      <AnimatePresence initial={false}>
        {rounds.map((round) => (
          <motion.div key={round.n} layout="position" variants={listItem} initial="initial" animate="animate">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Round {round.n}
                  {maxRounds ? <span className="font-normal text-hint"> of {maxRounds}</span> : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {SIDES.map((side) => (
                  <OfferRow
                    key={side}
                    who={`${names[side]} (${side})`}
                    offer={side === 'buyer' ? round.buyer_offer_usd : round.seller_offer_usd}
                    accepted={(side === 'buyer' ? round.buyer_action : round.seller_action) === 'ACCEPT'}
                    message={round.public_messages[side]}
                  />
                ))}
                {round.my_private_thought && <ThoughtPanel thought={round.my_private_thought} />}
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </AnimatePresence>
      {queued ? (
        <ThinkingState
          key="queued"
          statusText="Waiting for the local AI…"
          detail={`${session.queue_position === 1 ? 'Next' : `#${session.queue_position}`} in line · negotiations run one at a time`}
        />
      ) : (
        thinking && (
          <ThinkingState
            key={`${rounds.length}-${thinking}`}
            statusText={thinking === session.my_role ? 'Your agent is reasoning…' : `${names[thinking]}'s agent is reasoning…`}
            detail={`Round ${currentRound(session)}${maxRounds ? ` of ${maxRounds}` : ''}`}
          />
        )
      )}
    </section>
  )
}
