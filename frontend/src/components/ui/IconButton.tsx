import { Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { IconSwap } from './IconSwap'

export type IconButtonVariant = 'ghost' | 'secondary' | 'primary'
export type IconButtonSize = 'sm' | 'md' | 'lg'

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: IconButtonVariant
  size?: IconButtonSize
  loading?: boolean
  children: ReactNode
  /** Mandatory for screen readers and accessibility on icon buttons. */
  'aria-label': string
}

const VARIANTS: Record<IconButtonVariant, string> = {
  ghost: 'text-hint hover:text-fg hover:bg-surface-muted/60 pressable-flat',
  secondary: 'bg-surface-muted text-fg hover:bg-surface-muted/80',
  primary: 'bg-accent text-on-accent hover:bg-accent-pressed shadow-card',
}

const SIZES: Record<IconButtonSize, string> = {
  sm: 'size-7 text-xs',
  md: 'size-9 text-sm',
  lg: 'size-11 text-base',
}

/**
 * Compact circular icon button for secondary actions, close buttons, and toolbars.
 * Applies .pressable-icon for snappy tactile scaling (:active scale 0.90).
 */
export function IconButton({
  variant = 'ghost',
  size = 'md',
  loading = false,
  disabled = false,
  className,
  children,
  type = 'button',
  ...rest
}: IconButtonProps) {
  const isGhost = variant === 'ghost'
  const isDisabled = disabled || loading

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading}
      className={cn(
        'pressable-icon inline-flex items-center justify-center rounded-full select-none outline-none shrink-0',
        isGhost && 'pressable-flat',
        VARIANTS[variant],
        SIZES[size],
        isDisabled && 'opacity-60 cursor-not-allowed pointer-events-none',
        className
      )}
      {...rest}
    >
      <IconSwap iconKey={loading ? 'loading' : 'icon'}>
        {loading ? (
          <Loader2 size={size === 'sm' ? 14 : size === 'md' ? 16 : 20} className="animate-spin text-current" />
        ) : (
          children
        )}
      </IconSwap>
    </button>
  )
}
