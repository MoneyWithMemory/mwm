import { AnimatePresence, motion } from 'motion/react'
import { forwardRef, useId, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { DUR, EASE_OUT } from '@/lib/motion'

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: string
  error?: string
  shake?: boolean
  containerClassName?: string
}

const shakeVariants = {
  idle: { x: 0 },
  shake: {
    x: [0, -6, 6, -4, 4, -2, 2, 0],
    transition: { duration: DUR.medium, ease: EASE_OUT },
  },
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  {
    label,
    hint,
    error,
    shake = false,
    id: explicitId,
    disabled = false,
    rows = 3,
    className,
    containerClassName,
    ...rest
  },
  ref
) {
  const autoId = useId()
  const textareaId = explicitId ?? `textarea-${autoId}`
  const hintId = `hint-${autoId}`
  const hasError = Boolean(error)
  const isShaking = shake || hasError

  return (
    <div className={cn('w-full flex flex-col', containerClassName)}>
      {label && (
        <label htmlFor={textareaId} className="mb-1 text-xs font-medium text-hint select-none">
          {label}
        </label>
      )}

      <motion.div
        variants={shakeVariants}
        animate={isShaking ? 'shake' : 'idle'}
        className={cn(
          'relative flex w-full rounded-control bg-surface-muted transition-colors duration-quick ease-smooth-out border',
          hasError
            ? 'border-danger focus-within:border-danger'
            : 'border-transparent focus-within:border-accent focus-within:bg-surface',
          disabled && 'opacity-60 cursor-not-allowed pointer-events-none'
        )}
      >
        <textarea
          id={textareaId}
          ref={ref}
          rows={rows}
          disabled={disabled}
          aria-invalid={hasError}
          aria-describedby={hasError || hint ? hintId : undefined}
          className={cn(
            'select-text w-full bg-transparent p-3 text-sm text-fg placeholder:text-hint outline-none resize-y',
            className
          )}
          {...rest}
        />
      </motion.div>

      {/* Reserved height footer ensures ZERO layout shift when errors appear or resolve */}
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
    </div>
  )
})
