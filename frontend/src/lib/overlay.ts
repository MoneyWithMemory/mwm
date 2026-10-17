import { createContext, useContext } from 'react'

/**
 * Element that hosts sheets and modals for the current scope: each WalletPane
 * has its own (so in split view an overlay covers only its pane), and the app
 * shell has one for app-level sheets. Provided by <OverlayLayer>.
 */
export const OverlayRootContext = createContext<HTMLElement | null>(null)

export function useOverlayRoot(): HTMLElement | null {
  return useContext(OverlayRootContext)
}
