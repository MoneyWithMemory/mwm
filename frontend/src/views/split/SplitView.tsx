import { Avatar } from '@/components/ui'
import { WalletPane } from '@/components/shell/WalletPane'
import { DEMO_WALLETS } from '@/lib/demo-wallets'

/** Wallet A | Wallet B. Roles (buyer or seller) only show up inside a session, never in these headers. */
const PANES = [DEMO_WALLETS[0], DEMO_WALLETS[1]] as const

/** Two phone-shaped columns side by side, centered, instead of two stretched halves. */
export function SplitView() {
  return (
    <div className="flex min-h-0 flex-1 justify-center gap-6 p-4">
      {PANES.map((wallet) => (
        <section
          key={wallet.id}
          className="flex min-h-0 w-full max-w-[420px] flex-1 flex-col overflow-hidden rounded-sheet border border-separator bg-bg"
          aria-label={wallet.label}
        >
          <h2 className="flex items-center gap-2 border-b border-separator px-4 py-2 text-sm font-semibold">
            <Avatar seed={wallet.id} label={wallet.label} size="sm" />
            <span className="badge-nowrap truncate">{wallet.label}</span>
          </h2>
          <WalletPane walletId={wallet.id} autoHideIsland={false} />
        </section>
      ))}
    </div>
  )
}
