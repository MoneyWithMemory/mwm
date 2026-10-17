import { useMarket, useWallet } from '@/api'
import { ErrorState, Sheet, Skeleton, toast } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { SellerForm, type SellerDraft } from './SellerForm'

interface SellerDeskSheetProps {
  open: boolean
  onClose: () => void
  /** Set when answering a request: the form starts from its lot and price. */
  draft?: SellerDraft
}

/** The wallet's Seller Desk (public offer + private reserve) in a sheet, opened from the Shop. */
export function SellerDeskSheet({ open, onClose, draft }: SellerDeskSheetProps) {
  const { walletId } = useWalletContext()
  const wallet = useWallet(open ? walletId : null)
  const market = useMarket()

  const onSaved = () => {
    toast.success('Offer saved', 'Buyers and their agents see your list price; your minimum stays private.')
    onClose()
  }

  let body
  if (wallet.data && market.data) {
    body = (
      <SellerForm
        key={`${walletId}:${draft?.offered_asset_id ?? ''}:${draft?.offered_amount ?? ''}:${draft?.asking_price_usd ?? ''}`}
        walletId={walletId}
        profile={wallet.data.agent_profile}
        assets={wallet.data.assets}
        market={market.data}
        draft={draft}
        onSaved={onSaved}
      />
    )
  } else if (wallet.error || market.error) {
    body = (
      <ErrorState
        title="Couldn't load your offer"
        message="Check your connection and try again."
        onRetry={() => {
          wallet.refresh()
          market.refresh()
        }}
      />
    )
  } else {
    body = (
      <div className="flex flex-col gap-4" role="status" aria-label="Loading your offer">
        <Skeleton className="h-16 rounded-card" />
        <Skeleton className="h-72 rounded-card" />
      </div>
    )
  }

  return (
    <Sheet open={open} onClose={onClose} title={draft ? 'Sell to this request' : 'Your offer'}>
      {body}
    </Sheet>
  )
}
