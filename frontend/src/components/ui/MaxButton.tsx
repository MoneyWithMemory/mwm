import type { ButtonHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'

export interface MaxButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  /** The amount it fills in, as text (e.g. "1,250"). */
  amount: string
}

/** "Max 1,250": the quick action in a NumberField's label row that fills in the whole balance. */
export function MaxButton({ amount, className, type = 'button', ...rest }: MaxButtonProps) {
  return (
    <button
      type={type}
      className={cn('pressable pressable-flat amount rounded-full px-1.5 text-xs font-medium text-accent hover:bg-accent/10', className)}
      {...rest}
    >
      Max {amount}
    </button>
  )
}
