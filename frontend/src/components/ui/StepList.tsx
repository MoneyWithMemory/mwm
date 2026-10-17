import { AlertCircle, CheckCircle, Clock, Loader2, ShieldCheck } from 'lucide-react'
import { motion } from 'motion/react'
import { SETTLEMENT_STEPS, type SettlementStep } from '@/api/types'
import { cn } from '@/lib/cn'
import { IconSwap } from './IconSwap'

export interface StepListProps {
  steps: SettlementStep[]
  className?: string
}

/**
 * 7-step atomic swap settlement list with live statuses and rgb-lib call details.
 * Highlights step 4: "RGB consignment validated before signing".
 */
export function StepList({ steps, className }: StepListProps) {
  // Merge full definitions from SETTLEMENT_STEPS with current execution status
  const fullSteps = SETTLEMENT_STEPS.map((meta) => {
    const live = steps.find((s) => s.index === meta.index)
    return {
      ...meta,
      status: live?.status ?? 'pending',
    }
  })

  return (
    <div className={cn('flex flex-col select-none py-2', className)}>
      {fullSteps.map((step, idx) => {
        const isLast = idx === fullSteps.length - 1
        const isStep4 = step.index === 4
        const isDone = step.status === 'done'
        const isRunning = step.status === 'running'
        const isFailed = step.status === 'failed'

        let indicatorContent
        let circleBg = 'bg-surface-muted text-hint border-separator/60'

        if (isDone) {
          circleBg = 'bg-success/15 text-success border-success/30'
          indicatorContent = <CheckCircle size={16} aria-hidden="true" />
        } else if (isRunning) {
          circleBg = 'bg-accent/15 text-accent border-accent/40 shadow-glow-soft'
          indicatorContent = <Loader2 size={16} className="animate-spin" aria-hidden="true" />
        } else if (isFailed) {
          circleBg = 'bg-danger/15 text-danger border-danger/40'
          indicatorContent = <AlertCircle size={16} aria-hidden="true" />
        } else {
          indicatorContent = <span className="text-xs font-semibold">{step.index}</span>
        }

        return (
          <div key={step.index} className="relative flex gap-3.5 pb-5 last:pb-1">
            {/* Vertical connector line */}
            {!isLast && (
              <span
                className={cn(
                  'absolute left-[13px] top-[26px] bottom-0 w-[2px] transition-colors duration-quick ease-smooth-out',
                  isDone ? 'bg-success/40' : 'bg-separator/40'
                )}
                aria-hidden="true"
              />
            )}

            {/* Status indicator circle */}
            <div
              className={cn(
                'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border transition-colors duration-quick ease-smooth-out',
                circleBg
              )}
            >
              <IconSwap iconKey={step.status}>
                {indicatorContent}
              </IconSwap>
            </div>

            {/* Step text content */}
            <div className="flex-1 min-w-0 pt-0.5">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'text-xs font-medium leading-tight',
                    isDone && 'text-fg',
                    isRunning && 'text-accent font-semibold',
                    isFailed && 'text-danger font-semibold',
                    step.status === 'pending' && 'text-hint'
                  )}
                >
                  {step.label}
                </span>

                {/* Status indicator badge */}
                {isRunning && (
                  <span className="badge-nowrap inline-flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">
                    <Clock size={10} aria-hidden="true" />
                    <span>Executing</span>
                  </span>
                )}
              </div>

              {/* Technical rgb-lib function call name */}
              <div className="flex items-center gap-2 mt-0.5">
                <code className="text-[11px] font-mono text-hint/80 select-text">
                  rgb_lib.{step.name}()
                </code>
                <span className="text-[10px] text-hint/60 capitalize">
                  ({step.actor})
                </span>
              </div>

              {/* Special highlight for Step 4 (consignments validated before signing) */}
              {isStep4 && (
                <motion.div
                  initial={{ opacity: 0, y: 2 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="mt-1.5 inline-flex items-center gap-1.5 rounded-control bg-accent/10 border border-accent/20 px-2 py-1 text-[11px] font-medium text-accent"
                >
                  <ShieldCheck size={13} className="shrink-0" aria-hidden="true" />
                  <span>RGB consignment validated before signing</span>
                </motion.div>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
