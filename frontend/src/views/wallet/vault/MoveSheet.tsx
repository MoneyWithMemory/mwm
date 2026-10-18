import { Lock, Wallet } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useId, useState, type FormEvent } from 'react'
import type { Market, TransferResult, WalletId, WalletState } from '@/api'
import { Button, FormNote, MaxButton, NumberField, SegmentedControl, Sheet, StatusLine, SuccessCheck } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatAssetAmount } from '@/lib/format'
import { EASE_OUT, LOOP, SPRING_TABS, viewSwap } from '@/lib/motion'
import { deskLot, isPolicyDenied, maxMovable, moveIssue, parseAmount, useMove, vaultErrorText, type MoveDirection, type VaultState } from '@/vault'
import { TxidRow } from '../../trade/TxidRow'
import { partAssets, type PartAsset } from './assets'

/** How long the first step of the progress shows before "Confirming…" (the backend pays, then mines). */
const SENDING_MS = 1200
/** A refusal comes back within this: until then the form stays, with its button loading. */
const PROGRESS_DELAY_MS = 500

const PARTS = {
  wallet: { label: 'Wallet', icon: Wallet },
  vault: { label: 'Vault', icon: Lock },
} as const

/** Where each direction takes the funds from, and to. */
const ENDS: Record<MoveDirection, { from: keyof typeof PARTS; to: keyof typeof PARTS }> = {
  to_vault: { from: 'wallet', to: 'vault' },
  to_wallet: { from: 'vault', to: 'wallet' },
}

interface MoveSheetProps {
  open: boolean
  onClose: () => void
  walletId: WalletId
  direction: MoveDirection
  wallet: WalletState
  vault: VaultState
  market: Market | undefined
}

/** One amount from one part of the account to the other, in one confirm. */
export function MoveSheet({ open, onClose, ...flow }: MoveSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Move">
      <div className="mx-auto w-full max-w-md">
        <MoveFlow {...flow} onDone={onClose} />
      </div>
    </Sheet>
  )
}

type Phase =
  | { name: 'form' }
  | { name: 'moving'; direction: MoveDirection; asset: PartAsset; amount: number }
  | { name: 'done'; direction: MoveDirection; asset: PartAsset; result: TransferResult }

interface MoveFlowProps extends Omit<MoveSheetProps, 'open' | 'onClose'> {
  onDone: () => void
}

function MoveFlow({ walletId, direction: initialDirection, wallet, vault, market, onDone }: MoveFlowProps) {
  const assets = partAssets(vault, wallet.assets, market).map((a) => ({ ...a, listed: deskLot(wallet.agent_profile, a.asset_id) }))
  const [direction, setDirection] = useState(initialDirection)
  const [assetId, setAssetId] = useState(() => assets[0]?.asset_id ?? '')
  const [text, setText] = useState('')
  const [touched, setTouched] = useState(false)
  const [phase, setPhase] = useState<Phase>({ name: 'form' })
  const move = useMove()
  const asset = assets.find((a) => a.asset_id === assetId) ?? assets[0]

  if (!asset) return <p className="py-8 text-center text-sm text-hint">Nothing to move yet.</p>

  const amount = parseAmount(text, asset.precision)
  const issue = moveIssue(direction, asset, amount, vault.policy)
  const max = maxMovable(direction, asset, vault.policy)
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value)
    move.reset()
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (issue || amount === null || move.pending) return
    // The progress shows only once the move is under way: a refusal never reads "Sending…".
    const progress = setTimeout(() => setPhase({ name: 'moving', direction, asset, amount }), PROGRESS_DELAY_MS)
    move
      .run(direction, walletId, asset.asset_id, amount)
      .then(
        (result) => setPhase({ name: 'done', direction, asset, result }),
        () => setPhase({ name: 'form' }),
      )
      .finally(() => clearTimeout(progress))
  }

  const error = (touched ? issue : null) || (move.error ? vaultErrorText(move.error) : undefined)
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={phase.name} variants={viewSwap} initial="initial" animate="animate" exit="exit">
        {phase.name === 'form' && (
          <form className="flex flex-col gap-4" onSubmit={submit}>
            <DirectionPicker value={direction} asset={asset} onChange={edit(setDirection)} />
            {assets.length > 1 && (
              <SegmentedControl
                fullWidth
                size="md"
                options={assets.map((a) => ({ value: a.asset_id, label: a.ticker }))}
                value={asset.asset_id}
                onChange={edit(setAssetId)}
              />
            )}
            <div className="flex flex-col gap-1.5">
              <NumberField
                label="Amount"
                placeholder="0"
                value={text}
                suffix={asset.ticker}
                invalid={(touched && Boolean(issue)) || isPolicyDenied(move.error)}
                aside={
                  max > 0 && <MaxButton amount={formatAssetAmount(max, asset.precision)} onClick={() => edit(setText)(String(max / 10 ** asset.precision))} />
                }
                onChange={(event) => edit(setText)(event.target.value)}
              />
              <FormNote error={error || undefined} />
            </div>
            <Button type="submit" size="lg" fullWidth loading={move.pending}>
              Move to {PARTS[ENDS[direction].to].label}
            </Button>
          </form>
        )}
        {phase.name === 'moving' && <MoveProgress direction={phase.direction} asset={phase.asset} amount={phase.amount} />}
        {phase.name === 'done' && <MoveDone direction={phase.direction} asset={phase.asset} result={phase.result} onDone={onDone} />}
      </motion.div>
    </AnimatePresence>
  )
}

