import { motion } from 'motion/react'
import { cn } from '@/lib/cn'
import { SPRING_TABS } from '@/lib/motion'
import { useWalletContext } from '@/lib/navigation'
import { BOTTOM_NAV_ITEMS } from './navItems'

/**
 * Floating tab bar island, centered in its pane (each split pane has its own).
 * 5 slots in order: Receive (action), Trade, Wallet (center, 56px blue raised),
 * Seller Desk, Contacts.
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
        className="nav-island surface-glass pointer-events-auto relative grid w-full max-w-[22rem] grid-cols-5 gap-1 rounded-full border border-separator p-1.5 shadow-overlay overflow-visible"
      >
        {BOTTOM_NAV_ITEMS.map((item) => {
          if (item.kind === 'action') {
            return (
              <button
                key={item.id}
                type="button"
                tabIndex={hidden ? -1 : undefined}
                onClick={() => reset('wallet', { sheet: 'receive' })}
                className="pressable pressable-flat nav-island-btn relative flex h-12 min-w-11 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-medium text-hint hover:text-fg"
              >
                <item.icon size={20} strokeWidth={2} className="pointer-events-none relative shrink-0" aria-hidden="true" />
                <span className="badge-nowrap pointer-events-none relative">{item.label}</span>
              </button>
            )
          }

          if (item.view === 'wallet') {
            const active = current.view === 'wallet'
            return (
              <button
                key={item.view}
                type="button"
                aria-current={active ? 'page' : undefined}
                aria-label="Wallet"
                tabIndex={hidden ? -1 : undefined}
                onClick={() => reset('wallet')}
                className="pressable pressable-flat nav-island-btn nav-island-btn-center relative flex h-12 min-w-11 items-center justify-center"
              >
                <div
                  className={cn(
                    'pointer-events-none relative -top-2 flex h-14 w-14 shrink-0 flex-col items-center justify-center gap-0.5 rounded-full bg-accent-cool text-on-accent transition-shadow duration-quick',
                    active ? 'shadow-glow-soft' : 'shadow-md',
                  )}
                >
                  <item.icon size={20} strokeWidth={2.2} className="relative shrink-0" aria-hidden="true" />
                  <span className="badge-nowrap relative text-[10px] font-semibold leading-none tracking-tight">
                    {item.label}
                  </span>
                </div>
              </button>
            )
          }

          const active = current.view === item.view
          return (
            <button
              key={item.view}
              type="button"
              aria-current={active ? 'page' : undefined}
              tabIndex={hidden ? -1 : undefined}
              onClick={() => reset(item.view)}
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
              <item.icon size={20} strokeWidth={2} className="pointer-events-none relative shrink-0" aria-hidden="true" />
              <span className="badge-nowrap pointer-events-none relative">{item.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
