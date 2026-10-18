import { Trash2 } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ShopListing } from '@/api'
import { useCloseListing } from '@/api'
import { Avatar, Badge, Button, Card, TrustBadge, toast } from '@/components/ui'
import { formatAssetAmount, formatUsd, shortAddress } from '@/lib/format'
import { useWalletContext } from '@/lib/navigation'
import { unitPriceText } from './unitPrice'

interface ListingCardProps {
  listing: ShopListing
  /** Opens the wallet's own Seller Desk (its sell listing). */
  onEditOffer?: () => void
  /** Answers someone's request: opens the Seller Desk prefilled with it. */
  onSellTo?: (listing: ShopListing) => void
}

/**
 * One listing with a single loud element, the price for the whole lot. Who and what stay quiet
 * (12–13px, hint color); the one action sits bottom right, at the same height in every card.
 */
export function ListingCard({ listing, onEditOffer, onSellTo }: ListingCardProps) {
  const { walletId, navigate } = useWalletContext()
  const close = useCloseListing()
  const selling = listing.kind === 'sell'
  const name = listing.is_mine ? 'You' : (listing.owner_alias ?? shortAddress(listing.owner_address))
  const unit = unitPriceText(listing)

  const remove = () => {
    close.run(walletId, listing.listing_id).catch((err: Error) => toast(err.message, { type: 'danger' }))
  }

  let action: ReactNode = null
  if (selling && !listing.is_mine) {
    action = (
      <Button size="sm" trailingArrow onClick={() => navigate('trade', { counterpartyId: listing.owner_address })}>
        Buy
      </Button>
    )
  } else if (selling && onEditOffer) {
    action = (
      <Button size="sm" variant="secondary" onClick={onEditOffer}>
        Edit offer
      </Button>
    )
  } else if (!selling && !listing.is_mine && onSellTo) {
    action = (
      <Button size="sm" variant="secondary" onClick={() => onSellTo(listing)}>
        Sell to them
      </Button>
    )
  } else if (!selling && listing.is_mine) {
    action = (
      <Button size="sm" variant="secondary" loading={close.pending} onClick={remove}>
        <Trash2 size={14} aria-hidden="true" />
        Remove
      </Button>
    )
  }

  return (
    <Card className="flex h-full flex-col gap-4 p-4">
      <div className="flex items-center gap-3">
        <Avatar seed={listing.owner_address} label={listing.owner_alias ?? undefined} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium text-fg">{name}</span>
          <TrustBadge variant="inline" tier={listing.trust.trust_tier} reliabilityPct={listing.trust.reliability_pct} explain className="self-start" />
        </div>
        <Badge className="shrink-0">{selling ? 'For sale' : 'Wanted'}</Badge>
      </div>

      <div className="flex flex-col gap-1">
        <span className="amount text-lg leading-tight font-semibold text-fg">{formatUsd(listing.price_usd)}</span>
        <span className="amount text-xs text-hint">
          {formatAssetAmount(listing.amount, listing.asset.precision, listing.asset.ticker)}
          {unit && ` · ${unit} each`}
        </span>
      </div>

      {listing.note && <p className="select-text text-[13px] leading-relaxed text-hint">{listing.note}</p>}

      {/* Without the seller's consent the lot is sold whole: the buy form locks the amount. */}
      <div className="mt-auto flex min-h-8 items-center justify-between gap-3">
        {selling && !listing.allow_partial ? (
          <Badge variant="outline" size="sm">
            Full order only
          </Badge>
        ) : (
          <span />
        )}
        {action}
      </div>
    </Card>
  )
}
