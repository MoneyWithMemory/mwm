import { useState } from 'react'
import { AnimatePresence, motion } from 'motion/react'
import { useMarket, useWallet, type Market, type WalletState } from '@/api'
import { Lock, QrCode, Wallet } from 'lucide-react'
import { AmountCountUp, Button, ErrorState, Tabs, type TabItem } from '@/components/ui'
import { viewSwap } from '@/lib/motion'
import { useWalletContext } from '@/lib/navigation'
import { useVault, type MoveDirection } from '@/vault'
import { ActivityList } from './ActivityList'
import { Insights } from './insights/Insights'
import { AssetList } from './AssetList'
import { BalanceChart } from './BalanceChart'
import { ReceiveSheet } from './ReceiveSheet'
import { RenameSheet } from '../shared/RenameSheet'
import { WalletSkeleton } from './WalletSkeleton'
import { totalValueUsd, withCurrentPoint } from './valuation'
import { MoveSheet } from './vault/MoveSheet'
import { useMoveToVaultRequests } from './vault/moveRequest'
import { useWalletPart, type WalletPart } from './vault/part'
import { SendSheet } from './vault/SendSheet'
import { VaultPart } from './vault/VaultPart'

const PARTS: TabItem<WalletPart>[] = [
  { id: 'wallet', label: 'Wallet', icon: Wallet },
  { id: 'vault', label: 'Vault', icon: Lock },
]

/** One account, two parts: the Wallet the agents trade with, and the Vault only the owner can spend. */
export function WalletView() {
  const { walletId } = useWalletContext()
  const wallet = useWallet(walletId)
  const market = useMarket()
  const vault = useVault(walletId)
  const [part, setPart] = useWalletPart(walletId)
  const [receiveOpen, setReceiveOpen] = useState(false)
  const [rename, setRename] = useState<{ address: string; open: boolean } | null>(null)
  const [move, setMove] = useState<{ direction: MoveDirection; open: boolean } | null>(null)
  const [sendOpen, setSendOpen] = useState(false)

  const state = wallet.data
  const openMove = (direction: MoveDirection) => setMove({ direction, open: true })
  // One tap from the Wallet; a Vault that is missing or locked first shows itself.
  const moveToVault = () => (vault.data?.unlocked ? openMove('to_vault') : setPart('vault'))

  // Asked from Your AI: opened once the wallet and its Vault have loaded.
  useMoveToVaultRequests(walletId, Boolean(state) && !vault.loading, moveToVault)

  return (
    // Laid out by the pane's own width, not the viewport: one column in a phone or half-screen
    // pane, two columns (main 2fr, side 1fr) once the pane is wide enough. DOM order is the mobile order.
    <div className="@container">
      <div className="flex flex-col justify-start gap-5 p-4 @4xl:gap-6 @4xl:p-6">
        <Tabs tabs={PARTS} activeId={part} onChange={setPart} fullWidth className="@4xl:max-w-sm" />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={part} variants={viewSwap} initial="initial" animate="animate" exit="exit" role="tabpanel">
            {part === 'vault' ? (
              <VaultPart
                walletId={walletId}
                vault={vault}
                wallet={state}
                market={market.data}
                onMove={openMove}
                onSend={() => setSendOpen(true)}
                onRename={(address) => setRename({ address, open: true })}
              />
            ) : state ? (
              <WalletPartView
                wallet={state}
                market={market.data}
                onReceive={() => setReceiveOpen(true)}
                onMoveToVault={moveToVault}
                onRename={(address) => setRename({ address, open: true })}
              />
            ) : wallet.error ? (
              <ErrorState title="Couldn't load your wallet" message="Check your connection and try again." onRetry={wallet.refresh} />
            ) : (
              <WalletSkeleton />
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {state && (
        <ReceiveSheet open={receiveOpen} onClose={() => setReceiveOpen(false)} walletId={walletId} address={state.address} market={market.data} />
      )}
      {state && vault.data && move && (
        <MoveSheet
          open={move.open}
          onClose={() => setMove((m) => m && { ...m, open: false })}
          walletId={walletId}
          direction={move.direction}
          wallet={state}
          vault={vault.data}
          market={market.data}
        />
      )}
      <SendSheet open={sendOpen} onClose={() => setSendOpen(false)} walletId={walletId} market={market.data} />
      {state && rename && (
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

interface WalletPartViewProps {
  wallet: WalletState
  market: Market | undefined
  onReceive: () => void
  onMoveToVault: () => void
  onRename: (address: string) => void
}

/** The AI wallet: what the agents can see and trade with. */
function WalletPartView({ wallet, market, onReceive, onMoveToVault, onRename }: WalletPartViewProps) {
  // Read once per mount: the weekly buckets only need day-level accuracy.
  const [clock] = useState(() => Date.now())
  const total = totalValueUsd(wallet.assets, market)
  const nowSeconds = Math.floor(clock / 1000)
  const points = market ? withCurrentPoint(wallet.history_points, wallet.assets, total, nowSeconds) : wallet.history_points

  return (
    // The side column spans rows 2-3: its extra height goes to the last row, never between chart and activity.
    <div className="flex flex-col gap-5 @4xl:grid @4xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] @4xl:grid-rows-[auto_auto_1fr] @4xl:items-start @4xl:gap-6">
      <header className="flex items-start justify-between gap-3 @4xl:col-span-2">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm text-hint">{wallet.label}</p>
          <p className="text-hero">{market ? <AmountCountUp value={total} prefix="$" /> : <span className="amount text-hint">—</span>}</p>
          <p className="text-xs text-hint">Total balance</p>
        </div>
        <Button variant="secondary" size="sm" onClick={onReceive}>
          <QrCode size={16} aria-hidden="true" />
          Receive
        </Button>
      </header>

      <div className="min-w-0 @4xl:col-start-1 @4xl:row-start-2">
        <BalanceChart walletId={wallet.wallet_id} points={points} assets={wallet.assets} />
      </div>
      <div className="flex min-w-0 flex-col gap-5 @4xl:col-start-2 @4xl:row-span-2 @4xl:row-start-2">
        <AssetList
          assets={wallet.assets}
          costBasis={wallet.avg_cost_basis}
          market={market}
          action={
            <Button variant="ghost" size="sm" onClick={onMoveToVault}>
              <Lock size={13} aria-hidden="true" />
              Move to Vault
            </Button>
          }
        />
        {market && <Insights wallet={wallet} market={market} nowSeconds={nowSeconds} />}
      </div>
      <div className="min-w-0 @4xl:col-start-1 @4xl:row-start-3">
        <ActivityList items={wallet.activity} aliases={wallet.local_aliases} onRename={onRename} />
      </div>
    </div>
  )
}
