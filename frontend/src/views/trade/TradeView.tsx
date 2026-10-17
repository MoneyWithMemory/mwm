import { useViewParams, useWalletContext } from '@/lib/navigation'

// Stub (M1.1). Owned by Domi from here on: see M2.3.
export function TradeView() {
  const { canGoBack, back } = useWalletContext()
  const params = useViewParams('trade')

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">P2P Trade</h1>
      <p className="text-sm opacity-70">
        Counterparty: {params?.counterpartyId ?? 'not selected'} · Session: {params?.sessionId ?? 'none'}
      </p>
      {canGoBack && (
        <button type="button" className="pressable self-start rounded-lg bg-black/10 px-3 py-2 text-sm" onClick={back}>
          Back
        </button>
      )}
    </div>
  )
}
