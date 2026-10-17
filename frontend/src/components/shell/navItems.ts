import { ArrowLeftRight, ShoppingBag, Store, Users, Wallet, type LucideIcon } from 'lucide-react'
import type { ViewName } from '@/lib/navigation'

export interface NavItem {
  view: ViewName
  label: string
  icon: LucideIcon
}

/**
 * 5 navigation sections in order (from left to right / top to bottom):
 * Wallet, Trade, Shop, Seller Desk, Contacts.
 * Used by both BottomNav and SideNav.
 */
export const NAV_ITEMS: NavItem[] = [
  { view: 'wallet', label: 'Wallet', icon: Wallet },
  { view: 'trade', label: 'Trade', icon: ArrowLeftRight },
  { view: 'shop', label: 'Shop', icon: ShoppingBag },
  { view: 'seller-desk', label: 'Seller Desk', icon: Store },
  { view: 'contacts', label: 'Contacts', icon: Users },
]

