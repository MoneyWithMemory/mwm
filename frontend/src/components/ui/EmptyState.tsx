import { Inbox } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface EmptyStateProps {
  icon?: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
  title: string
  description?: string
  action?: ReactNode
  className?: string
}

/**
 * Standard empty state placeholder with comfortable vertical rhythm and zero layout shift.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center p-8 text-center select-none',
        className
      )}
    >
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-surface-muted text-hint">
        <Icon size={24} aria-hidden={true} />
      </div>
      <h3 className="text-base font-semibold text-fg tracking-tight">{title}</h3>
      {description && (
        <p className="mt-1 text-xs text-hint max-w-xs leading-relaxed">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
