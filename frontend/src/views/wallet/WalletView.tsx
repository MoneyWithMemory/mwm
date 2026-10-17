import { useState } from 'react'
import { useMarket, useWallet } from '@/api'
import { useWalletContext } from '@/lib/navigation'
import { ActivityList } from './ActivityList'
import { AssetList } from './AssetList'
import { BalanceChart } from './BalanceChart'
import { CountUpUsd } from './CountUpUsd'
import { ReceiveSheet } from './ReceiveSheet'
import { RenameSheet } from './RenameSheet'
import { StateMessage } from './StateMessage'
import { WalletActions } from './WalletActions'
import { WalletSkeleton } from './WalletSkeleton'
import { totalValueUsd } from './valuation'

export function WalletView() {
  const { walletId, navigate } = useWalletContext()
  const wallet = useWallet(walletId)
  const market = useMarket()
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [rename, setRename] = useState<{ address: string; open: boolean } | null>(null)

  const state = wallet.data

  if (!state) {
    return (
      <div className="flex flex-col justify-start p-4">
        {wallet.error ? (
          <StateMessage
            title="Couldn't load your wallet"
            body="Check your connection and try again."
            action={
              <button
                type="button"
                className="pressable rounded-control bg-accent px-4 py-2 text-sm font-semibold text-on-accent"
                onClick={wallet.refresh}
              >
                Retry
              </button>
            }
          />
        ) : (
          <WalletSkeleton />
        )}
      </div>
    )
  }

  const total = totalValueUsd(state.assets, market.data)

  return (
    <div className="flex flex-col justify-start gap-5 p-4">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-hint">{state.label}</p>
        <p className="text-hero font-semibold">
          {market.data ? <CountUpUsd value={total} /> : <span className="amount text-hint">—</span>}
        </p>
        <p className="text-xs text-hint">Total balance</p>
      </header>

      <WalletActions
        onReceive={() => setReceiveOpen(true)}
        onTrade={() => navigate('trade')}
        onSellerDesk={() => navigate('seller-desk')}
      />

      <BalanceChart walletId={walletId} points={state.history_points} assets={state.assets} />
      <AssetList assets={state.assets} costBasis={state.avg_cost_basis} market={market.data} />
      <ActivityList
        items={state.activity}
        aliases={state.local_aliases}
        onRename={(address) => setRename({ address, open: true })}
      />

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
