import { ArrowDown, Check, ChevronDown, ShieldCheck } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useId, useState, type ReactNode } from 'react'
import type { CanonicalSwapTerms, Role } from '@/api/types'
import { cn } from '@/lib/cn'
import { formatAssetAmount, formatSats, formatUsd, shortAddress } from '@/lib/format'
import { DUR, EASE_OUT, accordion, textSwap } from '@/lib/motion'
import { AssetBadge } from './AssetBadge'
import { Button } from './Button'
import { Card, CardContent } from './Card'
import { CopyButton } from './CopyButton'
import { IconSwap } from './IconSwap'
import { ThinkingDots } from './ThinkingState'

export interface ApprovalCardProps {
  terms: CanonicalSwapTerms
  termsHash?: string | null
  assetTicker?: string
  paymentTicker?: string
  myRole: Role
  mySigned: boolean
  counterpartySigned: boolean
  /** The other side's name on its signature chip; defaults to its role. */
  counterpartyLabel?: string
  /** Opens the terms details (price, fee, address, hash) from the start. */
  detailed?: boolean
  signing?: boolean
  cancelling?: boolean
  onSign: () => void
  onCancel?: () => void
  /** Shown while only you have signed, e.g. a shortcut for the other side to sign on this device. */
  waitingAction?: ReactNode
  className?: string
}

function Leg({ label, ticker, assetId, amount }: { label: string; ticker: string; assetId: string; amount: number }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-control bg-surface-muted/60 px-3.5 py-3">
      <span className="text-xs text-hint">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <AssetBadge ticker={ticker} asset_id={assetId} size="sm" />
        <span className="amount truncate text-base font-semibold">{formatAssetAmount(amount, 0, ticker)}</span>
      </span>
    </div>
  )
}

function SignatureChip({ who, signed }: { who: string; signed: boolean }) {
  return (
    <span
      className={cn(
        'badge-nowrap inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors duration-fast ease-smooth-out',
        signed ? 'bg-success/15 text-success' : 'bg-surface-muted text-hint',
      )}
    >
      <IconSwap iconKey={signed ? 'signed' : 'waiting'}>
        {signed ? <Check size={12} aria-hidden="true" /> : <span className="size-1.5 animate-pulse rounded-full bg-current" />}
      </IconSwap>
      {who}
    </span>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-hint">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1 text-fg">{children}</dd>
    </div>
  )
}

/**
 * The agreed terms, to approve with one tap: what you pay, what you get, who has signed. Price,
 * fee, address and terms hash fold under "Details". Signing approves exactly these terms.
 */
