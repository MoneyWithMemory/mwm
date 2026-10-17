import { useCallback, useMemo, useState, type ComponentType } from 'react'
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

const VIEWS: Record<ViewName, ComponentType> = {
  wallet: WalletView,
  trade: TradeView,
  'seller-desk': SellerDeskView,
  contacts: ContactsView,
}

// Placeholder tab bar; M1.6 replaces it with the Telegram-style BottomNav.
const TABS: { view: ViewName; label: string }[] = [
  { view: 'wallet', label: 'Wallet' },
  { view: 'trade', label: 'Trade' },
  { view: 'seller-desk', label: 'Seller Desk' },
  { view: 'contacts', label: 'Contacts' },
]

const ROOT: NavEntry = { view: 'wallet', params: undefined }

function toEntry<V extends ViewName>([view, params]: NavigateArgs<V>): NavEntry {
  return { view, params } as NavEntry
}

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
      <section className="flex min-h-0 flex-1 flex-col" aria-label={`Wallet ${walletId}`}>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <View />
        </div>
        <nav className="flex gap-1 border-t border-black/10 p-2" aria-label="Views">
          {TABS.map((tab) => (
            <button
              key={tab.view}
              type="button"
              className="pressable flex-1 rounded-lg px-2 py-2 text-xs font-medium aria-[current=page]:bg-black/10"
              aria-current={stack[0].view === tab.view ? 'page' : undefined}
              onClick={() => reset(tab.view)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </section>
    </WalletContext.Provider>
  )
}
