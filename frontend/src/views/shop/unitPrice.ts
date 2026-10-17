import type { ShopListing } from '@/api'

const unitFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6, minimumFractionDigits: 2 })

/** "$0.00015" per display unit of the listed asset, or null if the lot is empty. */
export function unitPriceText(listing: ShopListing): string | null {
  const units = listing.amount / 10 ** listing.asset.precision
  return units > 0 ? unitFormat.format(listing.price_usd / units) : null
}
