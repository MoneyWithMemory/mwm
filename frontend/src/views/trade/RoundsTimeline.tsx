import { AnimatePresence, motion } from 'motion/react'
import type { Role, Round } from '@/api'
import { Badge, Card, CardContent, CardHeader, CardTitle } from '@/components/ui'
import { formatUsd } from '@/lib/format'
import { listItem } from '@/lib/motion'
import { PrivateThought } from './PrivateThought'

interface RoundsTimelineProps {
  rounds: Round[]
  myRole: Role
  counterpartyName: string
  /** The backend's round cap, shown as "Round 3 of 10". */
  maxRounds?: number
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

/** Newest round first, so the live one stays in view as negotiations grow longer. */
export function RoundsTimeline({ rounds, myRole, counterpartyName, maxRounds }: RoundsTimelineProps) {
  const buyerLabel = myRole === 'buyer' ? 'You' : counterpartyName
  const sellerLabel = myRole === 'seller' ? 'You' : counterpartyName

  return (
    <section className="flex flex-col gap-2" aria-label="Negotiation rounds">
      <h2 className="px-1 text-sm font-semibold text-hint">Negotiation</h2>
      <AnimatePresence initial={false}>
        {[...rounds].reverse().map((round) => (
          <motion.div key={round.n} layout variants={listItem} initial="initial" animate="animate">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">
                  Round {round.n}
                  {maxRounds ? <span className="font-normal text-hint"> of {maxRounds}</span> : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <OfferRow
                  who={`${buyerLabel} (buyer)`}
                  offer={round.buyer_offer_usd}
                  accepted={round.buyer_action === 'ACCEPT'}
                  message={round.public_messages.buyer}
                />
                <OfferRow
                  who={`${sellerLabel} (seller)`}
                  offer={round.seller_offer_usd}
                  accepted={round.seller_action === 'ACCEPT'}
                  message={round.public_messages.seller}
                />
                <PrivateThought thought={round.my_private_thought} />
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </AnimatePresence>
    </section>
  )
}
