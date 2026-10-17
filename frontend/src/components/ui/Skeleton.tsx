import type { HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export type SkeletonVariant = 'text' | 'circular' | 'rectangular'

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SkeletonVariant
  width?: string | number
  height?: string | number
}

const VARIANTS: Record<SkeletonVariant, string> = {
  text: 'h-4 w-full rounded',
  circular: 'rounded-full shrink-0',
  rectangular: 'rounded-control w-full',
}

/**
 * Placeholder skeleton with pulse animation for loading states without layout shift.
 */
export function Skeleton({
  variant = 'rectangular',
  width,
  height,
  style,
  className,
  ...rest
}: SkeletonProps) {
  const customStyle = {
    ...style,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  }

  return (
    <div
      aria-hidden="true"
      style={customStyle}
      className={cn('bg-surface-muted animate-pulse select-none', VARIANTS[variant], className)}
      {...rest}
    />
  )
}
