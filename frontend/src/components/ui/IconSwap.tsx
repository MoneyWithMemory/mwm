import { AnimatePresence, motion } from 'motion/react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { iconSwap } from '@/lib/motion'

interface IconSwapProps {
  children: ReactNode
  /** Unique key for the icon being displayed to trigger exit/enter animation. */
  iconKey: string | number
  className?: string
}

/**
 * Cross-fades two icons in the same slot with blur and scale.
 * Uses AnimatePresence mode="wait" and motion tokens from src/lib/motion.ts.
 */
export function IconSwap({ children, iconKey, className }: IconSwapProps) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={iconKey}
        variants={iconSwap}
        initial="initial"
        animate="animate"
        exit="exit"
        className={cn('inline-flex items-center justify-center shrink-0', className)}
      >
        {children}
      </motion.span>
    </AnimatePresence>
  )
}
