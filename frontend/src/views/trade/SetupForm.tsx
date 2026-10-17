import { ArrowLeft, ChevronRight, Lock } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import {
  useCreateSession,
  type Contact,
  type Market,
  type WalletState,
} from '@/api'
import { AssetBadge, Avatar, Button, Card, CardContent, IconButton, Input, SegmentedControl, Sheet, TextArea, TrustBadge } from '@/components/ui'
import { formatAssetAmount, shortAddress } from '@/lib/format'
import { useWalletContext } from '@/lib/navigation'

const NUMBER = /^\d*\.?\d*$/

function parse(text: string): number | null {
  const value = text.trim()
  if (!value || !NUMBER.test(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

interface SetupFormProps {
  wallet: WalletState
  contacts: Contact[]
  market: Market
  initialAddress?: string
  onCreated: (sessionId: string) => void
}

export function SetupForm({ wallet, contacts, market, initialAddress, onCreated }: SetupFormProps) {
  const { canGoBack, back } = useWalletContext()
  const { run, pending, error } = useCreateSession()

  const tradable = market.assets.filter((a) => a.source === 'p2p_negotiation')
  const payment = market.assets.find((a) => a.source === 'fixed_peg')
  const paymentBalance = wallet.assets.find((a) => a.asset_id === payment?.asset_id)
  const available = paymentBalance ? paymentBalance.amount / 10 ** paymentBalance.precision : 0

  const choices = contacts.filter((c) => c.address !== wallet.address)
  const [address, setAddress] = useState(initialAddress ?? '')
  const [pickerOpen, setPickerOpen] = useState(false)
  const [assetId, setAssetId] = useState(tradable[0]?.asset_id ?? '')
  const [amount, setAmount] = useState('')
  const [ceiling, setCeiling] = useState(String(wallet.agent_profile.buyer_max_ceiling_usd || ''))
  const [target, setTarget] = useState(String(wallet.agent_profile.buyer_target_usd || ''))
  const [prompt, setPrompt] = useState(wallet.agent_profile.buyer_ai_prompt)
  const [touched, setTouched] = useState(false)

  const contact = choices.find((c) => c.address === address)
  const asset = tradable.find((a) => a.asset_id === assetId)
  // The buyer may not hold the traded asset yet, so its precision comes from a held balance or defaults to whole units.
  const precision = wallet.assets.find((a) => a.asset_id === assetId)?.precision ?? 0

  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value)
    setTouched(true)
  }

  const amountValue = parse(amount)
  const ceilingValue = parse(ceiling)
  const targetValue = parse(target)
  const atomic = amountValue === null ? null : Math.round(amountValue * 10 ** precision)

  let amountError: string | undefined
  if (!amount || atomic === null || atomic <= 0) amountError = 'Enter an amount greater than 0.'

  let ceilingError: string | undefined
  if (!ceiling || ceilingValue === null || ceilingValue <= 0) ceilingError = 'Enter a budget greater than 0.'
  else if (ceilingValue > available) ceilingError = `Your balance is ${formatAssetAmount(paymentBalance?.amount ?? 0, paymentBalance?.precision ?? 0, payment?.ticker)}.`

  let targetError: string | undefined
  if (!target || targetValue === null || targetValue <= 0) targetError = 'Enter a target greater than 0.'
  else if (ceilingValue !== null && targetValue > ceilingValue) targetError = 'Target must not exceed your maximum budget.'

  const valid = Boolean(address && asset && !amountError && !ceilingError && !targetError)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (!valid || pending || !asset || atomic === null || ceilingValue === null || targetValue === null) return
    run({
      buyer_wallet_id: wallet.wallet_id,
      seller_address: address,
      asset_id: asset.asset_id,
      rgb_amount: atomic,
      buyer_max_ceiling_usd: ceilingValue,
      buyer_target_usd: targetValue,
      buyer_ai_prompt: prompt,
    }).then(
      (session) => onCreated(session.session_id),
      () => {},
    )
  }

  const show = touched

  return (
    <form className="flex flex-col justify-start gap-4 p-4" onSubmit={submit}>
      <header className="flex items-center gap-2">
        {canGoBack && (
          <IconButton aria-label="Back" onClick={back}>
            <ArrowLeft size={18} aria-hidden="true" />
          </IconButton>
        )}
        <div className="flex flex-col">
          <h1 className="text-lg font-semibold">P2P Trade</h1>
          <p className="text-sm text-hint">Your local agent negotiates for you.</p>
        </div>
      </header>

      <section className="flex flex-col gap-2" aria-label="Counterparty">
        <h2 className="px-1 text-sm font-semibold text-hint">Counterparty</h2>
        <Card interactive onClick={() => setPickerOpen(true)} aria-label="Choose counterparty" className="flex items-center gap-3 p-3">
          {contact ? (
            <>
              <Avatar seed={contact.address} label={contact.alias ?? undefined} size="lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <span className="truncate text-sm font-semibold">{contact.alias ?? shortAddress(contact.address)}</span>
                <TrustBadge tier={contact.trust.trust_tier} reliabilityPct={contact.trust.reliability_pct} size="sm" className="self-start" />
              </div>
            </>
          ) : (
            <span className="flex-1 text-sm text-hint">Choose a counterparty</span>
          )}
          <ChevronRight size={16} className="shrink-0 text-hint" aria-hidden="true" />
        </Card>
        <p className="min-h-4 px-1 text-xs text-danger">{show && !address ? 'Choose who you want to trade with.' : ''}</p>
      </section>

      <Card>
        <CardContent className="flex flex-col gap-1 pt-4">
          <span className="text-xs font-medium text-hint">Asset to buy</span>
          {tradable.length > 1 ? (
            <SegmentedControl
              fullWidth
              layoutId={`trade-asset-${wallet.wallet_id}`}
              options={tradable.map((a) => ({ value: a.asset_id, label: a.ticker }))}
              value={assetId}
              onChange={edit(setAssetId)}
            />
          ) : asset ? (
            <AssetBadge ticker={asset.ticker} asset_id={asset.asset_id} showTicker />
          ) : (
            <p className="text-sm text-hint">No tradable assets yet.</p>
          )}
          <Input
            className="amount"
            label="Amount"
            inputMode="decimal"
            placeholder="0"
            value={amount}
            suffix={asset?.ticker}
            error={show ? amountError : undefined}
            containerClassName="mt-3"
            onChange={(e) => edit(setAmount)(e.target.value)}
          />
          <Input
            className="amount"
            label="Maximum budget (secret)"
            inputMode="decimal"
            placeholder="0.00"
            value={ceiling}
            prefix={<Lock size={14} aria-hidden="true" />}
            suffix={payment?.ticker}
            error={show ? ceilingError : undefined}
            hint="Stays on this device's agent."
            onChange={(e) => edit(setCeiling)(e.target.value)}
          />
          <Input
            className="amount"
            label="Target price"
            inputMode="decimal"
            placeholder="0.00"
            value={target}
            prefix="$"
            error={show ? targetError : undefined}
            hint="What you would like to pay for the whole lot."
            onChange={(e) => edit(setTarget)(e.target.value)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-4">
          <TextArea
            label="Instructions for your agent"
            placeholder="Describe how your agent should negotiate."
            rows={3}
            maxLength={500}
            value={prompt}
            hint={`${prompt.length}/500`}
            onChange={(e) => edit(setPrompt)(e.target.value)}
          />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <p className="min-h-4 text-xs text-danger" role="alert">
          {error?.message}
        </p>
        <Button type="submit" fullWidth trailingArrow loading={pending} disabled={touched && !valid}>
          Start negotiation
        </Button>
      </div>

      <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)} title="Choose counterparty">
        <ul className="-mx-3 flex flex-col divide-y divide-separator">
          {choices.map((c) => (
            <li key={c.address}>
              <button
                type="button"
                className="pressable pressable-flat flex w-full items-center gap-3 p-3 text-left"
                onClick={() => {
                  edit(setAddress)(c.address)
                  setPickerOpen(false)
                }}
              >
                <Avatar seed={c.address} label={c.alias ?? undefined} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-semibold">{c.alias ?? shortAddress(c.address)}</span>
                  <TrustBadge tier={c.trust.trust_tier} reliabilityPct={c.trust.reliability_pct} size="sm" className="self-start" />
                </span>
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    </form>
  )
}
