import { motion } from 'motion/react'
import { usePendingSignatureCount } from '@/api'
import { CountBadge } from '@/components/ui/CountBadge'
import { cn } from '@/lib/cn'
import { SPRING_TABS } from '@/lib/motion'
import { useWalletContext } from '@/lib/navigation'
import { NAV_ITEMS } from './navItems'

/**
 * Desktop single view: the pane's sections as a narrow sidebar instead of the tab bar.
 * Same behavior as BottomNav (reset to the section, sliding active pill).
 */
export function SideNav() {
  const { walletId, current, reset } = useWalletContext()
  const toSign = usePendingSignatureCount(walletId)

  return (
    <nav aria-label="Views" className="surface-glass flex w-52 shrink-0 flex-col gap-1 self-start rounded-card p-2 shadow-card">
      {NAV_ITEMS.map(({ view, label, icon: Icon, matches }) => {
        const active = matches.includes(current.view)
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
            <span className="relative inline-flex shrink-0">
              <Icon size={18} strokeWidth={2} className="relative shrink-0" aria-hidden="true" />
              {view === 'deals' && (
                <CountBadge count={toSign} label={`${toSign} ${toSign === 1 ? 'deal' : 'deals'} to sign`} className="-top-1.5 -right-2" />
              )}
            </span>
            <span className="badge-nowrap relative">{label}</span>
          </button>
        )
      })}
    </nav>
  )
}
