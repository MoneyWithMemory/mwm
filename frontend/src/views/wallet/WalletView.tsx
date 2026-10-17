import { useWalletContext } from '@/lib/navigation'

// Stub (M1.1). Owned by Domi from here on: see M2.1.
export function WalletView() {
  const { walletId, navigate } = useWalletContext()

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">Wallet</h1>
      <p className="text-sm opacity-70">Balance, chart, assets and history for {walletId}.</p>
      <div className="flex gap-2">
        <button type="button" className="pressable rounded-lg bg-black/10 px-3 py-2 text-sm" onClick={() => navigate('trade')}>
          P2P Trade
        </button>
        <button type="button" className="pressable rounded-lg bg-black/10 px-3 py-2 text-sm" onClick={() => navigate('seller-desk')}>
          Seller Desk
        </button>
      </div>
    </div>
  )
}
