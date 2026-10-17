import { motion } from 'motion/react'
import { cn } from '@/lib/cn'
import { SPRING_TABS } from '@/lib/motion'
import { useWalletContext } from '@/lib/navigation'
import { NAV_ITEMS } from './navItems'

/**
 * Floating tab bar island, centered in its pane (each split pane has its own).
 * 5 tabs in order: Wallet, Trade, Shop, Seller Desk, Contacts.
 * Sits below overlay host (z-30 < z-40), hides on scroll down, returns on scroll up.
 * Clickable across 100% of the pill surface with zero dead zones via ::before hit targets.
 */
export function BottomNav({ hidden = false }: { hidden?: boolean }) {
  const { walletId, current, reset } = useWalletContext()

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-[var(--island-gap)]">
      <nav
        aria-label="Views"
        data-hidden={hidden}
        className="nav-island surface-glass pointer-events-auto relative grid w-full max-w-[22.5rem] auto-cols-fr grid-flow-col gap-1 rounded-full border border-separator p-1.5 shadow-overlay overflow-visible"
      >
        {NAV_ITEMS.map(({ view, label, icon: Icon }) => {
          const active = current.view === view
          return (
            <button
              key={view}
              type="button"
              aria-current={active ? 'page' : undefined}
              tabIndex={hidden ? -1 : undefined}
              onClick={() => reset(view)}
              className={cn(
                'pressable pressable-flat nav-island-btn relative flex h-12 min-w-11 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-medium',
                active ? 'text-accent' : 'text-hint hover:text-fg',
              )}
            >
              {active && (
                <motion.span
                  layoutId={`nav-pill-${walletId}`}
                  transition={SPRING_TABS}
                  className="pointer-events-none absolute inset-0 rounded-full bg-surface-raised shadow-glow-soft"
                  aria-hidden="true"
                />
              )}
              <Icon size={20} strokeWidth={2} className="pointer-events-none relative shrink-0" aria-hidden="true" />
              <span className="badge-nowrap pointer-events-none relative">{label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}

