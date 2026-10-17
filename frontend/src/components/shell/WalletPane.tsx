import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useMemo, useRef, useState, type ComponentType, type UIEvent } from 'react'
import { OverlayLayer } from '@/components/ui/OverlayLayer'
import { cn } from '@/lib/cn'
import { pageSlide } from '@/lib/motion'
import {
  WalletContext,
  type NavEntry,
  type NavigateArgs,
  type ViewName,
  type WalletContextValue,
} from '@/lib/navigation'
// Direct imports (not '@/views'): the views barrel also exports SplitView,
// which mounts WalletPane, and going through it would create an import cycle.
import { ContactsView } from '@/views/contacts/ContactsView'
import { DealsView } from '@/views/deals/DealsView'
import { ShopView } from '@/views/shop/ShopView'
import { TradeView } from '@/views/trade/TradeView'
import { WalletView } from '@/views/wallet/WalletView'
import { BottomNav } from './BottomNav'
import { SideNav } from './SideNav'

const VIEWS: Record<ViewName, ComponentType> = {
  wallet: WalletView,
  trade: TradeView,
  shop: ShopView,
  deals: DealsView,
  contacts: ContactsView,
}

const ROOT: NavEntry = { view: 'wallet', params: undefined }

/** Scroll distance (px) that counts as a direction change for the island. */
const SCROLL_STEP = 8
/** Near the top the island always shows. */
const SCROLL_TOP_ZONE = 24

function toEntry<V extends ViewName>([view, params]: NavigateArgs<V>): NavEntry {
  return { view, params } as NavEntry
}

/** Where the pane's sections live: the bottom tab bar, or a sidebar on wide single view. */
export type PaneNav = 'bottom' | 'side'

export interface WalletPaneProps {
  walletId: string
  nav?: PaneNav
  autoHideIsland?: boolean
}

/** One wallet with its own view stack, page transitions, section nav and overlay host. */
export function WalletPane({ walletId, nav = 'bottom', autoHideIsland = true }: WalletPaneProps) {
  const [stack, setStack] = useState<NavEntry[]>([ROOT])

  const navigate = useCallback(<V extends ViewName>(...args: NavigateArgs<V>) => {
    setStack((s) => [...s, toEntry(args)])
  }, [])
  const reset = useCallback(<V extends ViewName>(...args: NavigateArgs<V>) => {
    setStack([toEntry(args)])
  }, [])
  const back = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s))
  }, [])

  const current = stack[stack.length - 1]
  const viewKey = `${stack.length}:${current.view}`

  // The island hides while scrolling down and returns on scroll up or at the end of the
  // content. Tied to the view key, so a new view always starts with the island visible.
  const [islandHiddenFor, setIslandHiddenFor] = useState<string | null>(null)
  const lastScrollTop = useRef(0)
  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    const { scrollTop: top, clientHeight, scrollHeight } = event.currentTarget
    const delta = top - lastScrollTop.current
    if (Math.abs(delta) < SCROLL_STEP) return
    lastScrollTop.current = top
    const atEnd = top + clientHeight >= scrollHeight - SCROLL_STEP
    setIslandHiddenFor(delta > 0 && top > SCROLL_TOP_ZONE && !atEnd ? viewKey : null)
  }
  const value = useMemo<WalletContextValue>(
    () => ({ walletId, current, canGoBack: stack.length > 1, navigate, reset, back }),
    [walletId, current, stack.length, navigate, reset, back],
  )
  const View = VIEWS[current.view]

  return (
    <WalletContext.Provider value={value}>
      <div className={cn('flex min-h-0 min-w-0 flex-1', nav === 'side' ? 'flex-row gap-4' : 'flex-col')}>
        {nav === 'side' && <SideNav />}
        {/* Sheets and modals cover the content area only, never the sidebar. */}
        <OverlayLayer className="flex min-h-0 min-w-0 flex-1 flex-col" role="region" aria-label={`Wallet ${walletId}`}>
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={viewKey}
              variants={pageSlide}
              initial="initial"
              animate="animate"
              exit="exit"
              onScroll={nav === 'bottom' && autoHideIsland ? onScroll : undefined}
              className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', nav === 'bottom' && 'pane-scroll-island')}
            >
              <View />
            </motion.div>
          </AnimatePresence>
          {nav === 'bottom' && <BottomNav hidden={autoHideIsland && islandHiddenFor === viewKey} />}
        </OverlayLayer>
      </div>
    </WalletContext.Provider>
  )
}
