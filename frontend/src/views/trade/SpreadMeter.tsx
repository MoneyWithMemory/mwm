import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { Role, SessionView } from '@/api'
import { Toggle } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatUsd } from '@/lib/format'
import { DUR, EASE_OUT, LOOP, SPRING_GLIDE, textSwap } from '@/lib/motion'
import { currentRound, standing } from './negotiation'

interface SpreadMeterProps {
  session: SessionView
  names: Record<Role, string>
  detailed: boolean
  onDetailedChange: (detailed: boolean) => void
  className?: string
}

/** Swaps a short label in place (text swap), so a new value reads as a change, not a jump. */
function Swap({ value, className }: { value: string; className?: string }) {
  return (
    <span className={cn('relative block h-5 overflow-hidden', className)}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={value} className="block truncate" variants={textSwap} initial="initial" animate="animate" exit="exit">
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}

function End({ name, price, mine, align }: { name: string; price: string | null; mine: boolean; align: 'start' | 'end' }) {
  return (
    <div className={cn('flex min-w-0 flex-1 flex-col', align === 'end' ? 'items-end text-right' : 'items-start')}>
      <span className={cn('max-w-full truncate text-[11px] font-medium', mine ? 'text-accent' : 'text-hint')}>{name}</span>
      {price !== null && <Swap value={price} className="amount max-w-full text-sm font-semibold" />}
    </div>
  )
}

/**
 * The scoreboard over the chat: where each agent stands, as two markers gliding toward each
 * other on one track, and the gap left between them. When they meet, the markers merge and
 * pulse. Also holds the switch to the detailed view.
 */
export function SpreadMeter({ session, names, detailed, onDetailedChange, className }: SpreadMeterProps) {
  const reduce = useReducedMotion()
  const { bid, ask, deal, low, high } = standing(session)
  const negotiating = session.state === 'NEGOTIATING'
  const mine = session.my_role
  const met = deal !== null

  // Track scale: every price seen so far, with some air at both ends.
  const pad = Math.max((high - low) * 0.12, 1)
  const at = (price: number) => (high < low ? 50 : ((price - low + pad) / (high - low + 2 * pad)) * 100)
  const left = deal ?? bid
  const right = deal ?? ask
  const glide = reduce ? { duration: 0 } : SPRING_GLIDE

  const status = met
    ? 'Deal reached'
    : negotiating
      ? `Round ${currentRound(session)}${session.max_rounds ? ` of ${session.max_rounds}` : ''}`
      : 'No deal'
  const middle = met ? formatUsd(deal) : bid !== null && ask !== null ? `${formatUsd(Math.max(ask - bid, 0))} apart` : ''

  return (
    <section
      aria-label="Where the agents stand"
      className={cn('surface-glass flex flex-col gap-2.5 rounded-card px-4 pt-2.5 pb-3 shadow-card', className)}
    >
      <div className="flex items-center justify-between gap-3">
        <Swap value={status} className={cn('min-w-0 text-xs font-medium', met ? 'text-success' : 'text-hint')} />
        <Toggle checked={detailed} onChange={onDetailedChange} label="Details" />
      </div>

      <div className="relative mx-1.5 h-3.5" aria-hidden="true">
        <span className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-surface-raised" />
        {left !== null && right !== null && (
          <motion.span
            className={cn(
              'absolute top-1/2 h-1 -translate-y-1/2 rounded-full',
              met ? 'bg-success/60' : mine === 'buyer' ? 'bg-gradient-to-r from-accent/60 to-fg/40' : 'bg-gradient-to-r from-fg/40 to-accent/60',
            )}
            initial={false}
            animate={{ left: `${at(left)}%`, width: `${Math.max(at(right) - at(left), 0)}%` }}
            transition={glide}
          />
        )}
        {(['buyer', 'seller'] as const).map((side) => {
          const price = side === 'buyer' ? left : right
          if (price === null) return null
          return (
            <motion.span
              key={side}
              className={cn(
                'absolute top-0 -ml-[7px] size-3.5 rounded-full border-2 border-surface transition-colors duration-fast ease-smooth-out',
                met ? 'bg-success' : side === mine ? 'bg-accent' : 'bg-fg',
              )}
              initial={false}
              animate={{ left: `${at(price)}%` }}
              transition={glide}
            />
          )
        })}
        {met && !reduce && (
          <motion.span
            key="met"
            className="absolute top-0 -ml-[7px] size-3.5 rounded-full border border-success"
            style={{ left: `${at(deal)}%` }}
            initial={{ scale: 1, opacity: 0.8 }}
            animate={{ scale: 2.6, opacity: 0 }}
            transition={{ duration: LOOP.pulse, ease: EASE_OUT, repeat: 2, delay: DUR.open }}
          />
        )}
      </div>

      <div className="flex items-end gap-3">
        <End name={names.buyer} price={met ? null : bid === null ? '—' : formatUsd(bid)} mine={mine === 'buyer'} align="start" />
        <Swap value={middle} className={cn('amount shrink-0 text-center text-xs', met ? 'font-semibold text-success' : 'text-hint')} />
        <End name={names.seller} price={met ? null : ask === null ? '—' : formatUsd(ask)} mine={mine === 'seller'} align="end" />
      </div>
    </section>
  )
}
