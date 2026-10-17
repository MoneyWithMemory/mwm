import { Bot, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { useMarket, useShop, useWallet, type ListingKind } from '@/api'
import { Button, Card, CardContent, EmptyState, ErrorState, Input, SegmentedControl, Skeleton } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { AgentSearchSheet } from './AgentSearchSheet'
import { ListingCard } from './ListingCard'
import { NewRequestSheet } from './NewRequestSheet'

type Filter = 'all' | ListingKind

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'sell', label: 'For sale' },
  { value: 'want', label: 'Wanted' },
] as const

function ShopSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Loading shop">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-52 rounded-card" />
      ))}
    </div>
  )
}

export function ShopView() {
  const { walletId } = useWalletContext()
  const shop = useShop(walletId)
  const market = useMarket()
  const wallet = useWallet(walletId)
  const [filter, setFilter] = useState<Filter>('all')
  const [text, setText] = useState('')
  const [requestOpen, setRequestOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)

  const query = text.trim().toLowerCase()
  const listings = (shop.data ?? []).filter((l) => {
    if (filter !== 'all' && l.kind !== filter) return false
    if (!query) return true
    return [l.owner_alias, l.owner_address, l.asset.ticker, l.note].some((field) => field?.toLowerCase().includes(query))
  })

  let body
  if (shop.data) {
    body =
      listings.length > 0 ? (
        <ul className="flex flex-col gap-3 @4xl:grid @4xl:grid-cols-2">
          {listings.map((listing) => (
            <li key={listing.listing_id} className="min-w-0">
              <ListingCard listing={listing} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          className="rounded-card bg-surface shadow-card"
          title={shop.data.length === 0 ? 'The Shop is empty' : 'No matches'}
          description={
            shop.data.length === 0
              ? 'Post a request or turn on your Seller Desk to be the first.'
              : 'Try another filter or a different search.'
          }
        />
      )
  } else if (shop.error) {
    body = (
      <ErrorState title="Couldn't load the Shop" message="Check your connection and try again." onRetry={shop.refresh} />
    )
  } else {
    body = <ShopSkeleton />
  }

  return (
    <div className="@container">
      <div className="flex flex-col justify-start gap-4 p-4 @4xl:p-6">
        <header className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-lg font-semibold">Shop</h1>
            <p className="text-sm text-hint">Everything for sale and wanted. Your agent can search it too.</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setRequestOpen(true)} disabled={!market.data}>
            <Plus size={16} aria-hidden="true" />
            Request
          </Button>
        </header>

        <Card>
          <CardContent className="flex items-center gap-3 pt-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-accent/15 text-accent" aria-hidden="true">
              <Bot size={20} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-sm font-semibold">Let your agent shop</span>
              <span className="text-xs text-hint">It finds a seller and negotiates within your limits.</span>
            </div>
            <Button size="sm" onClick={() => setAgentOpen(true)} disabled={!market.data || !wallet.data}>
              Find
            </Button>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-1">
          <SegmentedControl
            fullWidth
            layoutId={`shop-filter-${walletId}`}
            options={FILTERS.map((f) => ({ value: f.value, label: f.label }))}
            value={filter}
            onChange={setFilter}
          />
          <Input
            aria-label="Search the Shop"
            placeholder="Search by name, address or asset"
            value={text}
            prefix={<Search size={16} aria-hidden="true" />}
            containerClassName="mt-3"
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        {body}
      </div>

      {market.data && <NewRequestSheet open={requestOpen} onClose={() => setRequestOpen(false)} market={market.data} />}
      {market.data && wallet.data && (
        <AgentSearchSheet open={agentOpen} onClose={() => setAgentOpen(false)} market={market.data} wallet={wallet.data} />
      )}
    </div>
  )
}
