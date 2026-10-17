import { X } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useEffectEvent, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { backdrop, modal } from '@/lib/motion'
import { useOverlayRoot } from '@/lib/overlay'
import { cn } from '@/lib/cn'

interface ModalProps {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  className?: string
  /** Hide the top close button if a custom footer or action handles closing. */
  hideCloseButton?: boolean
}

/**
 * Centered modal dialog: scales up from 0.96 in 250ms on open, scales down in 150ms on close.
 * Origin center, zero layout shift. Portals into the local <OverlayLayer> (or document.body).
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  className,
  hideCloseButton = false,
}: ModalProps) {
  const overlayRoot = useOverlayRoot()
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
        <div key="modal-container" className="absolute inset-0 z-50 flex items-center justify-center p-4">
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
            aria-labelledby={title ? titleId : undefined}
            tabIndex={-1}
            className={cn(
              'relative z-10 w-full max-w-sm sm:max-w-md origin-center rounded-card bg-surface shadow-overlay outline-none overflow-hidden border border-separator/40',
              className
            )}
            variants={modal}
            initial="initial"
            animate="animate"
            exit="exit"
          >
            {title ? (
              <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-2 border-b border-separator/20">
                <h2 id={titleId} className="text-base font-semibold text-fg">
                  {title}
                </h2>
                {!hideCloseButton && (
                  <button
                    type="button"
                    className="pressable-icon pressable-flat -mr-1.5 rounded-full p-1.5 text-hint hover:text-fg"
                    onClick={onClose}
                    aria-label="Close"
                  >
                    <X size={18} aria-hidden="true" />
                  </button>
                )}
              </div>
            ) : !hideCloseButton ? (
              <div className="absolute top-3 right-3 z-20">
                <button
                  type="button"
                  className="pressable-icon pressable-flat rounded-full p-1.5 text-hint hover:text-fg"
                  onClick={onClose}
                  aria-label="Close"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </div>
            ) : null}
            <div className="p-5">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )

  const host = overlayRoot ?? (typeof document !== 'undefined' ? document.body : null)
  return host ? createPortal(content, host) : null
}
