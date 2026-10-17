import { WalletPane } from '@/components/shell/WalletPane'
import { DEMO_WALLETS } from '@/lib/demo-wallets'

// Stub (M1.1). Owned by Domi from here on: see M2.5.
export function SplitView() {
  const panes = [DEMO_WALLETS[0], DEMO_WALLETS[1]]

  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-black/10">
      {panes.map((wallet) => (
        <div key={wallet.id} className="flex min-h-0 flex-col">
          <h2 className="border-b border-black/10 px-4 py-2 text-sm font-semibold">{wallet.label}</h2>
          <WalletPane walletId={wallet.id} />
        </div>
      ))}
    </div>
  )
}
