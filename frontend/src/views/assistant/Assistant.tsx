import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useEffectEvent, useId, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AiMark, Badge, CloseButton, Sheet } from '@/components/ui'
import { cn } from '@/lib/cn'
import { dropdown } from '@/lib/motion'
import { useWalletContext } from '@/lib/navigation'
import { useOverlayRoot } from '@/lib/overlay'
import { requestMoveToVault } from '../wallet/vault/moveRequest'
import { AssistantChat } from './AssistantChat'

const TITLE = 'Your AI'

function LocalBadge() {
  return (
    <Badge variant="accent" size="sm">
      On this device · QVAC
    </Badge>
  )
}

/**
 * Your AI: a button on the pane's Wallet tab only that opens a chat with the wallet's local model;
 * leaving the tab closes it. `floating`: a panel in the content's corner (wide single view);
 * otherwise a bottom sheet, with the button above the tab bar.
 */
export function Assistant({ floating }: { floating: boolean }) {
  const { walletId, current } = useWalletContext()
  const onWallet = current.view === 'wallet'
  const [open, setOpen] = useState(false)
  if (open && !onWallet) setOpen(false)
  const close = () => setOpen(false)

  // Opened from the Wallet tab, so the Wallet view is on screen to take the request.
  const moveToVault = () => {
    setOpen(false)
    requestMoveToVault(walletId)
  }
  const chat = <AssistantChat walletId={walletId} onMoveToVault={moveToVault} className="h-full" />

  return (
    <>
      <AnimatePresence initial={false}>
        {onWallet && !(floating && open) && (
          <motion.button
            key="fab"
            type="button"
            variants={dropdown}
            initial="initial"
            animate="animate"
            exit="exit"
            onClick={() => setOpen(true)}
            aria-haspopup="dialog"
            data-floating={floating}
            className="assistant-fab absolute right-3 z-30 origin-bottom-right"
          >
            {/* The motion element only fades in and out; the pill underneath owns hover and press. */}
            <span className="pressable surface-glass flex h-[var(--fab-height)] items-center gap-2.5 rounded-full border border-separator py-1.5 pr-4 pl-1.5 shadow-overlay">
              <AiMark size={34} />
              <span className="flex flex-col items-start leading-tight">
                <span className="text-sm font-semibold text-fg">Ask your AI</span>
                <span className="text-[10px] font-medium text-hint">On this device</span>
              </span>
            </span>
          </motion.button>
        )}
      </AnimatePresence>
      {floating ? (
        <FloatingPanel open={open} onClose={close}>
          {chat}
        </FloatingPanel>
      ) : (
        <Sheet open={open} onClose={close} title={TITLE} badge={<LocalBadge />}>
          <div className="-mx-4 -mb-4 h-[min(64dvh,560px)]">{chat}</div>
        </Sheet>
      )}
    </>
  )
}

/** A non-modal panel in the content's bottom-right corner: opens from its corner in 250ms, closes in 150ms. */
function FloatingPanel({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
  const root = useOverlayRoot()
  const content = <AnimatePresence>{open && <Panel onClose={onClose}>{children}</Panel>}</AnimatePresence>
  return root ? createPortal(content, root) : null
}

function Panel({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const titleId = useId()
  const close = useEffectEvent(onClose)

  useEffect(() => {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      trigger?.focus({ preventScroll: true })
    }
  }, [])

  return (
    <motion.div
      role="dialog"
      aria-labelledby={titleId}
      variants={dropdown}
      initial="initial"
      animate="animate"
      exit="exit"
      className={cn(
        'absolute right-3 bottom-3 flex h-[min(640px,calc(100%-1.5rem))] w-[min(400px,calc(100%-1.5rem))] origin-bottom-right flex-col',
        'overflow-hidden rounded-card border border-separator bg-surface shadow-overlay will-change-transform',
      )}
    >
      <div className="relative flex shrink-0 items-center gap-2 px-4 pt-3 pb-2 pr-12">
        <h2 id={titleId} className="text-base leading-6 font-semibold">
          {TITLE}
        </h2>
        <LocalBadge />
        <CloseButton size="sm" className="absolute top-2.5 right-2.5" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </motion.div>
  )
}
