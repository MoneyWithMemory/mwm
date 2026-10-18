import { X } from 'lucide-react'
import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export type CloseButtonSize = 'xs' | 'sm' | 'md'

export interface CloseButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  size?: CloseButtonSize
}

const SIZES: Record<CloseButtonSize, string> = {
  xs: 'size-6', // 24px: 8px inset in a 20px corner (toasts)
  sm: 'size-7', // 28px: 6px inset in a 20px corner (modals, cards)
  md: 'size-8', // 32px: 8px inset in a 24px corner (sheets)
}

const ICON: Record<CloseButtonSize, number> = { xs: 12, sm: 14, md: 16 }

/**
 * Round close (X) trigger. Position it in its container's corner so the circle's center sits on
 * the corner's arc center (inset + radius = corner radius): the circle then follows the rounding.
 * Hover brightens it and turns the X a quarter (.close-button in index.css).
 */
export function CloseButton({ size = 'md', className, type = 'button', 'aria-label': label = 'Close', ...rest }: CloseButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      className={cn('close-button pressable-icon pressable-flat select-none', SIZES[size], className)}
      {...rest}
    >
      <X size={ICON[size]} aria-hidden="true" />
    </button>
  )
}
