import { Lock } from 'lucide-react'
import { motion } from 'motion/react'
import { fade } from '@/lib/motion'

/** The wallet's own agent reasoning for one round. The API never returns the counterparty's. */
export function PrivateThought({ thought }: { thought: string | null }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-control bg-surface-muted/60 p-3">
      <span className="flex items-center gap-1.5 text-xs font-medium text-hint">
        <Lock size={12} aria-hidden="true" />
        Your agent&apos;s private reasoning
      </span>
      <motion.p
        key={thought ?? 'empty'}
        className="select-text text-sm leading-relaxed"
        variants={fade}
        initial="initial"
        animate="animate"
      >
        {thought ?? <span className="text-hint">No reasoning recorded for this round yet.</span>}
      </motion.p>
      <span className="text-[11px] text-hint">Only you can see this.</span>
    </div>
  )
}
