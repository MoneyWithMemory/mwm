import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useMemo, useState, type ComponentType } from 'react'
import { OverlayLayer } from '@/components/ui/OverlayLayer'
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
import { SellerDeskView } from '@/views/seller-desk/SellerDeskView'
import { TradeView } from '@/views/trade/TradeView'
import { WalletView } from '@/views/wallet/WalletView'
import { BottomNav } from './BottomNav'

const VIEWS: Record<ViewName, ComponentType> = {
  wallet: WalletView,
  trade: TradeView,
  'seller-desk': SellerDeskView,
  contacts: ContactsView,
}

const ROOT: NavEntry = { view: 'wallet', params: undefined }

function toEntry<V extends ViewName>([view, params]: NavigateArgs<V>): NavEntry {
  return { view, params } as NavEntry
}

/** One wallet with its own view stack, page transitions, tab bar and overlay host. */
export function WalletPane({ walletId }: { walletId: string }) {
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
  const value = useMemo<WalletContextValue>(
    () => ({ walletId, current, canGoBack: stack.length > 1, navigate, reset, back }),
    [walletId, current, stack.length, navigate, reset, back],
  )
  const View = VIEWS[current.view]

  return (
    <WalletContext.Provider value={value}>
      <OverlayLayer className="flex min-h-0 flex-1 flex-col" role="region" aria-label={`Wallet ${walletId}`}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${stack.length}:${current.view}`}
            variants={pageSlide}
            initial="initial"
            animate="animate"
            exit="exit"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
          >
            <View />
          </motion.div>
        </AnimatePresence>
        <BottomNav />
      </OverlayLayer>
    </WalletContext.Provider>
  )
}
