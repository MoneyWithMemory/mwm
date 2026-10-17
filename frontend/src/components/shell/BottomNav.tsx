import { ArrowLeftRight, Store, Users, Wallet, type LucideIcon } from 'lucide-react'
import { motion } from 'motion/react'
import { cn } from '@/lib/cn'
import { SPRING_TABS } from '@/lib/motion'
import { useWalletContext, type ViewName } from '@/lib/navigation'

const TABS: { view: ViewName; label: string; icon: LucideIcon }[] = [
  { view: 'wallet', label: 'Wallet', icon: Wallet },
  { view: 'trade', label: 'Trade', icon: ArrowLeftRight },
  { view: 'seller-desk', label: 'Seller Desk', icon: Store },
  { view: 'contacts', label: 'Contacts', icon: Users },
]

/** Pane tab bar; the active pill slides between tabs (layoutId scoped to the pane's wallet). */
export function BottomNav() {
  const { walletId, current, reset } = useWalletContext()

  return (
    <nav aria-label="Views" className="border-t border-separator bg-surface px-2 pt-1.5 pb-[max(env(safe-area-inset-bottom),0.375rem)]">
      <div className="flex gap-1">
        {TABS.map(({ view, label, icon: Icon }) => {
          const active = current.view === view
          return (
            <button
              key={view}
              type="button"
              aria-current={active ? 'page' : undefined}
              onClick={() => reset(view)}
              className={cn(
                'pressable pressable-flat relative flex flex-1 flex-col items-center gap-0.5 rounded-control py-1.5 text-[11px] font-medium',
                active ? 'text-accent' : 'text-hint',
              )}
            >
              {active && (
                <motion.span
                  layoutId={`nav-pill-${walletId}`}
                  transition={SPRING_TABS}
                  className="absolute inset-0 rounded-control bg-accent/10"
                  aria-hidden="true"
                />
              )}
              <Icon size={20} strokeWidth={2} className="relative" aria-hidden="true" />
              <span className="badge-nowrap relative">{label}</span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
