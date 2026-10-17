import { AlertCircle, AlertTriangle, CheckCircle, Info } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/cn'
import { DUR, EASE_OUT } from '@/lib/motion'
import { useOverlayRoot } from '@/lib/overlay'
import { CloseButton } from './CloseButton'
import {
  ToastContext,
  toastListeners,
  type ToastItem,
  type ToastType,
} from './toastStore'

const toastVariants = {
  initial: { opacity: 0, y: 16, scale: 0.97, filter: 'blur(2px)' },
  animate: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: 'blur(0px)',
    transition: { duration: DUR.open, ease: EASE_OUT },
  },
  exit: {
    opacity: 0,
    y: 8,
    scale: 0.97,
    filter: 'blur(2px)',
    transition: { duration: DUR.quick, ease: EASE_OUT },
  },
}

const TYPE_ICONS: Record<ToastType, typeof Info> = {
  info: Info,
  success: CheckCircle,
  danger: AlertCircle,
  warning: AlertTriangle,
}

const TYPE_STYLES: Record<ToastType, { iconColor: string; border: string }> = {
  info: { iconColor: 'text-accent', border: 'border-accent/20' },
  success: { iconColor: 'text-success', border: 'border-success/20' },
  danger: { iconColor: 'text-danger', border: 'border-danger/20' },
  warning: { iconColor: 'text-warning', border: 'border-warning/20' },
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const overlayRoot = useOverlayRoot()

  useEffect(() => {
    const handleNewToast = (item: ToastItem) => {
      setToasts((prev) => [...prev, item])
    }
    toastListeners.add(handleNewToast)
    return () => {
      toastListeners.delete(handleNewToast)
    }
  }, [])

  const dismissToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }

  const showToast = (t: Omit<ToastItem, 'id'>) => {
    const id = Math.random().toString(36).substring(2, 9)
    const item: ToastItem = { ...t, id }
    setToasts((prev) => [...prev, item])
    return id
  }

  const content = (
    <div
      role="region"
      aria-live="polite"
      aria-label="Notifications"
      className="!pointer-events-none fixed inset-x-0 bottom-16 z-50 flex flex-col items-center gap-2 p-4 select-none"
    >
      <AnimatePresence mode="sync">
        {toasts.map((item) => {
          const type = item.type ?? 'info'
          const Icon = TYPE_ICONS[type]
          const style = TYPE_STYLES[type]

          return (
            <ToastCard
              key={item.id}
              item={item}
              Icon={Icon}
              style={style}
              onDismiss={() => dismissToast(item.id)}
            />
          )
        })}
      </AnimatePresence>
    </div>
  )

  const host = overlayRoot ?? (typeof document !== 'undefined' ? document.body : null)

  return (
    <ToastContext.Provider value={{ showToast, dismissToast }}>
      {children}
      {host ? createPortal(content, host) : null}
    </ToastContext.Provider>
  )
}

function ToastCard({
  item,
  Icon,
  style,
  onDismiss,
}: {
  item: ToastItem
  Icon: typeof Info
  style: { iconColor: string; border: string }
  onDismiss: () => void
}) {
  useEffect(() => {
    const dur = item.duration ?? 3500
    if (dur <= 0) return
    const timer = setTimeout(onDismiss, dur)
    return () => clearTimeout(timer)
  }, [item.duration, onDismiss])

  return (
    <motion.div
      variants={toastVariants}
      initial="initial"
      animate="animate"
      exit="exit"
      layout
      className={cn(
        'pointer-events-auto relative flex items-start gap-3 w-full max-w-sm rounded-card surface-glass p-3.5 pr-10 shadow-raised border text-fg select-none',
        style.border
      )}
    >
      <Icon size={18} className={cn('shrink-0 mt-0.5', style.iconColor)} aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <h4 className="text-xs font-semibold leading-tight text-fg">{item.title}</h4>
        {item.description && (
          <p className="mt-0.5 text-xs text-hint leading-relaxed">{item.description}</p>
        )}
      </div>
      {/* Concentric with the 20px corner: 24px circle at 8px. */}
      <CloseButton size="xs" className="absolute top-2 right-2" onClick={onDismiss} aria-label="Dismiss notification" />
    </motion.div>
  )
}
