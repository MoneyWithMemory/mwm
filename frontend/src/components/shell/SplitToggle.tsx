import { Columns2, RectangleVertical } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { iconSwap } from '@/lib/motion'

export type Layout = 'single' | 'split'

interface SplitToggleProps {
  layout: Layout
  onToggle: () => void
}

/** Single ↔ split-screen switch; the icon morphs instead of swapping abruptly. */
export function SplitToggle({ layout, onToggle }: SplitToggleProps) {
  const split = layout === 'split'

  return (
    <button
      type="button"
      className="pressable-icon flex items-center gap-1.5 rounded-control bg-surface px-2.5 py-1.5 text-sm font-medium shadow-card"
      onClick={onToggle}
      aria-pressed={split}
    >
      <span className="relative grid size-4 place-items-center" aria-hidden="true">
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={layout} variants={iconSwap} initial="initial" animate="animate" exit="exit" className="grid place-items-center">
            {split ? <RectangleVertical size={16} /> : <Columns2 size={16} />}
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="badge-nowrap">{split ? 'Single view' : 'Split view'}</span>
    </button>
  )
}
