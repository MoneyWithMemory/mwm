import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { textSwap } from '@/lib/motion'

export interface FormNoteProps {
  /** Shown instead of the hint, in the danger color. */
  error?: string
  children?: ReactNode
  className?: string
}

/**
 * The one line under a group of fields: its first error, else a short hint. Its height is
 * reserved, so nothing below moves when an error appears; an error swaps in, while a hint that
 * updates as you type (e.g. a price) changes in place.
 */
export function FormNote({ error, children, className }: FormNoteProps) {
  return (
    <div className={cn('min-h-4 text-xs leading-4 select-none', className)} aria-live="polite">
      <AnimatePresence mode="wait" initial={false}>
        {error ? (
          <motion.p key={`error:${error}`} variants={textSwap} initial="initial" animate="animate" exit="exit" className="font-medium text-danger">
            {error}
          </motion.p>
        ) : children ? (
          <motion.p key="hint" variants={textSwap} initial="initial" animate="animate" exit="exit" className="text-hint">
            {children}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  )
}
