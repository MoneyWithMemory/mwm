import { Bot, Plus, Search } from 'lucide-react'
import { useState } from 'react'
import { useMarket, useShop, useWallet, type ListingKind, type ShopListing } from '@/api'
import { Button, Card, CardContent, Chip, EmptyState, ErrorState, Input, SegmentedControl, Skeleton } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { SellerPanel } from '../seller-desk/SellerPanel'
import { AgentSearchSheet } from './AgentSearchSheet'
import { ListingCard } from './ListingCard'
import { NewRequestSheet } from './NewRequestSheet'

type Tab = 'browse' | 'sell' | 'requests'
type Filter = 'all' | ListingKind

const TABS = [
  { value: 'browse', label: 'Browse' },
  { value: 'sell', label: 'Sell' },
  { value: 'requests', label: 'Requests' },
] as const

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'sell', label: 'For sale' },
  { value: 'want', label: 'Wanted' },
] as const

const TAB_HINT: Record<Tab, string> = {
  browse: 'Offers and requests from other people. Buy, or let your agent search.',
  sell: 'Put your own asset on sale. Buyers and their agents see the asking price; your minimum stays private.',
  requests: 'Things you are looking for. Sellers and agents can see them.',
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="Loading shop">
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-52 rounded-card" />
      ))}
    </div>
  )
}

function Listings({ listings, onSell }: { listings: ShopListing[]; onSell: () => void }) {
  return (
    <ul className="flex flex-col gap-3 @4xl:grid @4xl:grid-cols-2">
      {listings.map((listing) => (
        <li key={listing.listing_id} className="min-w-0">
          <ListingCard listing={listing} onSell={onSell} />
        </li>
      ))}
    </ul>
  )
}

/**
 * The one place to buy, sell or ask for something. Browse is other people's offers and requests,
 * Sell is your own offer (the Seller Desk), Requests is what you are looking for. Every negotiation
 * that starts here continues in Deals.
 */
export function ShopView() {
  const { walletId } = useWalletContext()
  const shop = useShop(walletId)
  const market = useMarket()
  const wallet = useWallet(walletId)
  const [tab, setTab] = useState<Tab>('browse')
  const [filter, setFilter] = useState<Filter>('all')
  const [text, setText] = useState('')
  const [requestOpen, setRequestOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)

  const query = text.trim().toLowerCase()
  const others = (shop.data ?? []).filter((l) => !l.is_mine).filter((l) => {
    if (filter !== 'all' && l.kind !== filter) return false
    if (!query) return true
    return [l.owner_alias, l.owner_address, l.asset.ticker, l.note].some((field) => field?.toLowerCase().includes(query))
  })
  const mine = (shop.data ?? []).filter((l) => l.is_mine && l.kind === 'want')
  const goSell = () => setTab('sell')

  let browse
  if (shop.data) {
    browse =
      others.length > 0 ? (
        <Listings listings={others} onSell={goSell} />
      ) : (
        <EmptyState
          className="rounded-card bg-surface shadow-card"
          title={shop.data.some((l) => !l.is_mine) ? 'No matches' : 'Nothing here yet'}
          description={
            shop.data.some((l) => !l.is_mine) ? 'Try another filter or a different search.' : 'Offers and requests from other people will show up here.'
          }
        />
      )
  } else if (shop.error) {
    browse = <ErrorState title="Couldn't load the Shop" message="Check your connection and try again." onRetry={shop.refresh} />
  } else {
    browse = <ListSkeleton />
  }

  let requests
  if (shop.data) {
    requests =
      mine.length > 0 ? (
        <Listings listings={mine} onSell={goSell} />
      ) : (
        <EmptyState
          className="rounded-card bg-surface shadow-card"
          title="No requests yet"
          description="Post what you want and at what price. Your maximum budget stays with your agent."
          action={
            <Button disabled={!market.data} onClick={() => setRequestOpen(true)}>
              Post a request
            </Button>
          }
        />
      )
  } else if (shop.error) {
    requests = <ErrorState title="Couldn't load your requests" message="Check your connection and try again." onRetry={shop.refresh} />
  } else {
    requests = <ListSkeleton />
  }

  return (
    <div className="@container">
      <div className="flex flex-col justify-start gap-4 p-4 @4xl:p-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">Shop</h1>
          <p className="text-sm text-hint">Buy, sell or ask for what you need. Your agent can do it for you.</p>
        </header>

        <SegmentedControl
          fullWidth
          layoutId={`shop-tab-${walletId}`}
          options={TABS.map((t) => ({ value: t.value, label: t.label }))}
          value={tab}
          onChange={setTab}
        />
        <p className="-mt-1 text-xs text-hint">{TAB_HINT[tab]}</p>

        {tab === 'browse' && (
          <>
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
            <div className="flex flex-col gap-3">
              <div className="flex gap-2" role="group" aria-label="Filter listings">
                {FILTERS.map((f) => (
                  <Chip key={f.value} active={filter === f.value} onClick={() => setFilter(f.value)}>
                    {f.label}
                  </Chip>
                ))}
              </div>
              <Input
                aria-label="Search the Shop"
                placeholder="Search by name, address or asset"
                value={text}
                prefix={<Search size={16} aria-hidden="true" />}
                onChange={(e) => setText(e.target.value)}
              />
            </div>
            {browse}
          </>
        )}

        {tab === 'sell' && <SellerPanel />}

        {tab === 'requests' && (
          <>
            {mine.length > 0 && (
              <Button variant="secondary" size="sm" className="self-start" disabled={!market.data} onClick={() => setRequestOpen(true)}>
                <Plus size={16} aria-hidden="true" />
                Post a request
              </Button>
            )}
            {requests}
          </>
        )}
      </div>

      {market.data && <NewRequestSheet open={requestOpen} onClose={() => setRequestOpen(false)} market={market.data} />}
      {market.data && wallet.data && (
        <AgentSearchSheet open={agentOpen} onClose={() => setAgentOpen(false)} market={market.data} wallet={wallet.data} />
      )}
    </div>
  )
}
