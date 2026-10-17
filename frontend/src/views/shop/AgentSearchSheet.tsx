import { useState, type FormEvent } from 'react'
import { useAgentSearch, type Market, type ShopListing, type WalletState } from '@/api'
import { AssetBadge, Button, FormNote, NumberField, SegmentedControl, Sheet } from '@/components/ui'
import { formatAssetAmount } from '@/lib/format'
import { proRataPrice, suggestedLimits } from '@/lib/lots'
import { useWalletContext } from '@/lib/navigation'
import { BuyerLimits } from '../shared/BuyerLimits'
import { StrategyPicker } from '../shared/StrategyPicker'
import { useBuyerLimits } from '../shared/useBuyerLimits'

const NUMBER = /^\d*\.?\d*$/

function parse(text: string): number | null {
  const value = text.trim()
  if (!value || !NUMBER.test(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

interface AgentSearchSheetProps {
  open: boolean
  onClose: () => void
  market: Market
  wallet: WalletState
  /** Current Shop listings, to prefill the amount with the largest lot on sale. */
  listings: ShopListing[]
}

/** The buyer's agent searches the Shop and opens a negotiation with the best matching Seller Desk. */
export function AgentSearchSheet({ open, onClose, market, wallet, listings }: AgentSearchSheetProps) {
  const { navigate } = useWalletContext()
  const { run, pending, error, reset } = useAgentSearch()
  const tradable = market.assets.filter((a) => a.source === 'p2p_negotiation')
  const largestLot = (id: string) =>
    Math.max(0, ...listings.filter((l) => l.kind === 'sell' && !l.is_mine && l.asset.asset_id === id).map((l) => l.amount))
  const lotText = (id: string) => {
    const lot = largestLot(id)
    const precision = tradable.find((a) => a.asset_id === id)?.precision ?? 0
    return lot > 0 ? String(lot / 10 ** precision) : ''
  }
  const [assetId, setAssetId] = useState(tradable[0]?.asset_id ?? '')
  // Until edited, the amount follows the largest lot on sale (the listings may arrive after mount).
  const [typedAmount, setTypedAmount] = useState<string | null>(null)
  const amount = typedAmount ?? lotText(assetId)
  const [prompt, setPrompt] = useState(wallet.agent_profile.buyer_ai_prompt)
  const [touched, setTouched] = useState(false)

  const asset = tradable.find((a) => a.asset_id === assetId)
  const amountValue = parse(amount)
  const atomic = amountValue === null || !asset ? null : Math.round(amountValue * 10 ** asset.precision)
  // Until edited, the limits follow the best list price for this amount among the sellers the
  // agent may pick (a part of a larger lot included, rings left out).
  const payment = market.assets.find((a) => a.source === 'fixed_peg')
  const paymentBalance = wallet.assets.find((a) => a.asset_id === payment?.asset_id)
  const available = paymentBalance ? paymentBalance.amount / 10 ** paymentBalance.precision : 0
  const bestPrice = atomic && atomic > 0
    ? Math.min(
        ...listings
          .filter((l) => l.kind === 'sell' && !l.is_mine && l.asset.asset_id === assetId && l.amount >= atomic)
          .filter((l) => l.trust.trust_tier !== 'Ring Anomaly Detected')
          .map((l) => proRataPrice(l.price_usd, l.amount, atomic)),
      )
    : Infinity
  const limits = useBuyerLimits(
    { target: String(wallet.agent_profile.buyer_target_usd || ''), ceiling: String(wallet.agent_profile.buyer_max_ceiling_usd || '') },
    Number.isFinite(bestPrice) ? suggestedLimits(bestPrice, available) : null,
  )
  const ceilingValue = parse(limits.ceiling)
  const targetValue = parse(limits.target)

  const amountError = atomic === null || atomic <= 0 ? 'Enter an amount greater than 0.' : undefined
  const ceilingError = ceilingValue === null || ceilingValue <= 0 ? 'Enter a maximum greater than 0.' : undefined
  let targetError: string | undefined
  if (targetValue === null || targetValue <= 0) targetError = 'Enter a target greater than 0.'
  else if (ceilingValue !== null && targetValue > ceilingValue) targetError = 'The target must not exceed your maximum.'

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (amountError || ceilingError || targetError || !asset || atomic === null || ceilingValue === null || targetValue === null || pending) return
    run({
      buyer_wallet_id: wallet.wallet_id,
      asset_id: asset.asset_id,
      rgb_amount: atomic,
      buyer_max_ceiling_usd: ceilingValue,
      buyer_target_usd: targetValue,
      buyer_ai_prompt: prompt,
    }).then(
      (result) => {
        onClose()
        navigate('trade', { sessionId: result.session.session_id })
      },
      () => {},
    )
  }

  return (
    <Sheet
      open={open}
      onClose={() => {
        reset()
        onClose()
      }}
      title="Find with my agent"
    >
      <form className="flex flex-col gap-5" onSubmit={submit}>
        <p className="text-sm text-hint">It picks the best fitting seller, a part of a larger lot included, and negotiates for you.</p>

        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold">How much</h3>
            {tradable.length === 1 && asset && <AssetBadge ticker={asset.ticker} asset_id={asset.asset_id} showTicker />}
          </div>
          {tradable.length > 1 && (
            <SegmentedControl
              fullWidth
              layoutId="shop-agent-asset"
              options={tradable.map((a) => ({ value: a.asset_id, label: a.ticker }))}
              value={assetId}
              onChange={setAssetId}
            />
          )}
          <NumberField
            label="Amount"
            placeholder="0"
            value={amount}
            suffix={asset?.ticker}
            invalid={touched && Boolean(amountError)}
            onChange={(e) => setTypedAmount(e.target.value)}
          />
          <FormNote error={touched ? amountError : undefined}>
            {largestLot(assetId) > 0 && asset && `Largest lot on sale: ${formatAssetAmount(largestLot(assetId), asset.precision, asset.ticker)}`}
          </FormNote>
        </div>

        <BuyerLimits
          target={limits.target}
          ceiling={limits.ceiling}
          onTarget={limits.onTarget}
          onCeiling={limits.onCeiling}
          targetError={targetError}
          ceilingError={ceilingError}
          show={touched}
        />

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-semibold">Strategy</h3>
          <StrategyPicker role="buyer" layoutId="shop-agent-strategy" value={prompt} onChange={setPrompt} />
        </div>

        <div className="flex flex-col gap-2">
          <p className="min-h-4 text-xs text-danger" role="alert">
            {error?.message}
          </p>
          <Button type="submit" fullWidth trailingArrow loading={pending}>
            Search and negotiate
          </Button>
        </div>
      </form>
    </Sheet>
  )
}
