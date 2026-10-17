import { Check } from 'lucide-react'
import { motion } from 'motion/react'
import type { SessionView } from '@/api'
import { Button, Card, CardContent, CardHeader, CardTitle, CopyButton, StepList } from '@/components/ui'
import { formatUsd } from '@/lib/format'
import { iconSwap } from '@/lib/motion'
import { useWalletContext } from '@/lib/navigation'

export function SettlementPanel({ session }: { session: SessionView }) {
  const { reset } = useWalletContext()
  const settled = session.state === 'SETTLED'

  return (
    <div className="flex flex-col gap-3">
      {settled && (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 pt-4 text-center">
            <motion.span
              className="flex size-14 items-center justify-center rounded-full bg-success/15 text-success"
              variants={iconSwap}
              initial="initial"
              animate="animate"
            >
              <Check size={28} aria-hidden="true" />
            </motion.span>
            <div className="flex flex-col gap-1">
              <h2 className="text-base font-semibold">Trade complete</h2>
              {session.agreed_price_usd !== null && (
                <p className="amount text-sm text-hint">Settled at {formatUsd(session.agreed_price_usd)}</p>
              )}
            </div>
            {session.txid && (
              <div className="flex w-full items-center gap-2 rounded-control bg-surface-muted py-1.5 pr-1.5 pl-3 text-left">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-[11px] text-hint">Transaction ID</span>
                  <span className="select-text break-all font-mono text-xs">{session.txid}</span>
                </span>
                <CopyButton text={session.txid} size="md" />
              </div>
            )}
            <Button fullWidth trailingArrow onClick={() => reset('wallet')}>
              Back to Wallet
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{settled ? 'Settlement steps' : 'Settling on Bitcoin regtest'}</CardTitle>
        </CardHeader>
        <CardContent>
          <StepList steps={session.settlement_steps} />
        </CardContent>
      </Card>
    </div>
  )
}
