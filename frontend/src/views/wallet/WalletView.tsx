import { useState } from 'react'
import { useMarket, useWallet } from '@/api'
import { QrCode } from 'lucide-react'
import { AmountCountUp, Button, ErrorState } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { ActivityList } from './ActivityList'
import { Insights } from './insights/Insights'
import { AssetList } from './AssetList'
import { BalanceChart } from './BalanceChart'
import { ReceiveSheet } from './ReceiveSheet'
import { RenameSheet } from '../shared/RenameSheet'
import { WalletSkeleton } from './WalletSkeleton'
import { totalValueUsd, withCurrentPoint } from './valuation'

export function WalletView() {
  const { walletId } = useWalletContext()
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
  const points = market.data ? withCurrentPoint(state.history_points, state.assets, total, nowSeconds) : state.history_points

  return (
    // Laid out by the pane's own width, not the viewport: one column in a phone or half-screen
    // pane, two columns (main 2fr, side 1fr) once the pane is wide enough. DOM order is the mobile order.
    <div className="@container">
      <div className="flex flex-col justify-start gap-5 p-4 @4xl:grid @4xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] @4xl:items-start @4xl:gap-6 @4xl:p-6">
        <header className="flex items-start justify-between gap-3 @4xl:col-span-2">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm text-hint">{state.label}</p>
            <p className="text-hero">
              {market.data ? <AmountCountUp value={total} prefix="$" /> : <span className="amount text-hint">—</span>}
            </p>
            <p className="text-xs text-hint">Total balance</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => setReceiveOpen(true)}>
            <QrCode size={16} aria-hidden="true" />
            Receive
          </Button>
        </header>

        <div className="min-w-0 @4xl:col-start-1 @4xl:row-start-2">
          <BalanceChart walletId={walletId} points={points} assets={state.assets} />
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
