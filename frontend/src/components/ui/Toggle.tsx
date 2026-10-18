import { AnimatePresence, motion } from 'motion/react'
import { useState } from 'react'
import { cn } from '@/lib/cn'
import { textSwap } from '@/lib/motion'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  /** May change with the state (e.g. "Selling is on"): it swaps with a text transition. */
  label?: string
  description?: string
  disabled?: boolean
  id?: string
  className?: string
}

/**
 * Switch: the thumb overshoots its end and settles, the track color cross-fades, a press
 * stretches the thumb (.switch in index.css). The whole row toggles; the switch is the
 * focusable control.
 */
export function Toggle({ checked, onChange, label, description, disabled = false, id, className }: ToggleProps) {
  // Set on the first change: until then the travel keyframes must not play (e.g. on mount).
  const [touched, setTouched] = useState(false)

  const toggle = () => {
    if (disabled) return
    setTouched(true)
    onChange(!checked)
  }

  const switchButton = (
    <button
      id={id}
      role="switch"
      type="button"
      aria-checked={checked}
      aria-label={label && !description ? label : undefined}
      disabled={disabled}
      data-on={checked}
      onClick={(event) => {
        event.stopPropagation()
        toggle()
      }}
      className={cn(
        'switch relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full p-0.5 select-none outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        touched && 'is-init',
        checked ? 'bg-accent' : 'bg-surface-raised',
        disabled && 'opacity-50 cursor-not-allowed pointer-events-none',
      )}
    >
      <span className="switch-thumb pointer-events-none block h-5 w-5 rounded-full bg-fg shadow-card" />
    </button>
  )

  if (!label && !description) {
    return <div className={className}>{switchButton}</div>
  }

  return (
    <div
      onClick={toggle}
      className={cn('flex items-center justify-between gap-3 select-none', !disabled && 'cursor-pointer', className)}
    >
      <div className="flex min-w-0 flex-col">
        {label && (
          <span className="relative h-5 overflow-hidden text-sm font-medium text-fg">
            <AnimatePresence mode="wait" initial={false}>
              <motion.span key={label} className="block" variants={textSwap} initial="initial" animate="animate" exit="exit">
                {label}
              </motion.span>
            </AnimatePresence>
          </span>
        )}
        {description && <span className="text-xs text-hint">{description}</span>}
      </div>
      {switchButton}
    </div>
  )
}
