import { AnimatePresence, motion } from 'motion/react'
import { forwardRef, useCallback, useId, useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { DUR, EASE_OUT } from '@/lib/motion'

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string
  hint?: string
  error?: string
  shake?: boolean
  containerClassName?: string
  /** It grows with its text from `rows` up to this many lines, then scrolls. */
  maxRows?: number
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
    maxRows = 8,
    className,
    containerClassName,
    onInput,
    ...rest
  },
  ref
) {
  const inner = useRef<HTMLTextAreaElement | null>(null)
  const setRef = useCallback(
    (element: HTMLTextAreaElement | null) => {
      inner.current = element
      if (typeof ref === 'function') ref(element)
      else if (ref) ref.current = element
    },
    [ref],
  )

  // No resize handle: the box fits its text, then scrolls past maxRows.
  const fit = useCallback(() => {
    const element = inner.current
    if (!element) return
    const style = getComputedStyle(element)
    const max = parseFloat(style.lineHeight) * maxRows + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, max)}px`
    element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden'
  }, [maxRows])

  useLayoutEffect(fit, [fit, rest.value])

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
          ref={setRef}
          rows={rows}
          onInput={(event) => {
            fit()
            onInput?.(event)
          }}
          disabled={disabled}
          aria-invalid={hasError}
          aria-describedby={hasError || hint ? hintId : undefined}
          className={cn(
            'select-text w-full resize-none bg-transparent p-3 text-sm leading-5 text-fg placeholder:text-hint outline-none',
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
