import { useState } from 'react'
import { useMarket, useWallet } from '@/api'
import { AmountCountUp, ErrorState } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { ActivityList } from './ActivityList'
import { Insights } from './insights/Insights'
import { AssetList } from './AssetList'
import { BalanceChart } from './BalanceChart'
import { ReceiveSheet } from './ReceiveSheet'
import { RenameSheet } from '../shared/RenameSheet'
import { WalletActions } from './WalletActions'
import { WalletSkeleton } from './WalletSkeleton'
import { totalValueUsd } from './valuation'

export function WalletView() {
  const { walletId, navigate } = useWalletContext()
  const wallet = useWallet(walletId)
  const market = useMarket()
  // Read once per mount: the weekly buckets only need day-level accuracy.
  const [clock] = useState(() => Date.now())
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [rename, setRename] = useState<{ address: string; open: boolean } | null>(null)

  const state = wallet.data

  if (!state) {
    return (
      <div className="flex flex-col justify-start p-4">
        {wallet.error ? (
          <ErrorState
            title="Couldn't load your wallet"
            message="Check your connection and try again."
            onRetry={wallet.refresh}
          />
        ) : (
          <WalletSkeleton />
        )}
      </div>
    )
  }

  const total = totalValueUsd(state.assets, market.data)
  const nowSeconds = Math.floor(clock / 1000)

  return (
    // Laid out by the pane's own width, not the viewport: one column in a phone or half-screen
    // pane, two columns (main 2fr, side 1fr) once the pane is wide enough. DOM order is the mobile order.
    <div className="@container">
      <div className="flex flex-col justify-start gap-5 p-4 @4xl:grid @4xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] @4xl:items-start @4xl:gap-6 @4xl:p-6">
        <div className="flex flex-col gap-5 @4xl:col-span-2 @4xl:flex-row @4xl:items-end @4xl:justify-between">
          <header className="flex flex-col gap-1">
            <p className="text-sm text-hint">{state.label}</p>
            <p className="text-hero">
              {market.data ? <AmountCountUp value={total} prefix="$" /> : <span className="amount text-hint">—</span>}
            </p>
            <p className="text-xs text-hint">Total balance</p>
          </header>
          <WalletActions
            className="@4xl:justify-end @4xl:gap-8"
            onReceive={() => setReceiveOpen(true)}
            onTrade={() => navigate('trade')}
            onSellerDesk={() => navigate('seller-desk')}
          />
        </div>

        <div className="min-w-0 @4xl:col-start-1 @4xl:row-start-2">
          <BalanceChart walletId={walletId} points={state.history_points} assets={state.assets} />
        </div>
        <div className="flex min-w-0 flex-col gap-5 @4xl:col-start-2 @4xl:row-span-2 @4xl:row-start-2">
          <AssetList assets={state.assets} costBasis={state.avg_cost_basis} market={market.data} />
          {market.data && <Insights wallet={state} market={market.data} nowSeconds={nowSeconds} />}
        </div>
        <div className="min-w-0 @4xl:col-start-1 @4xl:row-start-3">
          <ActivityList
            items={state.activity}
            aliases={state.local_aliases}
            onRename={(address) => setRename({ address, open: true })}
          />
        </div>
      </div>

      <ReceiveSheet open={receiveOpen} onClose={() => setReceiveOpen(false)} address={state.address} />
      {rename && (
        <RenameSheet
          key={rename.address}
          open={rename.open}
          onClose={() => setRename((r) => r && { ...r, open: false })}
          walletId={walletId}
          address={rename.address}
          currentName={state.local_aliases[rename.address] ?? ''}
        />
      )}
    </div>
  )
}
