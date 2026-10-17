import { ArrowLeft, ChevronRight } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import {
  useCreateSession,
  type Contact,
  type Market,
  type PublicDesk,
  type WalletState,
} from '@/api'
import {
  AssetBadge,
  Avatar,
  Badge,
  Button,
  Card,
  CardContent,
  Chip,
  FormNote,
  IconButton,
  NumberField,
  SegmentedControl,
  Sheet,
  TrustBadge,
} from '@/components/ui'
import { formatAssetAmount, formatUnitPrice, formatUsd, shortAddress } from '@/lib/format'
import { lotIssue, minLotAmount, proRataPrice, suggestedLimits } from '@/lib/lots'
import { useWalletContext } from '@/lib/navigation'
import { BuyerLimits } from '../shared/BuyerLimits'
import { StrategyPicker } from '../shared/StrategyPicker'
import { useBuyerLimits } from '../shared/useBuyerLimits'

const NUMBER = /^\d*\.?\d*$/

/** Parts of a desk's lot offered as one-tap amounts. */
const PARTS = [
  { share: 0.25, label: '25%' },
  { share: 0.5, label: '50%' },
  { share: 0.75, label: '75%' },
  { share: 1, label: 'All' },
] as const

function parse(text: string): number | null {
  const value = text.trim()
  if (!value || !NUMBER.test(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/** Atomic units → the text of an amount input. */
function amountText(atomic: number, precision: number): string {
  return atomic > 0 ? String(atomic / 10 ** precision) : ''
}

/** The offer being answered: who sells, how much, and the public list price for the whole lot. */
function OfferSummary({ contact, desk }: { contact: Contact; desk: PublicDesk }) {
  const unit = formatUnitPrice(desk.asking_price_usd, desk.offered_amount, desk.asset.precision)
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="flex items-center gap-3">
          <Avatar seed={contact.address} label={contact.alias ?? undefined} size="lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-sm font-semibold">{contact.alias ?? shortAddress(contact.address)}</span>
            <TrustBadge tier={contact.trust.trust_tier} reliabilityPct={contact.trust.reliability_pct} size="sm" explain className="self-start" />
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-control bg-surface-muted/60 p-3">
          <AssetBadge ticker={desk.asset.ticker} asset_id={desk.asset.asset_id} showTicker />
          <div className="flex flex-col items-end">
            <span className="amount text-sm font-semibold">{formatAssetAmount(desk.offered_amount, desk.asset.precision, desk.asset.ticker)}</span>
            <span className="amount text-xs text-hint">
              {formatUsd(desk.asking_price_usd)}
              {unit && ` · ${unit} each`}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  )
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
  const initialContact = choices.find((c) => c.address === initialAddress)
  // Arriving from an offer (Shop or Contacts): the asset is the offer's; amount and limits are asked.
  const offer = initialContact?.desk ? { contact: initialContact, desk: initialContact.desk } : null
  const [assetId, setAssetId] = useState(initialContact?.desk?.asset.asset_id ?? tradable[0]?.asset_id ?? '')
  const [amount, setAmount] = useState(
    initialContact?.desk ? amountText(initialContact.desk.offered_amount, initialContact.desk.asset.precision) : '',
  )
  const [prompt, setPrompt] = useState(wallet.agent_profile.buyer_ai_prompt)
  const [touched, setTouched] = useState(false)

  const contact = choices.find((c) => c.address === address)
  const asset = tradable.find((a) => a.asset_id === assetId)
  const precision = asset?.precision ?? 0
  const desk = contact?.desk?.asset.asset_id === assetId ? contact.desk : undefined
  // Without the seller's consent only the whole lot can be bought: the amount is locked to it.
  const fullOnly = desk !== undefined && !desk.allow_partial

  const amountValue = parse(amount)
  const atomic = amountValue === null ? null : Math.round(amountValue * 10 ** precision)
  const listPrice = desk && atomic !== null && atomic > 0 ? proRataPrice(desk.asking_price_usd, desk.offered_amount, atomic) : null
  // Until edited, the limits follow the list price of the amount.
  const limits = useBuyerLimits(
    { target: String(wallet.agent_profile.buyer_target_usd || ''), ceiling: String(wallet.agent_profile.buyer_max_ceiling_usd || '') },
    listPrice === null ? null : suggestedLimits(listPrice, available),
  )
  const ceilingValue = parse(limits.ceiling)
  const targetValue = parse(limits.target)

  let amountError: string | undefined
  if (!amount || atomic === null || atomic <= 0) amountError = 'Enter an amount greater than 0.'
  else if (desk) {
    const lot = formatAssetAmount(desk.offered_amount, precision, asset?.ticker)
    const issue = lotIssue(desk, atomic)
    if (issue === 'exceeds_lot') amountError = `The seller offers ${lot}.`
    else if (issue === 'partial_not_allowed') amountError = `Full order only: buy all ${lot}.`
    else if (issue === 'amount_too_small') {
      amountError = `Take at least ${formatAssetAmount(minLotAmount(desk.asking_price_usd, desk.offered_amount), precision, asset?.ticker)}: 1 ${payment?.ticker ?? 'USDT'} worth.`
    }
  }

  let ceilingError: string | undefined
  if (!limits.ceiling || ceilingValue === null || ceilingValue <= 0) ceilingError = 'Enter a maximum greater than 0.'
  else if (ceilingValue > available) ceilingError = `Your balance is ${formatAssetAmount(paymentBalance?.amount ?? 0, paymentBalance?.precision ?? 0, payment?.ticker)}.`

  let targetError: string | undefined
  if (!limits.target || targetValue === null || targetValue <= 0) targetError = 'Enter a target greater than 0.'
  else if (ceilingValue !== null && targetValue > ceilingValue) targetError = 'The target must not exceed your maximum.'

  const valid = Boolean(address && asset && !amountError && !ceilingError && !targetError)

  const editAmount = (text: string) => {
    setAmount(text)
    setTouched(true)
  }

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

  const amountCard = (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">How much</h3>
          <div className="flex items-center gap-2">
            {fullOnly && (
              <Badge variant="outline" size="sm">
                Full order only
              </Badge>
            )}
            {!offer && tradable.length === 1 && asset && <AssetBadge ticker={asset.ticker} asset_id={asset.asset_id} showTicker />}
          </div>
        </div>
        {!offer && tradable.length > 1 && (
          <SegmentedControl
            fullWidth
            layoutId={`trade-asset-${wallet.wallet_id}`}
            options={tradable.map((a) => ({ value: a.asset_id, label: a.ticker }))}
            value={assetId}
            onChange={(id) => {
              setAssetId(id)
              setTouched(true)
            }}
          />
        )}
        <NumberField
          label="Amount"
          placeholder="0"
          value={amount}
          suffix={asset?.ticker}
          disabled={fullOnly}
          invalid={show && Boolean(amountError)}
          onChange={(e) => editAmount(e.target.value)}
        />
        {desk && (
          <div className="flex gap-2" role="group" aria-label="Part of the lot">
            {PARTS.map((part) => {
              const partAtomic = Math.floor(desk.offered_amount * part.share)
              return (
                <Chip
                  key={part.label}
                  active={atomic === partAtomic}
                  // "All" stays available: it is the only amount a full order allows.
                  disabled={fullOnly && partAtomic !== desk.offered_amount}
                  onClick={() => editAmount(amountText(partAtomic, precision))}
                >
                  {part.label}
                </Chip>
              )
            })}
          </div>
        )}
        <FormNote error={show ? amountError : undefined}>
          {listPrice !== null && `List price for this amount: ${formatUsd(listPrice)}`}
        </FormNote>
      </CardContent>
    </Card>
  )

  return (
    <form className="flex flex-col justify-start gap-4 p-4" onSubmit={submit}>
      <header className="flex items-center gap-2">
        {canGoBack && (
          <IconButton aria-label="Back" onClick={back}>
            <ArrowLeft size={18} aria-hidden="true" />
          </IconButton>
        )}
        <h1 className="text-lg font-semibold">{offer ? `Buy ${offer.desk.asset.ticker}` : 'New deal'}</h1>
      </header>

      {offer ? (
        <OfferSummary contact={offer.contact} desk={offer.desk} />
      ) : (
        <section className="flex flex-col gap-2" aria-label="Counterparty">
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
          <FormNote error={show && !address ? 'Choose who you want to trade with.' : undefined} className="px-1" />
        </section>
      )}

      {amountCard}

      <Card>
        <CardContent className="pt-4">
          <BuyerLimits
            target={limits.target}
            ceiling={limits.ceiling}
            onTarget={(text) => {
              limits.onTarget(text)
              setTouched(true)
            }}
            onCeiling={(text) => {
              limits.onCeiling(text)
              setTouched(true)
            }}
            targetError={targetError}
            ceilingError={ceilingError}
            show={show}
          />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-3 pt-4">
          <h3 className="text-sm font-semibold">Strategy</h3>
          <StrategyPicker role="buyer" layoutId={`buyer-strategy-${wallet.wallet_id}`} value={prompt} onChange={setPrompt} />
        </CardContent>
      </Card>

      <div className="flex flex-col gap-2">
        <p className="min-h-4 text-xs text-danger" role="alert">
          {error?.message}
        </p>
        <Button type="submit" fullWidth trailingArrow loading={pending} disabled={touched && !valid}>
          Let my agent negotiate
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
                  setAddress(c.address)
                  setTouched(true)
                  if (c.desk) {
                    setAssetId(c.desk.asset.asset_id)
                    setAmount(amountText(c.desk.offered_amount, c.desk.asset.precision))
                  }
                  setPickerOpen(false)
                }}
              >
                <Avatar seed={c.address} label={c.alias ?? undefined} />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate text-sm font-semibold">{c.alias ?? shortAddress(c.address)}</span>
                  <TrustBadge tier={c.trust.trust_tier} reliabilityPct={c.trust.reliability_pct} size="sm" className="self-start" />
                </span>
                {c.desk && (
                  <span className="amount shrink-0 text-xs text-hint">
                    {formatAssetAmount(c.desk.offered_amount, c.desk.asset.precision, c.desk.asset.ticker)}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      </Sheet>
    </form>
  )
}
