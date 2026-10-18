import { useContacts, useMarket, useWallet } from '@/api'
import { EmptyState, ErrorState, Skeleton } from '@/components/ui'
import { useViewParams, useWalletContext } from '@/lib/navigation'
import { SessionPanel } from './SessionPanel'
import { SetupForm } from './SetupForm'

function SetupSkeleton() {
  return (
    <div className="flex flex-col gap-4 p-4" role="status" aria-label="Loading trade">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-16 rounded-card" />
      <Skeleton className="h-80 rounded-card" />
      <Skeleton className="h-10" />
    </div>
  )
}

function Setup({ walletId, counterpartyId, onCreated }: { walletId: string; counterpartyId?: string; onCreated: (id: string) => void }) {
  const wallet = useWallet(walletId)
  const contacts = useContacts(walletId)
  const market = useMarket()

  const failed = wallet.error ?? contacts.error ?? market.error
  if (!wallet.data || !contacts.data || !market.data) {
    return failed ? (
      <div className="p-4">
        <ErrorState
          title="Couldn't load the trade form"
          message="Check your connection and try again."
          onRetry={() => {
            wallet.refresh()
            contacts.refresh()
            market.refresh()
          }}
        />
      </div>
    ) : (
      <SetupSkeleton />
    )
  }
  if (contacts.data.length === 0) {
    return (
      <div className="p-4">
        <EmptyState title="No contacts to trade with" description="Counterparties appear in Contacts after your first trade." />
      </div>
    )
  }
  return (
    <SetupForm
      wallet={wallet.data}
      contacts={contacts.data}
      market={market.data}
      initialAddress={counterpartyId}
      onCreated={onCreated}
    />
  )
}

export function TradeView() {
  const { walletId, replace } = useWalletContext()
  const params = useViewParams('trade')
  const sessionId = params?.sessionId

  if (sessionId) return <SessionPanel key={sessionId} sessionId={sessionId} walletId={walletId} />
  // The new session replaces the form in the stack, so it survives wallet switches and Back.
  return (
    <Setup
      key={walletId}
      walletId={walletId}
      counterpartyId={params?.counterpartyId}
      onCreated={(id) => replace('trade', { sessionId: id })}
    />
  )
}