/** "To Vault" / "To Wallet", each with what its source holds of the asset, and a sliding highlight. */
function DirectionPicker({ value, asset, onChange }: { value: MoveDirection; asset: PartAsset; onChange: (direction: MoveDirection) => void }) {
  const layoutId = useId()
  return (
    <div role="radiogroup" aria-label="Direction" className="grid grid-cols-2 gap-1 rounded-card bg-surface-muted p-1 select-none">
      {(Object.keys(ENDS) as MoveDirection[]).map((direction) => {
        const selected = direction === value
        const { from, to } = ENDS[direction]
        const Icon = PARTS[to].icon
        return (
          <button
            key={direction}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(direction)}
            className={cn(
              'pressable pressable-flat relative isolate flex flex-col items-start gap-1 rounded-[calc(var(--radius-card)-4px)] px-3 py-2.5 text-left outline-none',
              selected ? 'text-fg' : 'text-hint hover:text-fg',
            )}
          >
            {selected && (
              <motion.span layoutId={layoutId} transition={SPRING_TABS} className="absolute inset-0 -z-10 rounded-[inherit] bg-surface-raised shadow-card" aria-hidden="true" />
            )}
            <span className="flex items-center gap-1.5 text-sm font-semibold">
              <Icon size={14} className={selected ? 'text-accent' : 'text-hint'} aria-hidden="true" />
              To {PARTS[to].label}
            </span>
            <span className="amount text-xs text-hint">
              {formatAssetAmount(from === 'wallet' ? asset.wallet : asset.vault, asset.precision, asset.ticker)} in {PARTS[from].label}
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** The two parts with a dot travelling from the source to the destination, while the move runs. */
function MoveTrack({ direction }: { direction: MoveDirection }) {
  const { from, to } = ENDS[direction]
  const end = (part: keyof typeof PARTS) => {
    const Icon = PARTS[part].icon
    return (
      <span className="flex flex-col items-center gap-1.5">
        <span className="grid size-12 place-items-center rounded-full bg-surface-muted text-fg" aria-hidden="true">
          <Icon size={20} />
        </span>
        <span className="text-xs text-hint">{PARTS[part].label}</span>
      </span>
    )
  }
  return (
    <div className="flex items-start gap-3" aria-hidden="true">
      {end(from)}
      <span className="relative mt-6 h-px w-20 bg-separator">
        <motion.span
          className="absolute -top-1 left-0 size-2 rounded-full bg-accent shadow-glow-soft"
          animate={{ x: [0, 72], opacity: [0, 1, 1, 0] }}
          transition={{ duration: LOOP.dots, ease: EASE_OUT, repeat: Infinity }}
        />
      </span>
      {end(to)}
    </div>
  )
}

function MoveProgress({ direction, asset, amount }: { direction: MoveDirection; asset: PartAsset; amount: number }) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setConfirming(true), SENDING_MS)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="flex flex-col items-center gap-5 py-8 text-center">
      <MoveTrack direction={direction} />
      <div className="flex flex-col items-center gap-1">
        <p className="amount text-2xl font-semibold">{formatAssetAmount(amount, asset.precision, asset.ticker)}</p>
        <StatusLine text={confirming ? 'Confirming…' : 'Sending on Bitcoin regtest…'} />
      </div>
    </div>
  )
}

function MoveDone({ direction, asset, result, onDone }: { direction: MoveDirection; asset: PartAsset; result: TransferResult; onDone: () => void }) {
  const toVault = direction === 'to_vault'
  return (
    <div className="flex flex-col items-center gap-4 pt-6 text-center">
      <SuccessCheck />
      <div className="flex flex-col items-center gap-1">
        <p className="amount text-2xl font-semibold">{formatAssetAmount(result.amount, asset.precision, asset.ticker)}</p>
        <p className="text-sm font-medium">Moved to {toVault ? 'Vault' : 'Wallet'}</p>
        {toVault && (
          <p className="flex items-center gap-1.5 text-xs text-hint">
            <Lock size={12} className="shrink-0 text-accent" aria-hidden="true" />
            Your agents can't see or spend it.
          </p>
        )}
      </div>
      <TxidRow txid={result.txid} label="Bitcoin regtest transaction" />
      <Button fullWidth onClick={onDone}>
        Done
      </Button>
    </div>
  )
}
