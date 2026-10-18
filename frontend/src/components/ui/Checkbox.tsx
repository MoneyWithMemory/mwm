import { motion } from 'motion/react'
import type { KeyboardEvent, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { DUR, EASE_OUT } from '@/lib/motion'

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  description?: string
  disabled?: boolean
  id?: string
  className?: string
}

/**
 * Accessible checkbox with animated SVG path checkmark drawing.
 */
export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  id,
  className,
}: CheckboxProps) {
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

  const box = (
    <button
      id={id}
      role="checkbox"
      type="button"
      aria-checked={checked}
      disabled={disabled}
      onClick={handleToggle}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative inline-flex size-5 shrink-0 items-center justify-center rounded-md border-2 transition-colors duration-quick ease-smooth-out select-none outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
        checked ? 'bg-accent border-accent text-on-accent' : 'bg-surface-muted border-hint/50 text-transparent',
        disabled && 'opacity-50 cursor-not-allowed pointer-events-none'
      )}
    >
      <svg
        viewBox="0 0 16 16"
        fill="none"
        className="size-3.5 stroke-current stroke-[2.5]"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <motion.path
          d="M3.5 8.5L6.5 11.5L12.5 4.5"
          initial={false}
          animate={{ pathLength: checked ? 1 : 0, opacity: checked ? 1 : 0 }}
          transition={{ duration: DUR.medium, ease: EASE_OUT }}
        />
      </svg>
    </button>
  )

  if (!label && !description) {
    return <div className={className}>{box}</div>
  }

  return (
    <div
      onClick={handleToggle}
      className={cn(
        'flex items-start gap-2.5 select-none',
        !disabled && 'cursor-pointer',
        className
      )}
    >
      <div className="pt-0.5">{box}</div>
      <div className="flex flex-col">
        {label && <span className="text-sm font-medium text-fg leading-snug">{label}</span>}
        {description && <span className="text-xs text-hint leading-snug mt-0.5">{description}</span>}
      </div>
    </div>
  )
}
