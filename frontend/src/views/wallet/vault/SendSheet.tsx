import { ClipboardPaste, ShieldCheck } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useId, useState, type FormEvent } from 'react'
import type { Market, TransferResult, WalletId } from '@/api'
import { Button, FormNote, SegmentedControl, Sheet, SuccessCheck, TextArea } from '@/components/ui'
import { formatAssetAmount } from '@/lib/format'
import { accordion, viewSwap } from '@/lib/motion'
import { asksForAsset, isPolicyDenied, useVaultSend, vaultErrorText } from '@/vault'
import { TxidRow } from '../../trade/TxidRow'
import { WdkNote } from './marks'

interface SendSheetProps {
  open: boolean
  onClose: () => void
  walletId: WalletId
  market: Market | undefined
}

/**
 * Pay an RGB invoice from the Vault. Its Tether WDK policy lets through only the Vault's own
 * wallet, so an outside invoice ends in a calm refusal: nothing leaves the Vault.
 */
export function SendSheet({ open, onClose, walletId, market }: SendSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Send from Vault">
      <div className="mx-auto w-full max-w-md">
        <SendFlow walletId={walletId} market={market} onDone={onClose} />
      </div>
    </Sheet>
  )
}

type Phase = { name: 'form' } | { name: 'refused'; message: string } | { name: 'sent'; result: TransferResult }

/** An invoice from a wallet that never held the asset names none: "rgb:~/…" in place of a contract id. */
const ASSETLESS = /^rgb:~\//i

function SendFlow({ walletId, market, onDone }: Omit<SendSheetProps, 'open' | 'onClose'> & { onDone: () => void }) {
  const [invoice, setInvoice] = useState('')
  // The Vault asked which asset the invoice wants (in case the text did not show that it names none).
  const [asked, setAsked] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>({ name: 'form' })
  const send = useVaultSend()
  const fieldId = useId()
  const canPaste = Boolean(navigator.clipboard?.readText)
  const text = invoice.trim()
  const assets = market?.assets ?? []
  // Without an asset in the invoice the user picks one: USDT unless they choose PEPE.
  const assetId = ASSETLESS.test(text) || asked ? (picked ?? assets[0]?.asset_id ?? null) : null

  const edit = (value: string) => {
    setInvoice(value)
    setAsked(false)
    setPicked(null)
    send.reset()
  }

  const paste = () => {
    navigator.clipboard.readText().then(
      (value) => edit(value.trim()),
      () => {},
    )
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!text || send.pending) return
    send.run(walletId, { invoice: text, asset_id: assetId ?? undefined }).then(
      (result) => setPhase({ name: 'sent', result }),
      (err) => {
        if (isPolicyDenied(err)) setPhase({ name: 'refused', message: vaultErrorText(err) })
        else if (asksForAsset(err)) setAsked(true)
      },
    )
  }

  const error = send.error && !isPolicyDenied(send.error) && !asksForAsset(send.error) ? vaultErrorText(send.error) : undefined

  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.div key={phase.name} variants={viewSwap} initial="initial" animate="animate" exit="exit">
        {phase.name === 'form' && (
          <form className="flex flex-col gap-2" onSubmit={submit}>
            <div className="flex min-h-8 items-center justify-between gap-2">
              <label htmlFor={fieldId} className="text-xs font-medium text-hint select-none">
                RGB invoice
              </label>
              {canPaste && (
                <Button variant="ghost" size="sm" onClick={paste}>
                  <ClipboardPaste size={14} aria-hidden="true" />
                  Paste
                </Button>
              )}
            </div>
            <TextArea
              id={fieldId}
              placeholder="rgb:…"
              rows={3}
              maxRows={5}
              value={invoice}
              onChange={(event) => edit(event.target.value)}
              error={error}
              className="font-mono text-xs break-all"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
            <AnimatePresence initial={false}>
              {assetId !== null && (
                <motion.div key="asset" className="overflow-hidden" variants={accordion} initial="initial" animate="animate" exit="exit">
                  <div className="flex flex-col gap-2 pb-3">
                    <SegmentedControl
                      fullWidth
                      size="md"
                      options={assets.map((a) => ({ value: a.asset_id, label: a.ticker }))}
                      value={assetId}
                      onChange={setPicked}
                    />
                    <FormNote>The invoice doesn't say which asset: pick one.</FormNote>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
            <Button type="submit" size="lg" fullWidth loading={send.pending} disabled={!text}>
              Send
            </Button>
          </form>
        )}
        {phase.name === 'refused' && (
          <Refusal
            message={phase.message}
            onBack={() => {
              send.reset()
              setPhase({ name: 'form' })
            }}
            onDone={onDone}
          />
        )}
        {phase.name === 'sent' && <Sent result={phase.result} market={market} onDone={onDone} />}
      </motion.div>
    </AnimatePresence>
  )
}

function Refusal({ message, onBack, onDone }: { message: string; onBack: () => void; onDone: () => void }) {
  return (
    <div className="flex flex-col items-center gap-4 pt-6 text-center" role="alert">
      <span className="grid size-14 place-items-center rounded-full bg-accent/15 text-accent shadow-glow-soft" aria-hidden="true">
        <ShieldCheck size={26} />
      </span>
      <div className="flex max-w-80 flex-col gap-1.5">
        <p className="text-base font-semibold">{message}</p>
        <p className="text-sm text-hint">Nothing left the Vault.</p>
      </div>
      <WdkNote>Protected by Tether WDK policy</WdkNote>
      <div className="flex w-full gap-2 pt-1">
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
        <Button fullWidth onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  )
}

function Sent({ result, market, onDone }: { result: TransferResult; market: Market | undefined; onDone: () => void }) {
  const asset = market?.assets.find((a) => a.asset_id === result.asset_id)
  return (
    <div className="flex flex-col items-center gap-4 pt-6 text-center">
      <SuccessCheck />
      <div className="flex flex-col items-center gap-1">
        <p className="amount text-2xl font-semibold">{formatAssetAmount(result.amount, asset?.precision ?? 0, asset?.ticker)}</p>
        <p className="text-sm font-medium">Sent to your Wallet</p>
      </div>
      <TxidRow txid={result.txid} label="Bitcoin regtest transaction" />
      <Button fullWidth onClick={onDone}>
        Done
      </Button>
    </div>
  )
}
