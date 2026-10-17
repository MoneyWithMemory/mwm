import { X } from 'lucide-react'
import type { ButtonHTMLAttributes, ComponentType, MouseEvent, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface ChipProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onClick'> {
  active?: boolean
  icon?: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
  onRemove?: () => void
  onClick?: (e: MouseEvent<HTMLButtonElement>) => void
  children: ReactNode
}

/**
 * Interactive filter chip / tag with tactile .pressable hover and press scaling.
 */
export function Chip({
  active = false,
  icon: Icon,
  onRemove,
  onClick,
  className,
  children,
  type = 'button',
  disabled = false,
  ...rest
}: ChipProps) {
  const isClickable = Boolean(onClick)

  const handleRemove = (e: MouseEvent) => {
    e.stopPropagation()
    onRemove?.()
  }

  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'badge-nowrap inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium transition-colors duration-quick ease-smooth-out select-none outline-none shrink-0',
        isClickable && 'pressable cursor-pointer',
        active
          ? 'bg-accent text-on-accent shadow-card'
          : 'bg-surface-muted text-fg hover:bg-surface-muted/80',
        disabled && 'opacity-50 cursor-not-allowed pointer-events-none',
        className
      )}
      {...rest}
    >
      {Icon && (
        <Icon
          size={13}
          aria-hidden={true}
          className={cn('shrink-0', active ? 'text-on-accent' : 'text-hint')}
        />
      )}
      <span>{children}</span>
      {onRemove && (
        <span
          role="button"
          tabIndex={0}
          onClick={handleRemove}
          className="pressable-icon pressable-flat -mr-1 ml-0.5 rounded-full p-0.5 text-current opacity-70 hover:opacity-100"
          aria-label="Remove"
        >
          <X size={12} aria-hidden={true} />
        </span>
      )}
    </button>
  )
}
