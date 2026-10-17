import { Loader2 } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { SETTLEMENT_STEPS, type SessionView } from '@/api'
import { Button, Card, CardContent, StepList, SuccessCheck } from '@/components/ui'
import { formatAssetAmount, formatUsd } from '@/lib/format'
import { DUR, EASE_OUT, accordion, textSwap } from '@/lib/motion'
import { useWalletContext } from '@/lib/navigation'
import { TxidRow } from './TxidRow'

/** The step the swap is on: the running one, else the first not done yet. */
function currentStep(session: SessionView) {
  const status = (index: number) => session.settlement_steps.find((s) => s.index === index)?.status ?? 'pending'
  return (
    SETTLEMENT_STEPS.find((meta) => status(meta.index) === 'running') ??
    SETTLEMENT_STEPS.find((meta) => status(meta.index) !== 'done') ??
    SETTLEMENT_STEPS[SETTLEMENT_STEPS.length - 1]
  )
}

/**
 * The atomic swap, in one card: progress while it settles, the check once it has. The seven
 * rgb-lib calls are listed in the detailed view.
 */
export function SettlementPanel({ session, detailed }: { session: SessionView; detailed: boolean }) {
  const { reset } = useWalletContext()
  const settled = session.state === 'SETTLED'
  const done = session.settlement_steps.filter((s) => s.status === 'done').length
  const total = SETTLEMENT_STEPS.length
  const step = currentStep(session)
  const asset = formatAssetAmount(session.rgb_amount, session.asset.precision, session.asset.ticker)

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-col items-center gap-3 pt-5 text-center">
          <AnimatePresence mode="wait" initial={false}>
            {settled ? (
              <SuccessCheck key="settled" />
            ) : (
              <motion.span
                key="settling"
                className="flex size-14 items-center justify-center rounded-full bg-accent/15 text-accent"
                exit={{ opacity: 0, scale: 0.9, transition: { duration: DUR.quick, ease: EASE_OUT } }}
                aria-hidden="true"
              >
                <Loader2 size={26} className="animate-spin" />
              </motion.span>
            )}
          </AnimatePresence>

          <div className="flex w-full flex-col items-center gap-1" role="status">
            <h2 className="text-base font-semibold">{settled ? 'Trade complete' : 'Swapping on Bitcoin'}</h2>
            <span className="relative flex h-5 w-full justify-center overflow-hidden text-sm text-hint">
              <AnimatePresence mode="wait" initial={false}>
                <motion.span key={settled ? 'settled' : step.index} className="block truncate" variants={textSwap} initial="initial" animate="animate" exit="exit">
                  {settled
                    ? `${asset}${session.agreed_price_usd !== null ? ` for ${formatUsd(session.agreed_price_usd)}` : ''}`
                    : step.label}
                </motion.span>
              </AnimatePresence>
            </span>
          </div>

          {!settled && (
            <div className="flex w-full items-center gap-3">
              <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
                <motion.span
                  className="block h-full origin-left rounded-full bg-accent"
                  initial={false}
                  animate={{ scaleX: Math.max(done, 0.35) / total }}
                  transition={{ duration: DUR.open, ease: EASE_OUT }}
                />
              </span>
              <span className="amount text-xs text-hint">
                {done}/{total}
              </span>
            </div>
          )}

          {settled && session.txid && <TxidRow txid={session.txid} />}
          {settled && (
            <Button fullWidth trailingArrow onClick={() => reset('wallet')}>
              Back to Wallet
            </Button>
          )}
        </CardContent>
      </Card>

      <AnimatePresence initial={false}>
        {detailed && (
          <motion.div key="steps" variants={accordion} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
            <Card>
              <CardContent className="flex flex-col gap-3 pt-4">
                {!settled && session.txid && <TxidRow txid={session.txid} label="Broadcast transaction ID" />}
                <StepList steps={session.settlement_steps} />
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
