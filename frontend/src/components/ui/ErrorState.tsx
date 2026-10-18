import { AlertCircle, RotateCw } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/cn'
import { Button } from './Button'

export interface ErrorStateProps {
  icon?: ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean | 'true' | 'false' }>
  title?: string
  message: string
  onRetry?: () => void
  retryLabel?: string
  retrying?: boolean
  className?: string
}

/**
 * Standard error state placeholder with action to retry.
 */
export function ErrorState({
  icon: Icon = AlertCircle,
  title = 'Something went wrong',
  message,
  onRetry,
  retryLabel = 'Retry',
  retrying = false,
  className,
}: ErrorStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center p-8 text-center select-none',
        className
      )}
    >
      <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-danger/15 text-danger">
        <Icon size={24} aria-hidden={true} />
      </div>
      <h3 className="text-base font-semibold text-fg tracking-tight">{title}</h3>
      <p className="mt-1 text-xs text-hint max-w-xs leading-relaxed">{message}</p>
      {onRetry && (
        <div className="mt-4">
          <Button
            variant="secondary"
            size="sm"
            loading={retrying}
            onClick={onRetry}
            className="gap-2"
          >
            <RotateCw size={14} aria-hidden={true} className={retrying ? 'animate-spin' : ''} />
            <span>{retryLabel}</span>
          </Button>
        </div>
      )}
    </div>
  )
}
