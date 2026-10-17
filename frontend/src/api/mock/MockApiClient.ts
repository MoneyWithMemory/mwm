import { ApiError, ERROR_CODES, type ApiClient, type RequestOptions } from '../client'
import type {
  CreateSessionRequest,
  CreateWalletRequest,
  SessionId,
  SetAliasRequest,
  UpdateAgentProfileRequest,
  WalletId,
} from '../types'
import { mockEngine } from './engine'

/** Fake network latency, so loading states show up like they will against the backend. */
const MIN_LATENCY_MS = 150
const MAX_LATENCY_MS = 400

function wait(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, MIN_LATENCY_MS + Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS))
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new ApiError(ERROR_CODES.aborted, 'Request aborted'))
      },
      { once: true },
    )
  })
}

/** Runs `fn` after the latency and returns a deep copy, so callers never share engine state. */
async function call<T>(fn: () => T, opts?: RequestOptions): Promise<T> {
  await wait(opts?.signal)
  return structuredClone(fn())
}

/** In-browser backend: one engine per tab, shared by both panes of the split view. */
export class MockApiClient implements ApiClient {
  health(opts?: RequestOptions) {
    return call(() => mockEngine.health(), opts)
  }

  market(opts?: RequestOptions) {
    return call(() => mockEngine.market(), opts)
  }

  listWallets(opts?: RequestOptions) {
    return call(() => mockEngine.listWallets(), opts)
  }

  getWallet(walletId: WalletId, opts?: RequestOptions) {
    return call(() => mockEngine.getWallet(walletId), opts)
  }

  createWallet(body: CreateWalletRequest, opts?: RequestOptions) {
    return call(() => mockEngine.createWallet(body), opts)
  }

  setAlias(walletId: WalletId, body: SetAliasRequest, opts?: RequestOptions) {
    return call(() => mockEngine.setAlias(walletId, body), opts)
  }

  updateAgentProfile(walletId: WalletId, body: UpdateAgentProfileRequest, opts?: RequestOptions) {
    return call(() => mockEngine.updateAgentProfile(walletId, body), opts)
  }

  getContacts(walletId: WalletId, opts?: RequestOptions) {
    return call(() => mockEngine.getContacts(walletId), opts)
  }

  createSession(body: CreateSessionRequest, opts?: RequestOptions) {
    return call(() => mockEngine.createSession(body), opts)
  }

  listSessions(walletId: WalletId, opts?: RequestOptions) {
    return call(() => mockEngine.listSessions(walletId), opts)
  }

  getSession(sessionId: SessionId, walletId: WalletId, opts?: RequestOptions) {
    return call(() => mockEngine.getSession(sessionId, walletId), opts)
  }

  sign(sessionId: SessionId, walletId: WalletId, termsHash: string, opts?: RequestOptions) {
    return call(() => mockEngine.sign(sessionId, walletId, termsHash), opts)
  }

  cancel(sessionId: SessionId, walletId: WalletId, opts?: RequestOptions) {
    return call(() => mockEngine.cancel(sessionId, walletId), opts)
  }
}
