import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface ActionButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** A 20–22px icon. */
  icon: ReactNode
  label: string
  variant?: 'primary' | 'secondary'
}

/**
 * Round wallet action (Move, Send, Lock): a 56px circle with its label underneath. Circle and
 * label are one press target, so they lift and press together (.pressable on the button only).
 */
export function ActionButton({ icon, label, variant = 'secondary', className, type = 'button', ...rest }: ActionButtonProps) {
  return (
    <button
      type={type}
      className={cn('pressable pressable-flat group flex w-16 flex-col items-center gap-1.5 rounded-control outline-none select-none', className)}
      {...rest}
    >
      <span
        className={cn(
          'grid size-14 place-items-center rounded-full transition-colors duration-quick ease-smooth-out',
          variant === 'primary' ? 'bg-accent text-on-accent shadow-glow group-hover:bg-accent-pressed' : 'bg-surface-muted text-fg group-hover:bg-surface-raised',
        )}
        aria-hidden="true"
      >
        {icon}
      </span>
      <span className="text-xs font-medium">{label}</span>
    </button>
  )
}
