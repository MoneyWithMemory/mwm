import { useMarket, useWallet } from '@/api'
import { Button, Card, CardContent, ErrorState, Skeleton } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { SellerForm } from './SellerForm'

function SellerSkeleton() {
  return (
    <div className="flex flex-col gap-4" role="status" aria-label="Loading your offer">
      <Skeleton className="h-16 rounded-card" />
      <Skeleton className="h-80 rounded-card" />
      <Skeleton className="h-52 rounded-card" />
      <Skeleton className="h-10" />
    </div>
  )
}

/** The "Sell" tab of the Shop: the wallet's public offer and the private limits of its selling agent. */
export function SellerPanel() {
  const { walletId, reset } = useWalletContext()
  const wallet = useWallet(walletId)
  const market = useMarket()
  const state = wallet.data
  const marketData = market.data

  if (state && marketData) {
    return (
      <div className="flex flex-col gap-4">
        <SellerForm key={walletId} walletId={walletId} profile={state.agent_profile} assets={state.assets} market={marketData} />
        <Card>
          <CardContent className="flex items-center gap-3 pt-4">
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-semibold">Buyers answering your offer</span>
              <span className="text-xs text-hint">Their negotiations appear in Deals.</span>
            </div>
            <Button size="sm" variant="secondary" onClick={() => reset('deals')}>
              Open Deals
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }
  if (wallet.error || market.error) {
    return (
      <ErrorState
        title="Couldn't load your offer"
        message="Check your connection and try again."
        onRetry={() => {
          wallet.refresh()
          market.refresh()
        }}
      />
    )
  }
  return <SellerSkeleton />
}
