import { motion } from 'motion/react'
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { DUR, EASE_OUT } from '@/lib/motion'

export interface NumberFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'size'> {
  label: string
  /** Right end of the label row: a PrivacyTag or a quick action such as "Max". */
  aside?: ReactNode
  prefix?: ReactNode
  suffix?: ReactNode
  /** Danger border and one shake; the message itself goes in the group's FormNote. */
  invalid?: boolean
  containerClassName?: string
}

const shakeVariants = {
  idle: { x: 0 },
  shake: { x: [0, -6, 6, -4, 4, -2, 2, 0], transition: { duration: DUR.medium, ease: EASE_OUT } },
}

/**
 * Amount or price input where the number is the loudest thing: a small label row above, the
 * value large and tabular, the unit in the hint color. No hint line of its own.
 */
export const NumberField = forwardRef<HTMLInputElement, NumberFieldProps>(function NumberField(
  { label, aside, prefix, suffix, invalid = false, id: explicitId, disabled, className, containerClassName, ...rest },
  ref,
) {
  const autoId = useId()
  const id = explicitId ?? `number-${autoId}`

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', containerClassName)}>
      <div className="flex min-h-5 items-center justify-between gap-2">
        <label htmlFor={id} className="truncate text-xs font-medium text-hint select-none">
          {label}
        </label>
        {aside}
      </div>
      <motion.div
        variants={shakeVariants}
        animate={invalid ? 'shake' : 'idle'}
        className={cn(
          'flex h-12 items-center rounded-control border bg-surface-muted px-3 transition-colors duration-quick ease-smooth-out',
          invalid ? 'border-danger' : 'border-transparent focus-within:border-accent focus-within:bg-surface',
          disabled && 'pointer-events-none opacity-60',
        )}
      >
        {prefix && <span className="mr-1 shrink-0 text-base text-hint select-none">{prefix}</span>}
        <input
          id={id}
          ref={ref}
          inputMode="decimal"
          disabled={disabled}
          aria-invalid={invalid}
          className={cn(
            'amount min-w-0 flex-1 bg-transparent text-lg font-semibold text-fg outline-none select-text placeholder:font-normal placeholder:text-hint/60',
            className,
          )}
          {...rest}
        />
        {suffix && <span className="ml-2 shrink-0 text-sm font-medium text-hint select-none">{suffix}</span>}
      </motion.div>
    </div>
  )
})
