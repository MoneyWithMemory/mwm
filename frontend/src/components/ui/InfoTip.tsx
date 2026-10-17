import { CircleHelp } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'
import { dropdown } from '@/lib/motion'
import { useOverlayRoot } from '@/lib/overlay'

export interface InfoTipProps {
  /** Names the (?) for screen readers, e.g. "About Low reliability". */
  label: string
  text: string
  className?: string
}

const WIDTH = 240
const GAP = 6
const MARGIN = 8

/** The trigger's box in the overlay host's coordinates, taken when the tip opens. */
interface Anchor {
  top: number
  bottom: number
  center: number
  hostWidth: number
  hostHeight: number
}

/**
 * A (?) that explains a term in one short text. It opens on hover with a mouse and on keyboard
 * focus; a tap or click keeps it open until the next tap, Escape or scroll. It renders in the
 * pane's overlay layer, so a card that clips its content never cuts it, and it scales from the
 * (?) like a dropdown (open 250ms, close 150ms).
 */
export function InfoTip({ label, text, className }: InfoTipProps) {
  const root = useOverlayRoot()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const tipId = useId()
  const [mode, setMode] = useState<'hover' | 'pinned' | null>(null)
  const [anchor, setAnchor] = useState<Anchor | null>(null)

  const show = (next: 'hover' | 'pinned') => {
    const trigger = triggerRef.current
    if (!trigger || !root) return
    const host = root.getBoundingClientRect()
    const box = trigger.getBoundingClientRect()
    setAnchor({
      top: box.top - host.top,
      bottom: box.bottom - host.top,
      center: box.left + box.width / 2 - host.left,
      hostWidth: host.width,
      hostHeight: host.height,
    })
    setMode(next)
  }

  useEffect(() => {
    if (!mode) return
    const close = () => setMode(null)
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close()
    const onPointer = (event: PointerEvent) => {
      if (!triggerRef.current?.contains(event.target as Node)) close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onPointer, true)
    // The tip does not follow its (?): any scroll or resize closes it instead.
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
    }
  }, [mode])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={mode !== null}
        aria-describedby={mode ? tipId : undefined}
        className={cn(
          'pressable-icon pressable-flat -m-1 inline-flex shrink-0 items-center justify-center rounded-full p-1 text-hint outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-accent',
          className,
        )}
        onPointerEnter={(event) => event.pointerType === 'mouse' && !mode && show('hover')}
        onPointerLeave={(event) => event.pointerType === 'mouse' && mode === 'hover' && setMode(null)}
        onFocus={() => !mode && show('hover')}
        onBlur={() => mode === 'hover' && setMode(null)}
        onClick={(event) => {
          event.stopPropagation()
          if (mode === 'pinned') setMode(null)
          else show('pinned')
        }}
      >
        <CircleHelp size={13} aria-hidden="true" />
      </button>
      {root &&
        createPortal(
          <AnimatePresence>{mode && anchor && <TipPanel key="tip" id={tipId} text={text} anchor={anchor} />}</AnimatePresence>,
          root,
        )}
    </>
  )
}

/** Below the (?), or above it when the pane has no room left underneath; never past its sides. */
function TipPanel({ id, text, anchor }: { id: string; text: string; anchor: Anchor }) {
  const ref = useRef<HTMLDivElement>(null)
  const [above, setAbove] = useState(false)
  const width = Math.min(WIDTH, anchor.hostWidth - 2 * MARGIN)
  const left = Math.min(Math.max(anchor.center - width / 2, MARGIN), anchor.hostWidth - width - MARGIN)

  useLayoutEffect(() => {
    const height = ref.current?.offsetHeight ?? 0
    setAbove(anchor.bottom + GAP + height > anchor.hostHeight - MARGIN && anchor.top - GAP - height >= MARGIN)
  }, [anchor])

  return (
    <motion.div
      ref={ref}
      id={id}
      role="tooltip"
      variants={dropdown}
      initial="initial"
      animate="animate"
      exit="exit"
      className="absolute z-10 rounded-control bg-surface-raised p-3 text-xs leading-relaxed text-fg shadow-overlay select-none"
      style={{
        left,
        width,
        top: above ? undefined : anchor.bottom + GAP,
        bottom: above ? anchor.hostHeight - anchor.top + GAP : undefined,
        transformOrigin: `${anchor.center - left}px ${above ? '100%' : '0%'}`,
        // Read-only text: hovering it must not keep or steal the pointer.
        pointerEvents: 'none',
      }}
    >
      {text}
    </motion.div>
  )
}
