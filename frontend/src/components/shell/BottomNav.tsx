import { motion } from 'motion/react'
import { cn } from '@/lib/cn'
import { SPRING_TABS } from '@/lib/motion'
import { useWalletContext } from '@/lib/navigation'
import { NAV_ITEMS } from './navItems'

/**
 * Floating tab bar island, centered in its pane (each split pane has its own). It sits
 * below the pane's overlay host (z-30 < z-40), so sheets and modals cover it. The pane
 * keeps room for it with .pane-scroll-island; `hidden` drops it while scrolling down.
 */
export function BottomNav({ hidden = false }: { hidden?: boolean }) {
  const { walletId, current, reset } = useWalletContext()

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-[var(--island-gap)]">
      <nav
        aria-label="Views"
        data-hidden={hidden}
        className="nav-island surface-glass pointer-events-auto grid w-full max-w-[20.5rem] grid-cols-4 gap-1 rounded-full border border-separator p-1.5 shadow-overlay"
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
                'pressable pressable-flat relative flex h-12 min-w-11 flex-col items-center justify-center gap-0.5 rounded-full text-[11px] font-medium',
                active ? 'text-accent' : 'text-hint',
              )}
            >
              {active && (
                <motion.span
                  layoutId={`nav-pill-${walletId}`}
                  transition={SPRING_TABS}
                  className="absolute inset-0 rounded-full bg-surface-raised shadow-glow-soft"
                  aria-hidden="true"
                />
              )}
              <Icon size={20} strokeWidth={2} className="relative" aria-hidden="true" />
              <span className="badge-nowrap relative">{label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}
