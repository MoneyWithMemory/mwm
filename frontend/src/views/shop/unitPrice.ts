import type { ShopListing } from '@/api'
import { formatUnitPrice } from '@/lib/format'

/** "$0.00015" per display unit of the listed asset, or null if the lot is empty. */
export function unitPriceText(listing: ShopListing): string | null {
  return formatUnitPrice(listing.price_usd, listing.amount, listing.asset.precision)
}
