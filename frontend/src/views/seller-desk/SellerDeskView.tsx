import { useMarket, useWallet } from '@/api'
import { ErrorState, Skeleton } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { IncomingSessions } from './IncomingSessions'
import { SellerForm } from './SellerForm'

function SellerDeskSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading seller desk">
      <Skeleton className="h-16 rounded-card" />
      <Skeleton className="h-80 rounded-card" />
      <Skeleton className="h-52 rounded-card" />
      <Skeleton className="h-10" />
    </div>
  )
}

export function SellerDeskView() {
  const { walletId } = useWalletContext()
  const wallet = useWallet(walletId)
  const market = useMarket()
  const state = wallet.data
  const marketData = market.data

  return (
    <div className="flex flex-col justify-start gap-5 p-4">
      <header className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold">Seller Desk</h1>
        <p className="text-sm text-hint">Let your local agent sell for you.</p>
      </header>

      {state && marketData ? (
        <>
          <SellerForm key={walletId} walletId={walletId} profile={state.agent_profile} assets={state.assets} market={marketData} />
          <IncomingSessions aliases={state.local_aliases} />
        </>
      ) : wallet.error || market.error ? (
        <ErrorState
          title="Couldn't load your seller profile"
          message="Check your connection and try again."
          onRetry={() => {
            wallet.refresh()
            market.refresh()
          }}
        />
      ) : (
        <SellerDeskSkeleton />
      )}
    </div>
  )
}
