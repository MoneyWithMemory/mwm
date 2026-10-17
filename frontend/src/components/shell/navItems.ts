import { Handshake, ShoppingBag, Users, Wallet, type LucideIcon } from 'lucide-react'
import type { ViewName } from '@/lib/navigation'

export interface NavItem {
  view: ViewName
  label: string
  icon: LucideIcon
  /** Views that keep this item highlighted: a single deal opens on top of the Deals tab. */
  matches: ViewName[]
}

/**
 * 4 navigation sections in order (from left to right / top to bottom):
 * Wallet, Shop, Deals, Contacts. Used by both BottomNav and SideNav.
 * Buying and selling both start in the Shop; every negotiation then lives in Deals.
 */
export const NAV_ITEMS: NavItem[] = [
  { view: 'wallet', label: 'Wallet', icon: Wallet, matches: ['wallet'] },
  { view: 'shop', label: 'Shop', icon: ShoppingBag, matches: ['shop'] },
  { view: 'deals', label: 'Deals', icon: Handshake, matches: ['deals', 'trade'] },
  { view: 'contacts', label: 'Contacts', icon: Users, matches: ['contacts'] },
]
