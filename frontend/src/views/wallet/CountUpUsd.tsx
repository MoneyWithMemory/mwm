import { animate, motion, useMotionValue, useTransform } from 'motion/react'
import { useEffect } from 'react'
import { formatUsd } from '@/lib/format'
import { DUR, EASE_OUT } from '@/lib/motion'

/** Counts to `value` whenever it changes. Stopgap until AmountCountUp lands in components/ui. */
export function CountUpUsd({ value }: { value: number }) {
  const progress = useMotionValue(value)
  const text = useTransform(progress, formatUsd)

  useEffect(() => {
    const controls = animate(progress, value, { duration: DUR.open * 2, ease: EASE_OUT })
    return () => controls.stop()
  }, [progress, value])

  return <motion.span className="amount">{text}</motion.span>
}
