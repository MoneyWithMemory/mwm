import { ChevronDown } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useId, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { DUR, EASE_OUT, accordion } from '@/lib/motion'

export interface DisclosureProps {
  title: string
  /** One-line preview shown while collapsed. */
  summary?: string
  defaultOpen?: boolean
  className?: string
  children: ReactNode
}

/** Collapsible card section (accordion): body grows and shrinks in 250ms, the chevron flips. */
export function Disclosure({ title, summary, defaultOpen = false, className, children }: DisclosureProps) {
  const [open, setOpen] = useState(defaultOpen)
  const bodyId = useId()

  return (
    <div className={cn('rounded-card bg-surface text-fg shadow-card', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((value) => !value)}
        className="pressable pressable-flat flex w-full items-center gap-3 rounded-card px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-semibold">{title}</span>
          {summary && !open && <span className="truncate text-xs text-hint">{summary}</span>}
        </span>
        <motion.span
          animate={{ scaleY: open ? -1 : 1 }}
          transition={{ duration: DUR.open, ease: EASE_OUT }}
          className="inline-flex shrink-0 text-hint"
          aria-hidden="true"
        >
          <ChevronDown size={16} />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id={bodyId}
            key="body"
            variants={accordion}
            initial="initial"
            animate="animate"
            exit="exit"
            className="overflow-hidden"
          >
            <div className="px-4 pb-4">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
