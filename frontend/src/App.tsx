import { useState } from 'react'
import { WalletPane } from '@/components/shell/WalletPane'
import { DEMO_WALLETS, type DemoWalletId } from '@/lib/demo-wallets'
import { SplitView } from '@/views'

type Layout = 'single' | 'split'

// Raw shell (M1.1): wallet switcher + split toggle. M1.6 replaces it with the
// Telegram-style AppShell; views are already registered in WalletPane.
export default function App() {
  const [layout, setLayout] = useState<Layout>('single')
  const [walletId, setWalletId] = useState<DemoWalletId>(DEMO_WALLETS[0].id)

  return (
    <div className="ui-shell flex h-dvh flex-col">
      <header className="flex items-center gap-2 border-b border-black/10 p-2">
        {layout === 'single' &&
          DEMO_WALLETS.map((wallet) => (
            <button
              key={wallet.id}
              type="button"
              className="pressable rounded-lg px-3 py-1.5 text-sm aria-pressed:bg-black/10"
              aria-pressed={walletId === wallet.id}
              onClick={() => setWalletId(wallet.id)}
            >
              {wallet.label}
            </button>
          ))}
        <button
          type="button"
          className="pressable ml-auto rounded-lg bg-black/10 px-3 py-1.5 text-sm"
          onClick={() => setLayout(layout === 'single' ? 'split' : 'single')}
        >
          {layout === 'single' ? 'Split view' : 'Single view'}
        </button>
      </header>
      {layout === 'split' ? <SplitView /> : <WalletPane key={walletId} walletId={walletId} />}
    </div>
  )
}
