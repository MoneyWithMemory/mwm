import { useState, type FormEvent } from 'react'
import { useCreateWant, type Market } from '@/api'
import { AssetBadge, Button, Input, SegmentedControl, Sheet, TextArea } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'

const NUMBER = /^\d*\.?\d*$/
const NOTE_MAX = 140

function parse(text: string): number | null {
  const value = text.trim()
  if (!value || !NUMBER.test(value)) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

interface NewRequestSheetProps {
  open: boolean
  onClose: () => void
  market: Market
}

export function NewRequestSheet({ open, onClose, market }: NewRequestSheetProps) {
  const { walletId } = useWalletContext()
  const { run, pending, error, reset } = useCreateWant()
  const tradable = market.assets.filter((a) => a.source === 'p2p_negotiation')
  const [assetId, setAssetId] = useState(tradable[0]?.asset_id ?? '')
  const [amount, setAmount] = useState('')
  const [target, setTarget] = useState('')
  const [note, setNote] = useState('')
  const [touched, setTouched] = useState(false)

  const asset = tradable.find((a) => a.asset_id === assetId)
  const amountValue = parse(amount)
  const atomic = amountValue === null || !asset ? null : Math.round(amountValue * 10 ** asset.precision)
  const targetValue = parse(target)
  const amountError = atomic === null || atomic <= 0 ? 'Enter an amount greater than 0.' : undefined
  const targetError = targetValue === null || targetValue <= 0 ? 'Enter a price greater than 0.' : undefined

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (amountError || targetError || !asset || atomic === null || targetValue === null || pending) return
    run({ wallet_id: walletId, asset_id: asset.asset_id, amount: atomic, target_usd: targetValue, note: note.trim() || undefined }).then(
      () => {
        setAmount('')
        setTarget('')
        setNote('')
        setTouched(false)
        onClose()
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
      title="Post a request"
    >
      <form className="flex flex-col gap-1" onSubmit={submit}>
        <p className="pb-2 text-sm text-hint">
          Tell the market what you want. The price is public; your maximum budget stays with your agent.
        </p>
        <span className="text-xs font-medium text-hint">Asset</span>
        {tradable.length > 1 ? (
          <SegmentedControl
            fullWidth
            layoutId="shop-request-asset"
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
          label="Price you offer (public)"
          inputMode="decimal"
          placeholder="0.00"
          value={target}
          prefix="$"
          error={touched ? targetError : undefined}
          hint="Total for the whole lot. Visible to everyone."
          onChange={(e) => setTarget(e.target.value)}
        />
        <TextArea
          label="Note (optional)"
          rows={2}
          maxLength={NOTE_MAX}
          placeholder="Anything sellers should know."
          value={note}
          hint={`${note.length}/${NOTE_MAX}`}
          onChange={(e) => setNote(e.target.value)}
        />
        <p className="min-h-4 text-xs text-danger" role="alert">
          {error?.message}
        </p>
        <Button type="submit" fullWidth loading={pending}>
          Post request
        </Button>
      </form>
    </Sheet>
  )
}
