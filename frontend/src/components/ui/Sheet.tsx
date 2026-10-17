import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useEffectEvent, useId, useRef, useState, type ReactNode, type UIEvent } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'
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
 * Fixed header with title and 44x44px close button, subtle border appearing only when
 * body content is scrolled. Scroll container is isolated to the body (overflow-y-auto,
 * overscroll-contain). Focus uses preventScroll: true to eliminate frame-0 scroll jumps.
 * Must be inside an <OverlayLayer> and covers it (its pane in split view). Escape and the
 * backdrop close it; focus moves in on open and returns to the trigger on close.
 */
export function Sheet({ open, onClose, title, children }: SheetProps) {
  const root = useOverlayRoot()

  const content = (
    <AnimatePresence>
      {open && (
        <SheetPanel onClose={onClose} title={title}>
          {children}
        </SheetPanel>
      )}
    </AnimatePresence>
  )

  // The host exists after OverlayLayer's first commit; until then there is nothing to show.
  return root ? createPortal(content, root) : null
}

interface SheetPanelProps {
  onClose: () => void
  title: string
  children: ReactNode
}

function SheetPanel({ onClose, title, children }: SheetPanelProps) {
  const titleId = useId()
  const panelRef = useRef<HTMLDivElement>(null)
  const [isScrolled, setIsScrolled] = useState(false)
  const close = useEffectEvent(onClose)

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    panelRef.current?.focus({ preventScroll: true })
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      trigger?.focus({ preventScroll: true })
    }
  }, [])

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const scrolled = event.currentTarget.scrollTop > 2
    if (scrolled !== isScrolled) {
      setIsScrolled(scrolled)
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col justify-end">
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
        className="relative flex max-h-[85%] origin-bottom flex-col overflow-hidden rounded-t-sheet bg-surface shadow-overlay outline-none will-change-transform"
        variants={sheet}
        initial="initial"
        animate="animate"
        exit="exit"
      >
        {/* Fixed Header: title and X close button, border visible only on scroll */}
        <div
          className={cn(
            'flex shrink-0 items-center justify-between gap-3 border-b bg-surface px-4 pt-4 pb-2 transition-colors duration-150',
            isScrolled ? 'border-separator' : 'border-transparent'
          )}
        >
          <h2 id={titleId} className="text-base font-semibold">
            {title}
          </h2>
          <button
            type="button"
            className="pressable-icon pressable-flat -mr-2.5 inline-flex size-11 min-h-[44px] min-w-[44px] items-center justify-center rounded-full text-hint hover:text-fg outline-none focus-visible:ring-2 focus-visible:ring-accent-cool"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        {/* Scrollable Body: only this element scrolls */}
        <div
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4"
          style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom, 0px))' }}
          onScroll={handleScroll}
        >
          {children}
        </div>
      </motion.div>
    </div>
  )
}

