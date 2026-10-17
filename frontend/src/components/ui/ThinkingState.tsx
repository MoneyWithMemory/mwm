import { ChevronDown, Cpu, Sparkles } from 'lucide-react'
import { motion } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { DUR, EASE_OUT, LOOP } from '@/lib/motion'

/**
 * Three pulsating dots with staggered animation delays.
 */
export function ThinkingDots({ className }: { className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 select-none', className)} aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          animate={{
            scale: [0.8, 1.25, 0.8],
            opacity: [0.4, 1, 0.4],
          }}
          transition={{
            duration: LOOP.dots,
            repeat: Infinity,
            delay: i * LOOP.dotStagger,
            ease: EASE_OUT,
          }}
          className="size-1.5 rounded-full bg-accent"
        />
      ))}
    </span>
  )
}

export interface ThinkingStateProps {
  /** The primary status message, e.g. "Buyer agent reasoning..." */
  statusText?: string
  /** Subtitle or detail message */
  detail?: string
  /** If provided, renders an expandable thoughts drawer */
  thoughts?: string | null
  /** Title of the thoughts drawer, e.g. "Your agent's private reasoning" */
  thoughtsTitle?: string
  /** Start counting elapsed seconds */
  showTimer?: boolean
  className?: string
  children?: ReactNode
}

/**
 * Shimmering AI status block for QVAC local inference turns (12–30 s).
 * Zero layout shift, subtle pulsing orb, and optional collapsible reasoning view.
 */
export function ThinkingState({
  statusText = 'Local AI reasoning…',
  detail,
  thoughts,
  thoughtsTitle = "Your agent's private reasoning",
  showTimer = true,
  className,
  children,
}: ThinkingStateProps) {
  const [elapsed, setElapsed] = useState(0)
  const [thoughtsOpen, setThoughtsOpen] = useState(false)

  useEffect(() => {
    if (!showTimer) return
    const timer = setInterval(() => {
      setElapsed((prev) => prev + 1)
    }, 1000)
    return () => clearInterval(timer)
  }, [showTimer])

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'rounded-card border border-accent/25 bg-accent/5 p-4 text-fg shadow-card overflow-hidden transition-colors duration-quick',
        className
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="relative flex size-8 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent">
            <Cpu size={16} aria-hidden="true" />
            <motion.div
              animate={{
                scale: [1, 1.4, 1],
                opacity: [0.5, 0, 0.5],
              }}
              transition={{
                duration: LOOP.pulse,
                repeat: Infinity,
                ease: EASE_OUT,
              }}
              className="absolute inset-0 rounded-full border border-accent"
              aria-hidden="true"
            />
          </div>

          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-fg tracking-tight truncate">
                {statusText}
              </span>
              <ThinkingDots />
            </div>
            {detail && <span className="text-xs text-hint truncate mt-0.5">{detail}</span>}
          </div>
        </div>

        {showTimer && (
          <span className="amount text-xs text-hint bg-surface px-2 py-0.5 rounded-full border border-separator/40 shrink-0">
            {elapsed}s
          </span>
        )}
      </div>

      {children}

      {thoughts && (
        <div className="mt-3 pt-3 border-t border-accent/15">
          <button
            type="button"
            onClick={() => setThoughtsOpen((open) => !open)}
            className="pressable-flat flex items-center justify-between w-full text-left text-xs font-medium text-accent select-none"
            aria-expanded={thoughtsOpen}
          >
            <span className="flex items-center gap-1.5">
              <Sparkles size={13} aria-hidden="true" />
              <span>{thoughtsTitle}</span>
            </span>
            <motion.span
              animate={{ rotate: thoughtsOpen ? 180 : 0 }}
              transition={{ duration: DUR.quick, ease: EASE_OUT }}
              className="inline-flex items-center justify-center"
            >
              <ChevronDown size={14} aria-hidden="true" />
            </motion.span>
          </button>

          {thoughtsOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: DUR.quick, ease: EASE_OUT }}
              className="mt-2 text-xs text-fg/90 bg-surface/80 rounded-control p-3 border border-separator/30 select-text leading-relaxed font-mono"
            >
              {thoughts}
            </motion.div>
          )}
        </div>
      )}
    </div>
  )
}
