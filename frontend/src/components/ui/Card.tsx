import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  interactive?: boolean
  children?: ReactNode
}

export function Card({ interactive, onClick, className, children, ...rest }: CardProps) {
  const isClickable = interactive ?? Boolean(onClick)

  return (
    <div
      onClick={onClick}
      role={isClickable ? 'button' : undefined}
      tabIndex={isClickable ? 0 : undefined}
      className={cn(
        // shadow-card carries the 1px hairline border.
        'rounded-card bg-surface text-fg shadow-card overflow-hidden',
        isClickable && 'pressable cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

export function CardHeader({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('p-4 pb-2 flex flex-col gap-1', className)} {...rest}>
      {children}
    </div>
  )
}

export function CardTitle({ className, children, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={cn('text-base font-semibold tracking-tight text-fg', className)} {...rest}>
      {children}
    </h3>
  )
}

export function CardDescription({ className, children, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return (
    <p className={cn('text-xs text-hint', className)} {...rest}>
      {children}
    </p>
  )
}

export function CardContent({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn('p-4 pt-0', className)} {...rest}>
      {children}
    </div>
  )
}

export function CardFooter({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('p-4 pt-2.5 flex items-center justify-between gap-2 border-t border-separator/30 text-xs text-hint', className)}
      {...rest}
    >
      {children}
    </div>
  )
}
