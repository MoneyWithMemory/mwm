import { Brain, Lock, X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useId, useState, type ReactNode } from 'react'
import type { Role } from '@/api'
import { IconSwap } from '@/components/ui'
import { cn } from '@/lib/cn'
import { accordion } from '@/lib/motion'

/** The reasoning itself. The API never returns the counterparty's. */
export function ThoughtPanel({ thought, className }: { thought: string; className?: string }) {
  return (
    <div className={cn('flex flex-col gap-1 rounded-control border border-dashed border-separator bg-surface-muted/50 p-3', className)}>
      <span className="flex items-center gap-1.5 text-[11px] font-medium text-hint">
        <Lock size={11} aria-hidden="true" />
        Only you can see this
      </span>
      <p className="select-text text-xs leading-relaxed text-fg/90">{thought}</p>
    </div>
  )
}

interface PrivateThoughtProps {
  thought: string | null
  /** The column the offer sits in: the icon goes on its inner side, the panel opens under it. */
  side: Role
  /** The offer bubble the thought belongs to. */
  children: ReactNode
}

/**
 * Your agent's private reasoning for one round, folded into an icon next to its offer: it takes no
 * room until asked for, then opens under the bubble.
 */
export function PrivateThought({ thought, side, children }: PrivateThoughtProps) {
  const [open, setOpen] = useState(false)
  const panelId = useId()
  if (!thought) return children

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', side === 'buyer' ? 'items-start' : 'items-end')}>
      <div className={cn('flex max-w-full items-center gap-1.5', side === 'seller' && 'flex-row-reverse')}>
        {children}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          aria-label={open ? 'Hide private reasoning' : 'Show private reasoning'}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'pressable-icon relative flex size-7 shrink-0 items-center justify-center rounded-full outline-none before:absolute before:-inset-2 focus-visible:ring-2 focus-visible:ring-accent',
            open ? 'bg-accent/15 text-accent' : 'bg-surface-muted text-hint hover:text-fg',
          )}
        >
          <IconSwap iconKey={open ? 'open' : 'closed'}>
            {open ? <X size={13} aria-hidden="true" /> : <Brain size={13} aria-hidden="true" />}
          </IconSwap>
        </button>
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={panelId}
            key="thought"
            variants={accordion}
            initial="initial"
            animate="animate"
            exit="exit"
            className="w-[17rem] max-w-full overflow-hidden"
          >
            <ThoughtPanel thought={thought} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
