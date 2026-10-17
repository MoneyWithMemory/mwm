import { Check } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useUpdateAgentProfile, type AgentProfile, type AssetBalance, type Market } from '@/api'
import { AssetBadge, Button, Card, CardContent, FormNote, NumberField, PrivacyTag, SegmentedControl, Toggle } from '@/components/ui'
import { formatAssetAmount, formatUnitPrice } from '@/lib/format'
import { textSwap } from '@/lib/motion'
import { StrategyPicker } from '../shared/StrategyPicker'

/** Starting values that differ from the saved profile, e.g. answering a request in the Shop. */
export interface SellerDraft {
  offered_asset_id?: string
  offered_amount?: number
  asking_price_usd?: number
}

interface SellerFormProps {
  walletId: string
  profile: AgentProfile
  assets: AssetBalance[]
  market: Market
  draft?: SellerDraft
  onSaved?: () => void
}

const NUMBER = /^\d*\.?\d*$/

function parse(text: string): number | null {
  const value = text.trim()
  if (!value || !NUMBER.test(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function toText(value: number): string {
  return value > 0 ? String(value) : ''
}

function CardTitle({ children }: { children: string }) {
  return <h3 className="text-sm font-semibold">{children}</h3>
}

export function SellerForm({ walletId, profile, assets, market, draft, onSaved }: SellerFormProps) {
  // Only negotiable assets can be sold: BTC pays fees and the pegged asset is the payment currency.
  const negotiable = new Set(market.assets.filter((a) => a.source === 'p2p_negotiation').map((a) => a.asset_id))
  const sellable = assets.filter((a) => negotiable.has(a.asset_id))
  const { run, pending, error } = useUpdateAgentProfile()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // A draft (answering a request) switches selling on and starts from the request's lot and price.
  const [active, setActive] = useState(draft ? true : profile.seller_active)
  const [assetId, setAssetId] = useState(draft?.offered_asset_id ?? profile.offered_asset_id ?? sellable[0]?.asset_id ?? '')
  const asset = sellable.find((a) => a.asset_id === assetId)
  const [amount, setAmount] = useState(toText((draft?.offered_amount ?? profile.offered_amount) / 10 ** (asset?.precision ?? 0)))
  const [ask, setAsk] = useState(toText(draft?.asking_price_usd ?? profile.asking_price_usd))
  const [reserve, setReserve] = useState(toText(profile.secret_min_reserve_usd))
  const [prompt, setPrompt] = useState(profile.seller_ai_prompt)
  const [touched, setTouched] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => () => clearTimeout(timer.current), [])

  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value)
    setTouched(true)
    setSaved(false)
  }

  const amountValue = parse(amount)
  const askValue = parse(ask)
  const reserveValue = parse(reserve)
  const precision = asset?.precision ?? 0
  const balance = asset ? asset.amount / 10 ** precision : 0

  let amountError: string | undefined
  if (amount && (amountValue === null || amountValue <= 0)) amountError = 'Enter an amount greater than 0.'
  else if (amountValue !== null && asset && amountValue > balance) {
    amountError = `You hold ${formatAssetAmount(asset.amount, precision, asset.ticker)}.`
  } else if (active && !amount) amountError = 'Enter an amount greater than 0.'

  let askError: string | undefined
  if (ask && (askValue === null || askValue <= 0)) askError = 'Enter a price greater than 0.'
  else if (active && !ask) askError = 'Enter a price greater than 0.'

  let reserveError: string | undefined
  if (reserve && reserveValue === null) reserveError = 'Enter a valid minimum.'
  else if (reserveValue !== null && askValue !== null && reserveValue > askValue) {
    reserveError = 'Your minimum must not exceed the asking price.'
  }

  const hasErrors = Boolean(amountError || askError || reserveError)
  const request = {
    seller_active: active,
    offered_asset_id: asset?.asset_id ?? null,
    offered_amount: Math.round((amountValue ?? 0) * 10 ** precision),
    asking_price_usd: askValue ?? 0,
    secret_min_reserve_usd: reserveValue ?? 0,
    seller_ai_prompt: prompt,
  }
  const dirty = (Object.keys(request) as (keyof typeof request)[]).some((k) => request[k] !== profile[k])
  const canSave = dirty && !hasErrors
  const unit = askValue && request.offered_amount > 0 ? formatUnitPrice(askValue, request.offered_amount, precision) : null

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!canSave || pending) return
    run(walletId, request).then(
      () => {
        setSaved(true)
        clearTimeout(timer.current)
        timer.current = setTimeout(() => setSaved(false), 1600)
        onSaved?.()
      },
      () => {},
    )
  }

  const label = saved ? 'Saved' : 'Save'
  const show = touched

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <Card>
        <CardContent className="pt-4">
          <Toggle
            checked={active}
            onChange={edit(setActive)}
            label={active ? 'Selling is on' : 'Selling is off'}
            description="Your agent answers buyers."
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <div className="flex items-center justify-between gap-3">
            <CardTitle>What you sell</CardTitle>
            {sellable.length === 1 && asset && <AssetBadge ticker={asset.ticker} asset_id={asset.asset_id} showTicker />}
          </div>
          {sellable.length > 1 && (
            <SegmentedControl
              fullWidth
              layoutId={`seller-asset-${walletId}`}
              options={sellable.map((a) => ({ value: a.asset_id, label: a.ticker }))}
              value={assetId}
              onChange={edit(setAssetId)}
            />
          )}
          {sellable.length === 0 ? (
            <p className="text-sm text-hint">You hold no RGB assets to sell yet.</p>
          ) : (
            <NumberField
              label="Amount"
              placeholder="0"
              value={amount}
              suffix={asset?.ticker}
              disabled={!asset}
              invalid={show && Boolean(amountError)}
              aside={
                asset && (
                  <button
                    type="button"
                    className="pressable pressable-flat amount rounded-full px-1.5 text-xs font-medium text-accent hover:bg-accent/10"
                    onClick={() => edit(setAmount)(String(balance))}
                  >
                    Max {formatAssetAmount(asset.amount, precision)}
                  </button>
                )
              }
              onChange={(e) => edit(setAmount)(e.target.value)}
            />
          )}
          <FormNote error={show ? amountError : undefined}>{asset && 'Buyers may take part of it, at the same unit price.'}</FormNote>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <CardTitle>Price for the whole lot</CardTitle>
          <div className="grid grid-cols-2 gap-3">
            <NumberField
              label="Asking"
              aside={<PrivacyTag kind="public" />}
              placeholder="0"
              prefix="$"
              value={ask}
              invalid={show && Boolean(askError)}
              onChange={(e) => edit(setAsk)(e.target.value)}
            />
            <NumberField
              label="Your minimum"
              aside={<PrivacyTag kind="private" />}
              placeholder="0"
              prefix="$"
              value={reserve}
              invalid={show && Boolean(reserveError)}
              onChange={(e) => edit(setReserve)(e.target.value)}
            />
          </div>
          <FormNote error={show ? (askError ?? reserveError) : undefined}>{unit && `${unit} per ${asset?.ticker ?? 'unit'}`}</FormNote>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <CardTitle>Strategy</CardTitle>
          <StrategyPicker role="seller" layoutId={`seller-strategy-${walletId}`} value={prompt} onChange={edit(setPrompt)} />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <p className="min-h-4 text-xs text-danger" role="alert">
          {error?.message}
        </p>
        <Button type="submit" fullWidth loading={pending} disabled={!canSave && !saved}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={label}
              className="flex items-center gap-1.5"
              variants={textSwap}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {saved && <Check size={16} aria-hidden="true" />}
              {label}
            </motion.span>
          </AnimatePresence>
        </Button>
      </div>
    </form>
  )
}
