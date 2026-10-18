// The two backend endpoints the Vault calls: an invoice from its own AI wallet, and that wallet's refresh.
import { VaultError } from './errors.js'

const TIMEOUT_MS = 60_000

export function createBackendClient (baseUrl) {
  async function post (path, body) {
    let res
    try {
      res = await fetch(baseUrl + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch {
      throw new VaultError(503, 'backend_unavailable', 'Your wallet is not reachable right now. Try again in a moment.')
    }
    const data = await res.json().catch(() => null)
    if (res.ok) return data
    // The backend's own 4xx errors are already written for the user; anything else becomes one plain message.
    if (res.status < 500 && typeof data?.code === 'string' && typeof data?.message === 'string') {
      throw new VaultError(res.status, data.code, data.message)
    }
    throw new VaultError(502, 'backend_error', 'Your wallet could not complete the request. Try again in a moment.')
  }

  const walletPath = (walletId, action) => `/api/wallets/${encodeURIComponent(walletId)}/${action}`

  return {
    receiveInvoice: (walletId, assetId, amount) => post(walletPath(walletId, 'receive_invoice'), { asset_id: assetId, amount }),
    refresh: (walletId) => post(walletPath(walletId, 'refresh'))
  }
}
