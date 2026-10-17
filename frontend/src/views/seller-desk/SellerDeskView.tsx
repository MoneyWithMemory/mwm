import { useWalletContext } from '@/lib/navigation'

// Stub (M1.1). Owned by Domi from here on: see M2.2.
export function SellerDeskView() {
  const { canGoBack, back } = useWalletContext()

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">Seller Desk</h1>
      <p className="text-sm opacity-70">Offer, public asking price, secret reserve and AI strategy.</p>
      {canGoBack && (
        <button type="button" className="pressable self-start rounded-lg bg-black/10 px-3 py-2 text-sm" onClick={back}>
          Back
        </button>
      )}
    </div>
  )
}
