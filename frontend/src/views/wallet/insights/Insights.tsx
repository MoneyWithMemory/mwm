import type { WalletState, Market } from '@/api'
import { AllocationCard } from './AllocationCard'
import { CounterpartiesCard } from './CounterpartiesCard'
import { FlowCard } from './FlowCard'

/** Three charts, all built only from the wallet's own balances, deals and activity: nothing is estimated. */
export function Insights({
  wallet,
  market,
  nowSeconds,
}: {
  wallet: WalletState
  market: Market
  nowSeconds: number
}) {
  return (
    <section className="flex flex-col gap-3" aria-label="Insights">
      <h2 className="px-1 text-sm font-semibold text-hint">Insights</h2>
      <div className="flex flex-col gap-3">
        <AllocationCard assets={wallet.assets} market={market} />
        <FlowCard activity={wallet.activity} market={market} nowSeconds={nowSeconds} />
        <CounterpartiesCard activity={wallet.activity} aliases={wallet.local_aliases} market={market} />
      </div>
    </section>
  )
}