export function ApprovalCard({
  terms,
  termsHash,
  assetTicker = 'PEPE',
  paymentTicker = 'USDT',
  myRole,
  mySigned,
  counterpartySigned,
  counterpartyLabel,
  detailed = false,
  signing = false,
  cancelling = false,
  onSign,
  onCancel,
  waitingAction,
  className,
}: ApprovalCardProps) {
  const [open, setOpen] = useState(detailed)
  // The detailed view opens the details, the compact one folds them; a tap still overrides.
  const [shownFor, setShownFor] = useState(detailed)
  if (shownFor !== detailed) {
    setShownFor(detailed)
    setOpen(detailed)
  }
  const detailsId = useId()
  const buying = myRole === 'buyer'
  const other = counterpartyLabel ?? (buying ? 'Seller' : 'Buyer')
  const expiry = new Date(terms.expiry_unix * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const step = !mySigned ? 'sign' : !counterpartySigned ? 'wait' : 'done'

  return (
    <Card className={cn('shadow-raised', className)}>
      <CardContent className="flex flex-col gap-4 pt-4">
        {/* A swap receipt: what leaves your wallet, then what arrives. */}
        <div className="relative flex flex-col gap-1">
          <Leg
            label="You pay"
            ticker={buying ? paymentTicker : assetTicker}
            assetId={buying ? terms.payment_asset_id : terms.asset_id}
            amount={buying ? terms.payment_amount : terms.rgb_amount}
          />
          <span
            className="absolute top-1/2 left-1/2 flex size-7 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border-4 border-surface bg-surface-raised text-hint"
            aria-hidden="true"
          >
            <ArrowDown size={12} />
          </span>
          <Leg
            label="You get"
            ticker={buying ? assetTicker : paymentTicker}
            assetId={buying ? terms.asset_id : terms.payment_asset_id}
            amount={buying ? terms.rgb_amount : terms.payment_amount}
          />
        </div>

        <div className="flex flex-col">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailsId}
            onClick={() => setOpen((value) => !value)}
            className="pressable pressable-flat -mx-2 flex items-center gap-2 rounded-control px-2 py-1.5 text-left text-xs outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ShieldCheck size={14} className="shrink-0 text-success" aria-hidden="true" />
            <span className="flex-1 text-hint">
              Safety check passed · <span className="amount">expires {expiry}</span>
            </span>
            <span className="flex items-center gap-1 font-medium text-accent">
              Details
              <motion.span
                animate={{ scaleY: open ? -1 : 1 }}
                transition={{ duration: DUR.open, ease: EASE_OUT }}
                className="inline-flex"
                aria-hidden="true"
              >
                <ChevronDown size={14} />
              </motion.span>
            </span>
          </button>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div id={detailsId} key="details" variants={accordion} initial="initial" animate="animate" exit="exit" className="overflow-hidden">
                <div className="mt-1 flex flex-col gap-1.5 rounded-control bg-surface-muted/60 p-3 text-xs">
                  <dl className="flex flex-col gap-1.5">
                    <Detail label="Agreed price">
                      <span className="amount font-semibold">{formatUsd(terms.agreed_price_usd)}</span>
                    </Detail>
                    <Detail label="Network fee">
                      <span className="amount">{formatSats(terms.network_fee_sat)}</span>
                    </Detail>
                    <Detail label={buying ? 'Seller address' : 'Buyer address'}>
                      <span className="select-text font-mono text-[11px]">
                        {shortAddress(buying ? terms.seller_address : terms.buyer_address)}
                      </span>
                    </Detail>
                    {termsHash && (
                      <Detail label="Terms hash">
                        <code className="select-text font-mono text-[11px] text-hint">{shortAddress(termsHash, 8, 6)}</code>
                        <CopyButton text={termsHash} size="sm" />
                      </Detail>
                    )}
                  </dl>
                  <p className="pt-1 text-[11px] leading-relaxed text-hint">
                    Your signature approves exactly these terms. The swap starts once both sides sign.
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex items-center justify-center gap-2" aria-label="Signatures">
          <SignatureChip who="You" signed={mySigned} />
          <span
            className={cn('h-px w-6 transition-colors duration-fast ease-smooth-out', mySigned && counterpartySigned ? 'bg-success/60' : 'bg-separator')}
            aria-hidden="true"
          />
          <SignatureChip who={other} signed={counterpartySigned} />
        </div>

        <div className="flex flex-col gap-1">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={step} variants={textSwap} initial="initial" animate="animate" exit="exit" className="flex flex-col">
              {step === 'sign' ? (
                <Button variant="primary" size="lg" fullWidth loading={signing} onClick={onSign}>
                  Approve & Sign
                </Button>
              ) : step === 'wait' ? (
                (waitingAction ?? (
                  <p role="status" className="flex h-12 items-center justify-center gap-2 text-sm text-hint">
                    Waiting for {other}
                    <ThinkingDots />
                  </p>
                ))
              ) : (
                <p role="status" className="flex h-12 items-center justify-center gap-2 text-sm font-medium text-success">
                  <Check size={16} aria-hidden="true" />
                  Both signed · the swap starts
                </p>
              )}
            </motion.div>
          </AnimatePresence>
          {onCancel && step !== 'done' && (
            <Button variant="ghost" size="sm" fullWidth disabled={signing} loading={cancelling} onClick={onCancel} className="text-hint hover:text-danger">
              Cancel deal
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
