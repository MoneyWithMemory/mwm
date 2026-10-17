import { ArrowLeftRight, QrCode, Store, Users, Wallet, type LucideIcon } from 'lucide-react'
import type { ViewName } from '@/lib/navigation'

export type BottomNavItem =
  | { kind: 'action'; id: 'receive'; label: string; icon: LucideIcon }
  | { kind: 'tab'; view: ViewName; label: string; icon: LucideIcon }

export const RECEIVE_NAV_ACTION: BottomNavItem & { kind: 'action' } = {
  kind: 'action',
  id: 'receive',
  label: 'Receive',
  icon: QrCode,
}

/**
 * 5 bottom navigation items in order:
 * Receive (action), Trade, Wallet (center, highlighted), Seller Desk, Contacts.
 */
export const BOTTOM_NAV_ITEMS: BottomNavItem[] = [
  RECEIVE_NAV_ACTION,
  { kind: 'tab', view: 'trade', label: 'Trade', icon: ArrowLeftRight },
  { kind: 'tab', view: 'wallet', label: 'Wallet', icon: Wallet },
  { kind: 'tab', view: 'seller-desk', label: 'Seller Desk', icon: Store },
  { kind: 'tab', view: 'contacts', label: 'Contacts', icon: Users },
]

/** The 4 navigation tabs, used by the desktop side nav. */
export const NAV_ITEMS: { view: ViewName; label: string; icon: LucideIcon }[] = [
  { view: 'wallet', label: 'Wallet', icon: Wallet },
  { view: 'trade', label: 'Trade', icon: ArrowLeftRight },
  { view: 'seller-desk', label: 'Seller Desk', icon: Store },
  { view: 'contacts', label: 'Contacts', icon: Users },
]
