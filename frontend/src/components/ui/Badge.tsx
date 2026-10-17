import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export type BadgeVariant = 'default' | 'accent' | 'success' | 'danger' | 'warning' | 'outline'
export type BadgeSize = 'sm' | 'md'

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: BadgeVariant
  size?: BadgeSize
  children: ReactNode
}

const VARIANTS: Record<BadgeVariant, string> = {
  default: 'bg-surface-muted text-hint',
  accent: 'bg-accent/15 text-accent',
  success: 'bg-success/15 text-success',
  danger: 'bg-danger/15 text-danger',
  warning: 'bg-warning/15 text-warning',
  outline: 'border border-separator/60 text-hint bg-transparent',
}

const SIZES: Record<BadgeSize, string> = {
  sm: 'px-1.5 py-0.2 text-[10px]',
  md: 'px-2 py-0.5 text-xs',
}

/**
 * Compact status badge with guaranteed white-space nowrap (.badge-nowrap).
 */
export function Badge({
  variant = 'default',
  size = 'md',
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        'badge-nowrap inline-flex items-center justify-center font-medium rounded-full select-none leading-normal shrink-0',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  )
}
