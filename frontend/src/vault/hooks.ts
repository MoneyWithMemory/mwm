import { useState } from 'react'
import { api } from '@/api/api'
import { useMutation, usePoll, type PollState } from '@/api/hooks'
import type { AssetId, TransferResult, WalletId } from '@/api/types'
import type { MoveDirection } from './move'
import type { VaultState } from './types'
import { vault } from './vault'

/** Vault poll (ms). Every successful mutation also refreshes it, like the backend's polls. */
export const VAULT_POLL_MS = 2000

// Vaults with a transfer arriving: their poll settles it (refresh) instead of only reading.
const arriving = new Set<WalletId>()

async function readVault(walletId: WalletId, signal: AbortSignal): Promise<VaultState> {
  try {
    const state = await (arriving.has(walletId) ? vault.refresh(walletId, { signal }) : vault.get(walletId, { signal }))
    if (state.assets.some((a) => a.pending > 0)) arriving.add(walletId)
    else arriving.delete(walletId)
    return state
  } catch (err) {
    arriving.delete(walletId)
    throw err
  }
}

export interface VaultPoll extends PollState<VaultState> {
  /** Shows a mutation's own VaultState (create, unlock, lock) at once, until the next poll lands. */
  accept: (state: VaultState) => void
}

export function useVault(walletId: WalletId | null): VaultPoll {
  const poll = usePoll(walletId && `vault:${walletId}`, (signal) => readVault(walletId as WalletId, signal), VAULT_POLL_MS)
  const [accepted, setAccepted] = useState<VaultState | null>(null)
  const [seen, setSeen] = useState(poll.data)
  if (seen !== poll.data) {
    setSeen(poll.data)
    setAccepted(null)
  }
  const data = accepted?.wallet_id === walletId ? accepted : poll.data
  return { ...poll, data, accept: setAccepted }
}

/** One move between the two parts. The side that receives settles on its next refresh. */
async function move(direction: MoveDirection, walletId: WalletId, assetId: AssetId, amount: number): Promise<TransferResult> {
  if (direction === 'to_vault') {
    const result = await api.moveToVault(walletId, assetId, amount)
    arriving.add(walletId)
    return result
  }
  const result = await vault.moveToWallet(walletId, assetId, amount)
  // The Vault has already asked the backend to settle it; a second ask costs nothing if it is done.
  void api.refreshWallet(walletId).catch(() => undefined)
  return result
}

const createVault = (...args: Parameters<typeof vault.create>) => vault.create(...args)
const unlockVault = (...args: Parameters<typeof vault.unlock>) => vault.unlock(...args)
const lockVault = (...args: Parameters<typeof vault.lock>) => vault.lock(...args)
const sendFromVault = (...args: Parameters<typeof vault.send>) => vault.send(...args)

export const useCreateVault = () => useMutation(createVault)
export const useUnlockVault = () => useMutation(unlockVault)
export const useLockVault = () => useMutation(lockVault)
export const useMove = () => useMutation(move)
export const useVaultSend = () => useMutation(sendFromVault)
