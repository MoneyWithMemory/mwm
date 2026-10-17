import { useWalletContext } from '@/lib/navigation'

// Stub (M1.1). Owned by Domi from here on: see M2.4.
export function ContactsView() {
  const { navigate } = useWalletContext()

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-lg font-semibold">Contacts</h1>
      <p className="text-sm opacity-70">No-KYC address book with Reliability % and trust tier.</p>
      <button
        type="button"
        className="pressable self-start rounded-lg bg-black/10 px-3 py-2 text-sm"
        onClick={() => navigate('trade', { counterpartyId: 'wallet_b' })}
      >
        Trade with Wallet B
      </button>
    </div>
  )
}
