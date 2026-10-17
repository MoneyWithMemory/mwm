import { motion } from 'motion/react'
import { cn } from '@/lib/cn'
import { SPRING_TABS } from '@/lib/motion'
import { useWalletContext } from '@/lib/navigation'
import { NAV_ITEMS, RECEIVE_NAV_ACTION } from './navItems'

/**
 * Desktop single view: the pane's sections as a narrow sidebar instead of the tab bar.
 * Same behavior as BottomNav (reset to the section, sliding active pill) plus the prominent Receive action.
 */
export function SideNav() {
  const { walletId, current, reset } = useWalletContext()
  const ReceiveIcon = RECEIVE_NAV_ACTION.icon

  return (
    <nav aria-label="Views" className="surface-glass flex w-52 shrink-0 flex-col gap-1 self-start rounded-card p-2 shadow-card">
      <button
        type="button"
        onClick={() => reset('wallet', { sheet: 'receive' })}
        className="pressable mb-1 flex min-h-[44px] w-full items-center justify-center gap-2.5 rounded-control bg-accent-cool px-3 py-2.5 text-sm font-semibold text-on-accent shadow-glow-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cool focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
      >
        <ReceiveIcon size={18} strokeWidth={2.25} className="shrink-0 text-on-accent" aria-hidden="true" />
        <span className="badge-nowrap text-on-accent">{RECEIVE_NAV_ACTION.label}</span>
      </button>

      {NAV_ITEMS.map(({ view, label, icon: Icon }) => {
        const active = current.view === view
        return (
          <button
            key={view}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => reset(view)}
            className={cn(
              'pressable pressable-flat relative flex items-center gap-3 rounded-control px-3 py-2.5 text-sm font-medium',
              active ? 'text-accent' : 'text-hint hover:text-fg',
            )}
          >
            {active && (
              <motion.span
                layoutId={`side-pill-${walletId}`}
                transition={SPRING_TABS}
                className="absolute inset-0 rounded-control bg-accent/10 shadow-glow-soft"
                aria-hidden="true"
              />
            )}
            <Icon size={18} strokeWidth={2} className="relative shrink-0" aria-hidden="true" />
            <span className="badge-nowrap relative">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
