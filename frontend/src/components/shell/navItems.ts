import { ArrowLeftRight, Store, Users, Wallet, type LucideIcon } from 'lucide-react'
import type { ViewName } from '@/lib/navigation'

/** The four pane sections, shared by the bottom tab bar and the desktop side nav. */
export const NAV_ITEMS: { view: ViewName; label: string; icon: LucideIcon }[] = [
  { view: 'wallet', label: 'Wallet', icon: Wallet },
  { view: 'trade', label: 'Trade', icon: ArrowLeftRight },
  { view: 'seller-desk', label: 'Seller Desk', icon: Store },
  { view: 'contacts', label: 'Contacts', icon: Users },
]
