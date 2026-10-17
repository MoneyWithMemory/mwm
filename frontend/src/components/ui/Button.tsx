import { ArrowRight, Loader2 } from 'lucide-react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  loading?: boolean
  trailingArrow?: boolean
  fullWidth?: boolean
  children?: ReactNode
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-pressed shadow-card',
  secondary: 'bg-surface-muted text-fg hover:bg-surface-muted/80',
  ghost: 'bg-transparent text-accent hover:bg-surface-muted/60 pressable-flat',
  danger: 'bg-danger text-on-accent hover:bg-danger/90 shadow-card',
}

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  lg: 'h-12 px-5 text-base gap-2.5',
}

/**
 * Telegram-style button with micro-interactions and zero-layout-shift loading.
 * Clickable surfaces use .pressable (or .pressable-flat for ghost).
 */
export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  trailingArrow = false,
  fullWidth = false,
  disabled = false,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const isGhost = variant === 'ghost'
  const isDisabled = disabled || loading

  return (
    <button
      type={type}
      disabled={isDisabled}
      aria-busy={loading}
      className={cn(
        'group relative inline-flex items-center justify-center font-medium rounded-control select-none outline-none',
        isGhost ? 'pressable pressable-flat' : 'pressable',
        VARIANTS[variant],
        SIZES[size],
        fullWidth && 'w-full',
        isDisabled && 'opacity-60 cursor-not-allowed pointer-events-none',
        className
      )}
      {...rest}
    >
      {/* Centered content grid to ensure zero layout shift when loading */}
      <span className="inline-grid place-items-center">
        {/* Label (hidden visually when loading, but retains exact layout geometry) */}
        <span
          className={cn(
            'col-start-1 row-start-1 inline-flex items-center justify-center gap-1.5 transition-opacity duration-quick ease-smooth-out',
            loading ? 'invisible opacity-0' : 'visible opacity-100'
          )}
        >
          {children}
          {trailingArrow && (
            <ArrowRight
              size={size === 'sm' ? 14 : size === 'md' ? 16 : 18}
              aria-hidden="true"
              className="transition-transform duration-fast ease-smooth-out group-hover:translate-x-0.5"
            />
          )}
        </span>

        {/* Spinner (centered in the exact same grid slot) */}
        <span
          className={cn(
            'col-start-1 row-start-1 inline-flex items-center justify-center transition-opacity duration-quick ease-smooth-out',
            loading ? 'visible opacity-100' : 'invisible opacity-0'
          )}
          aria-hidden={!loading}
        >
          <Loader2
            size={size === 'sm' ? 14 : size === 'md' ? 16 : 20}
            className="animate-spin text-current"
          />
        </span>
      </span>
    </button>
  )
}
