import { Lock } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useAgentSearch, type Market, type WalletState } from '@/api'
import { AssetBadge, Button, Input, SegmentedControl, Sheet, TextArea } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'

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
}

/** The buyer's agent searches the Shop and opens a negotiation with the best matching Seller Desk. */
export function AgentSearchSheet({ open, onClose, market, wallet }: AgentSearchSheetProps) {
  const { navigate } = useWalletContext()
  const { run, pending, error, reset } = useAgentSearch()
  const tradable = market.assets.filter((a) => a.source === 'p2p_negotiation')
  const [assetId, setAssetId] = useState(tradable[0]?.asset_id ?? '')
  const [amount, setAmount] = useState('')
  const [ceiling, setCeiling] = useState(String(wallet.agent_profile.buyer_max_ceiling_usd || ''))
  const [target, setTarget] = useState(String(wallet.agent_profile.buyer_target_usd || ''))
  const [prompt, setPrompt] = useState(wallet.agent_profile.buyer_ai_prompt)
  const [touched, setTouched] = useState(false)

  const asset = tradable.find((a) => a.asset_id === assetId)
  const amountValue = parse(amount)
  const atomic = amountValue === null || !asset ? null : Math.round(amountValue * 10 ** asset.precision)
  const ceilingValue = parse(ceiling)
  const targetValue = parse(target)

  const amountError = atomic === null || atomic <= 0 ? 'Enter an amount greater than 0.' : undefined
  const ceilingError = ceilingValue === null || ceilingValue <= 0 ? 'Enter a budget greater than 0.' : undefined
  let targetError: string | undefined
  if (targetValue === null || targetValue <= 0) targetError = 'Enter a target greater than 0.'
  else if (ceilingValue !== null && targetValue > ceilingValue) targetError = 'Target must not exceed your maximum budget.'

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
      <form className="flex flex-col gap-1" onSubmit={submit}>
        <p className="pb-2 text-sm text-hint">
          Your agent searches the Shop for the best fitting seller and starts negotiating for you.
        </p>
        <span className="text-xs font-medium text-hint">Asset</span>
        {tradable.length > 1 ? (
          <SegmentedControl
            fullWidth
            layoutId="shop-agent-asset"
            options={tradable.map((a) => ({ value: a.asset_id, label: a.ticker }))}
            value={assetId}
            onChange={setAssetId}
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
          error={touched ? amountError : undefined}
          containerClassName="mt-3"
          onChange={(e) => setAmount(e.target.value)}
        />
        <Input
          className="amount"
          label="Maximum budget (secret)"
          inputMode="decimal"
          placeholder="0.00"
          value={ceiling}
          prefix={<Lock size={14} aria-hidden="true" />}
          error={touched ? ceilingError : undefined}
          hint="Stays on this device's agent."
          onChange={(e) => setCeiling(e.target.value)}
        />
        <Input
          className="amount"
          label="Target price"
          inputMode="decimal"
          placeholder="0.00"
          value={target}
          prefix="$"
          error={touched ? targetError : undefined}
          onChange={(e) => setTarget(e.target.value)}
        />
        <TextArea
          label="Instructions for your agent"
          rows={2}
          maxLength={500}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <p className="min-h-4 text-xs text-danger" role="alert">
          {error?.message}
        </p>
        <Button type="submit" fullWidth trailingArrow loading={pending}>
          Search and negotiate
        </Button>
      </form>
    </Sheet>
  )
}
