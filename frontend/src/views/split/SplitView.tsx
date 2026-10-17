import { Avatar } from '@/components/ui'
import { WalletPane } from '@/components/shell/WalletPane'
import { DEMO_WALLETS } from '@/lib/demo-wallets'

/** Wallet A | Wallet B. Roles (buyer or seller) only show up inside a session, never in these headers. */
const PANES = [DEMO_WALLETS[0], DEMO_WALLETS[1]] as const

export function SplitView() {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-separator">
      {PANES.map((wallet) => (
        <section key={wallet.id} className="flex min-h-0 min-w-0 flex-col" aria-label={wallet.label}>
          <h2 className="flex items-center gap-2 border-b border-separator px-4 py-2 text-sm font-semibold">
            <Avatar seed={wallet.id} label={wallet.label} size="sm" />
            <span className="badge-nowrap truncate">{wallet.label}</span>
          </h2>
          <WalletPane walletId={wallet.id} />
        </section>
      ))}
    </div>
  )
}
