import { createContext, useContext } from 'react'

/**
 * Per-pane navigation. There is no URL router: every WalletPane owns its own
 * view stack, so the single layout mounts one pane and the split layout two,
 * and views never know which layout they are in.
 */

/** Params each view accepts; `undefined` means the view takes none. */
export type ViewParams = {
  wallet: { sheet?: 'receive' } | undefined
  /** counterpartyId is the counterparty's address (Contact.address); sessionId opens an existing session. */
  trade: { counterpartyId?: string; sessionId?: string } | undefined
  'seller-desk': undefined
  contacts: undefined
}

export type ViewName = keyof ViewParams

export type NavEntry = {
  [V in ViewName]: { view: V; params: ViewParams[V] }
}[ViewName]

/** Params are optional only for views whose params type includes `undefined`. */
export type NavigateArgs<V extends ViewName> = undefined extends ViewParams[V]
  ? [view: V, params?: ViewParams[V]]
  : [view: V, params: ViewParams[V]]

export type WalletContextValue = {
  walletId: string
  current: NavEntry
  canGoBack: boolean
  /** Push a view on this pane's stack, e.g. navigate('trade', { counterpartyId }). */
  navigate: <V extends ViewName>(...args: NavigateArgs<V>) => void
  /** Replace the whole stack with one view (tab switches). */
  reset: <V extends ViewName>(...args: NavigateArgs<V>) => void
  back: () => void
}

export const WalletContext = createContext<WalletContextValue | null>(null)

export function useWalletContext(): WalletContextValue {
  const ctx = useContext(WalletContext)
  if (!ctx) throw new Error('useWalletContext must be used inside a WalletPane')
  return ctx
}

/** Typed params of the current view; undefined if another view is on top. */
export function useViewParams<V extends ViewName>(view: V): ViewParams[V] | undefined {
  const { current } = useWalletContext()
  return current.view === view ? (current.params as ViewParams[V]) : undefined
}
