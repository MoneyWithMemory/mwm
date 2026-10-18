import { useEffect, useEffectEvent } from 'react'
import type { WalletId } from '@/api'

// "Move to Vault" asked from outside the Wallet view (Your AI). The Wallet view takes a request
// once it is on screen with its Vault loaded, whether it was asked before or after.
const requested = new Set<WalletId>()
const takers = new Set<() => void>()

export function requestMoveToVault(walletId: WalletId): void {
  requested.add(walletId)
  takers.forEach((take) => take())
}

/** Calls `open` for a request waiting for this wallet, and for each new one, while `ready`. */
export function useMoveToVaultRequests(walletId: WalletId, ready: boolean, open: () => void): void {
  const onRequest = useEffectEvent(open)
  useEffect(() => {
    if (!ready) return
    const take = () => {
      if (requested.delete(walletId)) onRequest()
    }
    take()
    takers.add(take)
    return () => {
      takers.delete(take)
    }
  }, [walletId, ready])
}
