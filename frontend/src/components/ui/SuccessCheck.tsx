import { motion } from 'motion/react'
import { cn } from '@/lib/cn'
import { checkStroke, successCheck } from '@/lib/motion'

/** A completed action (trade settled, both signatures in): the check arrives, then draws itself. */
export function SuccessCheck({ className }: { className?: string }) {
  return (
    <motion.span
      variants={successCheck}
      initial="initial"
      animate="animate"
      className={cn('flex size-14 shrink-0 items-center justify-center rounded-full bg-success/15 text-success', className)}
      aria-hidden="true"
    >
      <svg viewBox="0 0 24 24" className="size-7 overflow-visible" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
        <motion.path d="M20 6 9 17l-5-5" variants={checkStroke} />
      </svg>
    </motion.span>
  )
}
