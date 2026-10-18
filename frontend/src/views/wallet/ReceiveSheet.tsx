import { QRCodeSVG } from 'qrcode.react'
import { AnimatePresence, motion } from 'motion/react'
import { memo, useState, type FormEvent } from 'react'
import { api, useMutation, type Market, type ReceiveInvoice, type WalletId } from '@/api'
import { Button, CopyButton, FormNote, NumberField, SegmentedControl, Sheet } from '@/components/ui'
import { cn } from '@/lib/cn'
import { formatAssetAmount } from '@/lib/format'
import { fade } from '@/lib/motion'
import { parseAmount } from '@/vault'

interface ReceiveSheetProps {
  open: boolean
  onClose: () => void
  walletId: WalletId
  address: string
  market: Market | undefined
}

type Mode = 'address' | 'invoice'

const MODES: { value: Mode; label: string }[] = [
  { value: 'address', label: 'Address' },
  { value: 'invoice', label: 'RGB invoice' },
]

/**
 * The wallet re-renders on every poll. Memoizing the QR keeps it from being recomputed
 * while the sheet animates or sits open: it only changes when the address does.
 */
const AddressQr = memo(function AddressQr({ value }: { value: string }) {
  return (
    <div className="rounded-card bg-white p-3">
      <QRCodeSVG value={value} size={176} />
    </div>
  )
})

/** The on-chain address, or an RGB invoice for an asset and amount (what RGB transfers pay). */
export function ReceiveSheet({ open, onClose, walletId, address, market }: ReceiveSheetProps) {
  const [mode, setMode] = useState<Mode>('address')
  return (
    <Sheet open={open} onClose={onClose} title="Receive">
      <div className="mx-auto flex w-full max-w-md flex-col gap-4">
        <SegmentedControl fullWidth size="md" options={MODES} value={mode} onChange={setMode} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={mode} variants={fade} initial="initial" animate="animate" exit="exit">
            {mode === 'address' ? <AddressPanel address={address} /> : <InvoicePanel walletId={walletId} market={market} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </Sheet>
  )
}

function AddressPanel({ address }: { address: string }) {
  return (
    <div className="flex flex-col items-center gap-4">
      <AddressQr value={address} />
      <CopyRow text={address} />
      <p className="text-xs text-hint">Only send regtest assets to this address.</p>
    </div>
  )
}

function CopyRow({ text, mono = false }: { text: string; mono?: boolean }) {
  return (
    <div className="flex w-full items-center gap-2 rounded-control bg-surface-muted py-2 pr-2 pl-3">
      <span className={cn('select-text min-w-0 flex-1 break-all', mono ? 'font-mono text-[11px]' : 'text-xs')}>{text}</span>
      <CopyButton text={text} size="md" />
    </div>
  )
}

const createInvoice = (...args: Parameters<typeof api.receiveInvoice>) => api.receiveInvoice(...args)

function InvoicePanel({ walletId, market }: { walletId: WalletId; market: Market | undefined }) {
  const assets = market?.assets ?? []
  const [assetId, setAssetId] = useState(() => assets[0]?.asset_id ?? '')
  const [text, setText] = useState('')
  const [touched, setTouched] = useState(false)
  const [invoice, setInvoice] = useState<ReceiveInvoice | null>(null)
  const create = useMutation(createInvoice)
  const asset = assets.find((a) => a.asset_id === assetId) ?? assets[0]

  if (!asset) return <p className="py-6 text-center text-sm text-hint">No RGB assets yet.</p>

  if (invoice) {
    return (
      <div className="flex flex-col items-center gap-4">
        <AddressQr value={invoice.invoice} />
        <p className="amount text-base font-semibold">{formatAssetAmount(invoice.amount, asset.precision, asset.ticker)}</p>
        <CopyRow text={invoice.invoice} mono />
        <Button variant="ghost" size="sm" onClick={() => setInvoice(null)}>
          New invoice
        </Button>
      </div>
    )
  }

  const amount = parseAmount(text, asset.precision)
  const issue = amount === null || amount <= 0 ? 'Enter a whole amount greater than 0.' : undefined
  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (issue || amount === null || create.pending) return
    create.run(walletId, asset.asset_id, amount).then(setInvoice, () => {})
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      {assets.length > 1 && (
        <SegmentedControl fullWidth size="md" options={assets.map((a) => ({ value: a.asset_id, label: a.ticker }))} value={asset.asset_id} onChange={setAssetId} />
      )}
      <div className="flex flex-col gap-1.5">
        <NumberField
          label="Amount"
          placeholder="0"
          value={text}
          suffix={asset.ticker}
          invalid={touched && Boolean(issue)}
          onChange={(event) => {
            setText(event.target.value)
            create.reset()
          }}
        />
        <FormNote error={(touched ? issue : undefined) ?? create.error?.message} />
      </div>
      <Button type="submit" fullWidth loading={create.pending}>
        Create invoice
      </Button>
    </form>
  )
}
