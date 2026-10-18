import { useCallback, useSyncExternalStore } from 'react'
import type { WalletId } from '@/api'

/** The two parts of one account, like Wallet and TON Space in Telegram. */
export type WalletPart = 'wallet' | 'vault'

// Kept per wallet outside the view, so Back from another view returns to the same part.
const parts = new Map<WalletId, WalletPart>()
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useWalletPart(walletId: WalletId): [WalletPart, (part: WalletPart) => void] {
  const part = useSyncExternalStore(subscribe, () => parts.get(walletId) ?? 'wallet')
  const setPart = useCallback(
    (next: WalletPart) => {
      parts.set(walletId, next)
      listeners.forEach((listener) => listener())
    },
    [walletId],
  )
  return [part, setPart]
}
