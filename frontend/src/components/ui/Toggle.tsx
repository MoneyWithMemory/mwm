import { motion } from 'motion/react'
import type { KeyboardEvent } from 'react'
import { cn } from '@/lib/cn'
import { SPRING_TABS } from '@/lib/motion'

export interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  description?: string
  disabled?: boolean
  id?: string
  className?: string
}

/**
 * Animated switch toggle with smooth spring thumb motion and accessible focus states.
 */
export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  id,
  className,
}: ToggleProps) {
  const handleToggle = () => {
    if (!disabled) {
      onChange(!checked)
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    if (disabled) return
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault()
      onChange(!checked)
    }
  }

  const switchButton = (
    <button
      id={id}
      role="switch"
      type="button"
      aria-checked={checked}
      disabled={disabled}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full p-0.5 transition-colors duration-quick ease-smooth-out select-none outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        checked ? 'bg-accent' : 'bg-surface-raised',
        disabled && 'opacity-50 cursor-not-allowed pointer-events-none'
      )}
    >
      <motion.span
        layout
        transition={SPRING_TABS}
        className={cn(
          'pointer-events-none block size-5 rounded-full bg-fg shadow-card',
          checked ? 'ml-auto' : 'mr-auto'
        )}
      />
    </button>
  )

  if (!label && !description) {
    return <div className={className}>{switchButton}</div>
  }

  return (
    <div
      onClick={handleToggle}
      className={cn(
        'flex items-center justify-between gap-3 select-none',
        !disabled && 'cursor-pointer',
        className
      )}
    >
      <div className="flex flex-col">
        {label && <span className="text-sm font-medium text-fg">{label}</span>}
        {description && <span className="text-xs text-hint">{description}</span>}
      </div>
      {switchButton}
    </div>
  )
}
