import { AnimatePresence, motion } from 'motion/react'
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { DUR, EASE_OUT } from '@/lib/motion'

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label?: string
  hint?: string
  error?: string
  shake?: boolean
  prefix?: ReactNode
  suffix?: ReactNode
  containerClassName?: string
  /** A line kept under the field so a hint or an error never moves what follows; off for fields that never show one (e.g. search). */
  reserveMessage?: boolean
  /** The parent shakes the whole group, so on an error the field only turns red. */
  shakeWithGroup?: boolean
}

const shakeVariants = {
  idle: { x: 0 },
  shake: {
    x: [0, -6, 6, -4, 4, -2, 2, 0],
    transition: { duration: DUR.medium, ease: EASE_OUT },
  },
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  {
    label,
    hint,
    error,
    shake = false,
    prefix,
    suffix,
    id: explicitId,
    disabled = false,
    className,
    containerClassName,
    reserveMessage = true,
    shakeWithGroup = false,
    ...rest
  },
  ref
) {
  const autoId = useId()
  const inputId = explicitId ?? `input-${autoId}`
  const hintId = `hint-${autoId}`
  const hasError = Boolean(error)
  const isShaking = !shakeWithGroup && (shake || hasError)

  return (
    <div className={cn('w-full flex flex-col', containerClassName)}>
      {label && (
        <label htmlFor={inputId} className="mb-1 text-xs font-medium text-hint select-none">
          {label}
        </label>
      )}

      <motion.div
        variants={shakeVariants}
        animate={isShaking ? 'shake' : 'idle'}
        className={cn(
          'relative flex items-center w-full rounded-control bg-surface-muted transition-colors duration-quick ease-smooth-out border',
          hasError
            ? 'border-danger focus-within:border-danger'
            : 'border-transparent focus-within:border-accent focus-within:bg-surface',
          disabled && 'opacity-60 cursor-not-allowed pointer-events-none'
        )}
      >
        {prefix && (
          <div className="pl-3 pr-1 text-hint select-none flex items-center justify-center shrink-0">
            {prefix}
          </div>
        )}

        <input
          id={inputId}
          ref={ref}
          disabled={disabled}
          aria-invalid={hasError}
          aria-describedby={hasError || hint ? hintId : undefined}
          className={cn(
            'select-text w-full bg-transparent px-3 py-2 text-sm text-fg placeholder:text-hint outline-none',
            Boolean(prefix) && 'pl-1',
            Boolean(suffix) && 'pr-1',
            className
          )}
          {...rest}
        />

        {suffix && (
          <div className="pr-3 pl-1 text-hint select-none flex items-center justify-center shrink-0">
            {suffix}
          </div>
        )}
      </motion.div>

      {/* Reserved height footer ensures ZERO layout shift when errors appear or resolve */}
      {(reserveMessage || hasError || hint) && (
        <div id={hintId} className="min-h-[1.25rem] pt-1 text-xs select-none">
          <AnimatePresence mode="wait" initial={false}>
            {hasError ? (
              <motion.p
                key="error"
                initial={{ opacity: 0, y: -2 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -2 }}
                transition={{ duration: DUR.quick, ease: EASE_OUT }}
                className="text-danger font-medium leading-none"
              >
                {error}
              </motion.p>
            ) : hint ? (
              <motion.p
                key="hint"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: DUR.quick, ease: EASE_OUT }}
                className="text-hint leading-none"
              >
                {hint}
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>
      )}
    </div>
  )
})
