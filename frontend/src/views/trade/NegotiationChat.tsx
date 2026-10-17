import { Check, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import type { Role, SessionView } from '@/api'
import { ThinkingDots } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatAssetAmount, formatUsd } from '@/lib/format'
import { DUR, chatBubble } from '@/lib/motion'
import { PrivateThought } from './PrivateThought'
import type { ChatMessage } from './negotiation'

/** Once the agents are done, the chat folds to the closing exchange; the rest is one tap away. */
const KEPT_AFTER_CLOSE = 2

const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, signDisplay: 'always' })

const sideOf = (role: Role) => (role === 'buyer' ? -1 : 1)

/** The bubble's corner toward its sender flattens into a tail, and that corner is where it grows from. */
const SIDE_STYLE: Record<Role, { row: string; bubble: string }> = {
  buyer: { row: 'justify-start', bubble: 'rounded-bl-md origin-bottom-left' },
  seller: { row: 'justify-end', bubble: 'rounded-br-md origin-bottom-right' },
}

function bubbleTone(mine: boolean, accepted: boolean) {
  if (accepted) return 'bg-success/12 text-fg shadow-[inset_0_0_0_1px_rgb(95_211_154/0.28)]'
  return mine ? 'bg-accent/20 text-fg shadow-[inset_0_0_0_1px_rgb(185_168_246/0.3)]' : 'bg-surface text-fg shadow-card'
}

function Delta({ pct }: { pct: number }) {
  const holds = Math.abs(pct) < 0.05
  return (
    <span className="amount inline-flex items-center rounded-full bg-fg/[0.06] px-1.5 py-px text-[10px] font-medium text-hint">
      {holds ? 'Holds' : `${pct > 0 ? '▲' : '▼'} ${percent.format(pct)}%`}
    </span>
  )
}

function OfferBubble({ message, who, amount, mine }: { message: ChatMessage; who: string; amount: string; mine: boolean }) {
  const { priceUsd, accepted, deltaPct, side } = message
  return (
    <div className={cn('flex min-w-0 flex-col gap-0.5 rounded-card px-3.5 py-2', SIDE_STYLE[side].bubble, bubbleTone(mine, accepted))}>
      <span className="flex items-center gap-2">
        {accepted && <Check size={15} className="shrink-0 text-success" aria-hidden="true" />}
        {priceUsd === null ? (
          <span className="flex items-center gap-1.5 text-sm font-semibold text-hint">
            <X size={14} aria-hidden="true" />
            No deal
          </span>
        ) : (
          <span className="amount select-text text-base font-semibold">{formatUsd(priceUsd)}</span>
        )}
        {deltaPct !== null && <Delta pct={deltaPct} />}
      </span>
      <span className="truncate text-[11px] text-hint">
        {accepted ? `${who} accepted` : who} · <span className="amount">{amount}</span>
      </span>
    </div>
  )
}

function TypingBubble({ side, mine }: { side: Role; mine: boolean }) {
  return (
    <div className={cn('flex h-9 items-center rounded-card px-3.5', SIDE_STYLE[side].bubble, bubbleTone(mine, false))}>
      <ThinkingDots />
    </div>
  )
}

interface NegotiationChatProps {
  session: SessionView
  messages: ChatMessage[]
  names: Record<Role, string>
}

/**
 * The negotiation as a chat between the two agents: the buyer's offers on the left, the seller's
 * on the right, each sliding in from its own side. A bubble carries only who, how much, the
 * price and how far it moved; the words and the reasoning live in the detailed view.
 */
export function NegotiationChat({ session, messages, names }: NegotiationChatProps) {
  const [showAll, setShowAll] = useState(false)
  const amount = formatAssetAmount(session.rgb_amount, session.asset.precision, session.asset.ticker)
  const negotiating = session.state === 'NEGOTIATING'
  const folded = !negotiating && !showAll && messages.length > KEPT_AFTER_CLOSE
  const visible = folded ? messages.slice(-KEPT_AFTER_CLOSE) : messages
  const hidden = messages.length - visible.length
  const typing = negotiating && !session.queue_position ? session.thinking : null

  return (
    <section aria-label="Offers" className="relative flex flex-col gap-2">
      <AnimatePresence initial={false}>
        {folded && (
          <motion.button
            key="show-all"
            type="button"
            onClick={() => setShowAll(true)}
            variants={chatBubble}
            custom={{ side: 0 }}
            initial="initial"
            animate="animate"
            exit="exit"
            className="pressable pressable-flat self-center rounded-full bg-surface-muted px-3 py-1 text-xs font-medium text-hint hover:text-fg"
          >
            {hidden === 1 ? '1 earlier offer' : `${hidden} earlier offers`}
          </motion.button>
        )}
      </AnimatePresence>

      <ol className="relative flex flex-col gap-2">
        <AnimatePresence initial={false} mode="popLayout">
          {visible.map((message, index) => (
            <motion.li
              key={message.id}
              layout="position"
              variants={chatBubble}
              // Unfolding earlier offers cascades them in, oldest first, within ~300ms.
              custom={{ side: sideOf(message.side), delay: showAll ? Math.min(index, 8) * DUR.stagger : 0 }}
              initial="initial"
              animate="animate"
              exit="exit"
              className={cn('flex', SIDE_STYLE[message.side].row)}
            >
              <div className="flex max-w-[82%] min-w-0">
                <PrivateThought thought={message.thought} side={message.side}>
                  <OfferBubble
                    message={message}
                    who={names[message.side]}
                    amount={amount}
                    mine={message.side === session.my_role}
                  />
                </PrivateThought>
              </div>
            </motion.li>
          ))}
          {typing && (
            <motion.li
              key={`typing-${typing}`}
              layout="position"
              variants={chatBubble}
              custom={{ side: sideOf(typing) }}
              initial="initial"
              animate="animate"
              exit="exit"
              className={cn('flex', SIDE_STYLE[typing].row)}
            >
              <TypingBubble side={typing} mine={typing === session.my_role} />
              <span className="sr-only" role="status">
                {typing === session.my_role ? 'Your agent is thinking' : `${names[typing]}'s agent is thinking`}
              </span>
            </motion.li>
          )}
        </AnimatePresence>
      </ol>

      {negotiating && session.queue_position ? (
        <p role="status" className="flex items-center gap-2 self-center rounded-full bg-surface-muted px-3 py-1.5 text-xs text-hint">
          <ThinkingDots />
          {session.queue_position === 1 ? 'Next in line for the local AI' : `#${session.queue_position} in line for the local AI`}
        </p>
      ) : null}
    </section>
  )
}
