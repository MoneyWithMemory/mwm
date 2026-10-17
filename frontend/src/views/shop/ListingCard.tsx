import { Trash2 } from 'lucide-react'
import type { ShopListing } from '@/api'
import { useCloseListing } from '@/api'
import { AssetBadge, Avatar, Badge, Button, Card, CardContent, TrustBadge, toast } from '@/components/ui'
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

export function ListingCard({ listing, onEditOffer, onSellTo }: ListingCardProps) {
  const { walletId, navigate } = useWalletContext()
  const close = useCloseListing()
  const selling = listing.kind === 'sell'
  const name = listing.is_mine ? 'You' : (listing.owner_alias ?? shortAddress(listing.owner_address))
  const unit = unitPriceText(listing)

  const remove = () => {
    close.run(walletId, listing.listing_id).catch((err: Error) => toast(err.message, { type: 'danger' }))
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 pt-4">
        <div className="flex items-center gap-3">
          <Avatar seed={listing.owner_address} label={listing.owner_alias ?? undefined} />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="truncate text-sm font-semibold">{name}</span>
            <TrustBadge tier={listing.trust.trust_tier} reliabilityPct={listing.trust.reliability_pct} size="sm" className="self-start" />
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1">
            <Badge variant={selling ? 'accent' : 'warning'}>{selling ? 'For sale' : 'Wanted'}</Badge>
            {listing.is_mine && <Badge variant="outline" size="sm">Yours</Badge>}
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 rounded-control bg-surface-muted/60 p-3">
          <AssetBadge ticker={listing.asset.ticker} asset_id={listing.asset.asset_id} showTicker />
          <div className="flex flex-col items-end">
            <span className="amount text-sm font-semibold">
              {formatAssetAmount(listing.amount, listing.asset.precision, listing.asset.ticker)}
            </span>
            <span className="amount text-xs text-hint">
              {selling ? 'List price' : 'Offering'} {formatUsd(listing.price_usd)}
              {unit && ` · ${unit} each`}
            </span>
          </div>
        </div>

        {listing.note && <p className="select-text text-sm leading-relaxed text-fg/90">{listing.note}</p>}

        {selling && !listing.is_mine && (
          <Button fullWidth trailingArrow onClick={() => navigate('trade', { counterpartyId: listing.owner_address })}>
            Buy
          </Button>
        )}
        {selling && listing.is_mine && onEditOffer && (
          <Button fullWidth variant="secondary" onClick={onEditOffer}>
            Edit offer
          </Button>
        )}
        {!selling && !listing.is_mine && onSellTo && (
          <Button fullWidth variant="secondary" onClick={() => onSellTo(listing)}>
            Sell to them · {formatUsd(listing.price_usd)}
          </Button>
        )}
        {!selling && listing.is_mine && (
          <Button fullWidth variant="ghost" loading={close.pending} onClick={remove}>
            <Trash2 size={14} aria-hidden="true" />
            Remove request
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
