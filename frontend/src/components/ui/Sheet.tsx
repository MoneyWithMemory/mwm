import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { backdrop, sheet } from '@/lib/motion'
import { useOverlayRoot } from '@/lib/overlay'

interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
}

/**
 * Bottom sheet: opens in 250ms from scale 0.96, closes in 150ms, origin bottom.
 * Must be inside an <OverlayLayer> and covers it (its pane in split view). Escape and the
 * backdrop close it; focus moves in on open and returns to the trigger on close.
 */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const root = useOverlayRoot()
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const close = useEffectEvent(onClose)

  useEffect(() => {
    if (!open) return
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      trigger?.focus()
    }
  }, [open])

  const content = (
    <AnimatePresence>
      {open && (
        <div key="sheet" className="absolute inset-0 flex flex-col justify-end">
          <motion.div
            className="absolute inset-0 bg-overlay"
            variants={backdrop}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            className="relative max-h-[85%] origin-bottom overflow-y-auto overscroll-contain rounded-t-sheet bg-surface pb-[env(safe-area-inset-bottom)] shadow-overlay outline-none"
            variants={sheet}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-2">
              <h2 id={titleId} className="text-base font-semibold">
                {title}
              </h2>
              <button
                type="button"
                className="pressable-icon pressable-flat -mr-1.5 rounded-full p-1.5 text-hint"
                onClick={onClose}
                aria-label="Close"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="px-4 pb-4">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )

  // The host exists after OverlayLayer's first commit; until then there is nothing to show.
  return root ? createPortal(content, root) : null
}
