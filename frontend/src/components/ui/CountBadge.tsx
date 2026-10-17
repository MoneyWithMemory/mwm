import { AnimatePresence, motion } from 'motion/react'
import { cn } from '@/lib/cn'
import { badgePop } from '@/lib/motion'

export interface CountBadgeProps {
  count: number
  /** Accessible text, e.g. "2 deals to sign". */
  label: string
  className?: string
}

/**
 * Small count bubble pinned to a trigger's corner (place it inside a `relative` box).
 * Pops in with a soft overshoot, leaves quickly; renders nothing at 0.
 */
export function CountBadge({ count, label, className }: CountBadgeProps) {
  return (
    <AnimatePresence initial={false}>
      {count > 0 && (
        <motion.span
          key="count-badge"
          role="status"
          aria-label={label}
          variants={badgePop}
          initial="initial"
          animate="animate"
          exit="exit"
          className={cn(
            'badge-nowrap pointer-events-none absolute inline-flex h-4 min-w-4 select-none items-center justify-center rounded-full bg-warning px-1 text-[10px] font-semibold leading-none text-on-accent shadow-card',
            className,
          )}
        >
          {count}
        </motion.span>
      )}
    </AnimatePresence>
  )
}
