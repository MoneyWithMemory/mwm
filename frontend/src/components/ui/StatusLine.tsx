import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/cn'
import { textSwap } from '@/lib/motion'

export interface StatusLineProps {
  /** The current step, e.g. "Confirming…". A new text swaps in place. */
  text: string
  className?: string
}

/**
 * Status of work in progress (transitions-dev 28): the line shimmers while a step holds, and the
 * next step swaps in with the text-swap motion. Announced politely to screen readers.
 */
export function StatusLine({ text, className }: StatusLineProps) {
  return (
    <span className={cn('relative inline-grid text-sm font-medium', className)} role="status" aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={text} className="shimmer-text badge-nowrap" data-text={text} variants={textSwap} initial="initial" animate="animate" exit="exit">
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  )
}
