import { motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/cn'
import { DUR, EASE_OUT } from '@/lib/motion'

export interface AmountCountUpProps {
  value: number
  decimals?: number
  prefix?: string
  suffix?: string
  duration?: number
  className?: string
}

function easeOut(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/**
 * Tabular numeric counter with smooth pop-in bump animation on value changes.
 * Guaranteed zero layout shift using .amount (tabular numbers).
 */
export function AmountCountUp({
  value,
  decimals = 2,
  prefix = '',
  suffix = '',
  duration = 600,
  className,
}: AmountCountUpProps) {
  const [displayValue, setDisplayValue] = useState(value)
  const [bumpKey, setBumpKey] = useState(0)
  const prevValueRef = useRef(value)

  useEffect(() => {
    const startVal = prevValueRef.current
    const endVal = value
    prevValueRef.current = value

    if (startVal === endVal) return

    setBumpKey((k) => k + 1)
    const startTime = performance.now()

    let frameId: number
    const tick = (now: number) => {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = easeOut(progress)
      const current = startVal + (endVal - startVal) * eased

      setDisplayValue(current)

      if (progress < 1) {
        frameId = requestAnimationFrame(tick)
      } else {
        setDisplayValue(endVal)
      }
    }

    frameId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frameId)
  }, [value, duration])

  const formattedNumber = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(displayValue)

  return (
    <motion.span
      key={bumpKey}
      initial={{ scale: 0.98, opacity: 0.9 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ duration: DUR.open, ease: EASE_OUT }}
      className={cn('amount inline-flex items-baseline select-text font-semibold text-fg', className)}
    >
      {prefix && <span className="mr-0.5 font-normal text-current opacity-80">{prefix}</span>}
      <span>{formattedNumber}</span>
      {suffix && <span className="ml-1 text-xs font-normal text-hint">{suffix}</span>}
    </motion.span>
  )
}
