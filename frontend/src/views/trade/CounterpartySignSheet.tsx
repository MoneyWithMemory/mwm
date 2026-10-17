import { useSession, useSign, type WalletSummary } from '@/api'
import { ApprovalCard, Sheet, Skeleton, toast } from '@/components/ui'

interface CounterpartySignSheetProps {
  open: boolean
  onClose: () => void
  sessionId: string
  /** The counterparty, when its wallet lives on this device (demo): it signs with its own approval. */
  counterparty: WalletSummary
}

/**
 * Lets the other side of a deal sign from the same screen when both wallets are on this device.
 * The signature is still the counterparty's own, over its own view of the terms (2/2 holds).
 */
export function CounterpartySignSheet({ open, onClose, sessionId, counterparty }: CounterpartySignSheetProps) {
  const session = useSession(open ? sessionId : null, counterparty.wallet_id).data
  const sign = useSign()

  const onSign = () => {
    if (!session?.terms_hash) return
    sign.run(session.session_id, counterparty.wallet_id, session.terms_hash).then(
      () => {
        toast.success(`${counterparty.label} signed`, 'Both signatures are in: the swap starts now.')
        onClose()
      },
      (err: Error) => toast(err.message, { type: 'danger' }),
    )
  }

  const mySigned = session ? (session.my_role === 'buyer' ? session.buyer_signed : session.seller_signed) : false
  const otherSigned = session ? (session.my_role === 'buyer' ? session.seller_signed : session.buyer_signed) : false

  return (
    <Sheet open={open} onClose={onClose} title={`Sign as ${counterparty.label}`}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-hint">
          {counterparty.label} is also on this device, so it can approve these terms here, with its own signature.
        </p>
        {session?.terms ? (
          <ApprovalCard
            terms={session.terms}
            termsHash={session.terms_hash}
            assetTicker={session.asset.ticker}
            paymentTicker={session.payment_asset.ticker}
            myRole={session.my_role}
            mySigned={mySigned}
            counterpartySigned={otherSigned}
            signing={sign.pending}
            onSign={onSign}
          />
        ) : (
          <Skeleton className="h-80 rounded-card" />
        )}
      </div>
    </Sheet>
  )
}
