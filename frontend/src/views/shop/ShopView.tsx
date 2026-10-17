import { Bot, Plus, Search, Tag } from 'lucide-react'
import { useState } from 'react'
import { useMarket, useShop, useWallet, type ShopListing } from '@/api'
import { Button, Card, CardContent, Chip, EmptyState, ErrorState, Input, Skeleton } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { SellerDeskSheet } from '../seller-desk/SellerDeskSheet'
import type { SellerDraft } from '../seller-desk/SellerForm'
import { AgentSearchSheet } from './AgentSearchSheet'
import { ListingCard } from './ListingCard'
import { NewRequestSheet } from './NewRequestSheet'

type Filter = 'all' | 'sell' | 'want' | 'mine'

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'sell', label: 'For sale' },
  { value: 'want', label: 'Wanted' },
  { value: 'mine', label: 'Yours' },
] as const

/** One column on phones, two from 672px of pane, three from 896px (desktop single view). */
const GRID = 'grid grid-cols-1 gap-4 @2xl:grid-cols-2 @4xl:grid-cols-3'

/** Shaped like a ListingCard (who, price, amount, action), in the same grid: nothing jumps when listings arrive. */
function ListSkeleton() {
  return (
    <div className={GRID} role="status" aria-label="Loading shop">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <Card key={i} className="flex flex-col gap-4 p-4">
          <div className="flex items-center gap-3">
            <Skeleton variant="circular" className="size-7" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton width={96} height={13} />
              <Skeleton width={136} height={12} />
            </div>
            <Skeleton width={56} height={20} className="rounded-full" />
          </div>
          <div className="flex flex-col gap-2">
            <Skeleton width={88} height={22} />
            <Skeleton width={168} height={12} />
          </div>
          <div className="flex items-center justify-end">
            <Skeleton width={72} height={32} />
          </div>
        </Card>
      ))}
    </div>
  )
}

function matchesFilter(listing: ShopListing, filter: Filter): boolean {
  if (filter === 'mine') return listing.is_mine
  if (filter === 'all') return true
  return listing.kind === filter
}

/**
 * One feed of offers and requests, the wallet's own included. Buying starts from a card or from
 * the agent; selling and asking start from the two header actions. Negotiations continue in Deals.
 */
export function ShopView() {
  const { walletId } = useWalletContext()
  const shop = useShop(walletId)
  const market = useMarket()
  const wallet = useWallet(walletId)
  const [filter, setFilter] = useState<Filter>('all')
  const [text, setText] = useState('')
  const [requestOpen, setRequestOpen] = useState(false)
  const [agentOpen, setAgentOpen] = useState(false)
  const [desk, setDesk] = useState<{ open: boolean; draft?: SellerDraft }>({ open: false })

  const query = text.trim().toLowerCase()
  const listings = (shop.data ?? [])
    .filter((l) => matchesFilter(l, filter))
    .filter((l) => !query || [l.owner_alias, l.owner_address, l.asset.ticker, l.note].some((field) => field?.toLowerCase().includes(query)))
    // Other people's listings first; the wallet's own follow, marked "Yours".
    .sort((a, b) => Number(a.is_mine) - Number(b.is_mine))

  const openDesk = (draft?: SellerDraft) => setDesk({ open: true, draft })
  const sellTo = (want: ShopListing) =>
    openDesk({ offered_asset_id: want.asset.asset_id, offered_amount: want.amount, asking_price_usd: want.price_usd })

  let feed
  if (shop.data && listings.length > 0) {
    feed = (
      <ul className={GRID}>
        {listings.map((listing) => (
          <li key={listing.listing_id} className="min-w-0">
            <ListingCard listing={listing} onEditOffer={() => openDesk()} onSellTo={sellTo} />
          </li>
        ))}
      </ul>
    )
  } else if (shop.data) {
    feed =
      filter === 'mine' && !query ? (
        <EmptyState
          className="rounded-card bg-surface shadow-card"
          title="Nothing of yours yet"
          description="Put something on sale, or post what you are looking for."
          action={
            <div className="flex gap-2">
              <Button variant="secondary" disabled={!market.data} onClick={() => setRequestOpen(true)}>
                Post a request
              </Button>
              <Button onClick={() => openDesk()}>Sell</Button>
            </div>
          }
        />
      ) : (
        <EmptyState
          className="rounded-card bg-surface shadow-card"
          title={shop.data.length > 0 ? 'No matches' : 'Nothing here yet'}
          description={shop.data.length > 0 ? 'Try another filter or a different search.' : 'Offers and requests will show up here.'}
        />
      )
  } else if (shop.error) {
    feed = <ErrorState title="Couldn't load the Shop" message="Check your connection and try again." onRetry={shop.refresh} />
  } else {
    feed = <ListSkeleton />
  }

  return (
    <div className="@container">
      <div className="flex flex-col justify-start gap-4 p-4 @4xl:p-6">
        <header className="flex items-center gap-2">
          <h1 className="flex-1 text-lg font-semibold">Shop</h1>
          <Button variant="secondary" size="sm" disabled={!market.data} onClick={() => setRequestOpen(true)}>
            <Plus size={14} aria-hidden="true" />
            Request
          </Button>
          <Button variant="secondary" size="sm" onClick={() => openDesk()}>
            <Tag size={14} aria-hidden="true" />
            Sell
          </Button>
        </header>

        <Card>
          <CardContent className="flex items-center gap-3 pt-4">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-hint" aria-hidden="true">
              <Bot size={20} />
            </span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-sm font-medium">Let your agent find the best deal</span>
              <span className="text-xs text-hint">It picks the best seller and negotiates within your limits.</span>
            </div>
            <Button size="sm" trailingArrow onClick={() => setAgentOpen(true)} disabled={!market.data || !wallet.data}>
              Find
            </Button>
          </CardContent>
        </Card>

        <div className="flex flex-col gap-3">
          <div className="flex gap-2 overflow-x-auto" role="group" aria-label="Filter listings">
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
            reserveMessage={false}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        {feed}
      </div>

      {market.data && <NewRequestSheet open={requestOpen} onClose={() => setRequestOpen(false)} market={market.data} />}
      {market.data && wallet.data && (
        <AgentSearchSheet
          open={agentOpen}
          onClose={() => setAgentOpen(false)}
          market={market.data}
          wallet={wallet.data}
          listings={shop.data ?? []}
        />
      )}
      <SellerDeskSheet open={desk.open} draft={desk.draft} onClose={() => setDesk((d) => ({ ...d, open: false }))} />
    </div>
  )
}
