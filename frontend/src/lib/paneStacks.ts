import { useCallback, useSyncExternalStore } from 'react'
import type { NavEntry } from './navigation'

/**
 * Per-wallet view stacks, kept outside the panes: switching wallet in the single layout
 * returns to where that wallet was, and the shell can open a view in any wallet's pane
 * (e.g. terms waiting for Wallet B's signature) whether that pane is mounted or not.
 */

const ROOT: NavEntry = { view: 'wallet', params: undefined }
const stacks = new Map<string, NavEntry[]>()
const listeners = new Map<string, Set<() => void>>()
// Where each open view was left, by entry: Back and wallet switches return to the same place.
const scrollOffsets = new WeakMap<NavEntry, number>()

export function saveScroll(entry: NavEntry, top: number): void {
  scrollOffsets.set(entry, top)
}

/** The entry's last scroll offset; 0 for a view opened anew. */
export function savedScroll(entry: NavEntry): number {
  return scrollOffsets.get(entry) ?? 0
}

export function getStack(walletId: string): NavEntry[] {
  let stack = stacks.get(walletId)
  if (!stack) {
    stack = [ROOT]
    stacks.set(walletId, stack)
  }
  return stack
}

export function setStack(walletId: string, next: NavEntry[]): void {
  stacks.set(walletId, next)
  listeners.get(walletId)?.forEach((listener) => listener())
}

export function updateStack(walletId: string, update: (stack: NavEntry[]) => NavEntry[]): void {
  setStack(walletId, update(getStack(walletId)))
}

/** Opens a session in a wallet's pane, on top of its Deals tab. */
export function openSessionInPane(walletId: string, sessionId: string): void {
  setStack(walletId, [
    { view: 'deals', params: undefined },
    { view: 'trade', params: { sessionId } },
  ])
}

export function usePaneStack(walletId: string): NavEntry[] {
  const subscribe = useCallback(
    (listener: () => void) => {
      let set = listeners.get(walletId)
      if (!set) {
        set = new Set()
        listeners.set(walletId, set)
      }
      set.add(listener)
      return () => {
        set.delete(listener)
      }
    },
    [walletId],
  )
  return useSyncExternalStore(subscribe, () => getStack(walletId))
}
