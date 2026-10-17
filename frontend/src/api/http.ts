import { ApiError, ERROR_CODES, type ApiClient, type RequestOptions } from './client'
import type {
  AgentProfile,
  ApiErrorBody,
  Contact,
  CreateSessionRequest,
  CreateWalletRequest,
  Health,
  Market,
  SessionId,
  SessionSummary,
  SessionView,
  SetAliasRequest,
  UpdateAgentProfileRequest,
  WalletId,
  WalletState,
  WalletSummary,
} from './types'

const DEFAULT_TIMEOUT_MS = 15_000
/** Signing can start the on-chain swap; allow for slow regtest calls. */
const SIGN_TIMEOUT_MS = 120_000

type Method = 'GET' | 'POST' | 'PUT'

const enc = encodeURIComponent

function isErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value
}

/** Talks to the backend through the same-origin /api proxy (see vite.config.ts). */
export class HttpApiClient implements ApiClient {
  private readonly base: string

  constructor(base = '/api') {
    this.base = base
  }

  private async request<T>(method: Method, path: string, opts: RequestOptions & { body?: unknown; timeoutMs?: number } = {}): Promise<T> {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const onAbort = () => controller.abort()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) controller.abort()

    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        signal: controller.signal,
        headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
      const data: unknown = await res.json().catch(() => undefined)
      if (!res.ok) {
        if (isErrorBody(data)) throw new ApiError(data.code, data.message, res.status)
        throw new ApiError(`http_${res.status}`, res.statusText || `HTTP ${res.status}`, res.status)
      }
      if (data === undefined) throw new ApiError(ERROR_CODES.badResponse, `Invalid JSON from ${path}`, res.status)
      return data as T
    } catch (err) {
      if (err instanceof ApiError) throw err
      if (controller.signal.aborted) {
        throw timedOut
          ? new ApiError(ERROR_CODES.timeout, `Request to ${path} timed out`)
          : new ApiError(ERROR_CODES.aborted, 'Request aborted')
      }
      throw new ApiError(ERROR_CODES.network, err instanceof Error ? err.message : 'Network error')
    } finally {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  health(opts?: RequestOptions) {
    return this.request<Health>('GET', '/health', opts)
  }

  market(opts?: RequestOptions) {
    return this.request<Market>('GET', '/market', opts)
  }

  listWallets(opts?: RequestOptions) {
    return this.request<WalletSummary[]>('GET', '/wallets', opts)
  }

  getWallet(walletId: WalletId, opts?: RequestOptions) {
    return this.request<WalletState>('GET', `/wallets/${enc(walletId)}`, opts)
  }

  createWallet(body: CreateWalletRequest, opts?: RequestOptions) {
    return this.request<WalletSummary>('POST', '/wallets/create', { ...opts, body })
  }

  setAlias(walletId: WalletId, body: SetAliasRequest, opts?: RequestOptions) {
    return this.request<Record<string, string>>('PUT', `/wallets/${enc(walletId)}/aliases`, { ...opts, body })
  }

  updateAgentProfile(walletId: WalletId, body: UpdateAgentProfileRequest, opts?: RequestOptions) {
    return this.request<AgentProfile>('PUT', `/wallets/${enc(walletId)}/agent_profile`, { ...opts, body })
  }

  getContacts(walletId: WalletId, opts?: RequestOptions) {
    return this.request<Contact[]>('GET', `/wallets/${enc(walletId)}/contacts`, opts)
  }

  createSession(body: CreateSessionRequest, opts?: RequestOptions) {
    return this.request<SessionView>('POST', '/sessions', { ...opts, body })
  }

  listSessions(walletId: WalletId, opts?: RequestOptions) {
    return this.request<SessionSummary[]>('GET', `/sessions?wallet_id=${enc(walletId)}`, opts)
  }

  getSession(sessionId: SessionId, walletId: WalletId, opts?: RequestOptions) {
    return this.request<SessionView>('GET', `/sessions/${enc(sessionId)}?wallet_id=${enc(walletId)}`, opts)
  }

  sign(sessionId: SessionId, walletId: WalletId, opts?: RequestOptions) {
    return this.request<SessionView>('POST', `/sessions/${enc(sessionId)}/sign`, {
      ...opts,
      body: { wallet_id: walletId },
      timeoutMs: SIGN_TIMEOUT_MS,
    })
  }

  cancel(sessionId: SessionId, walletId: WalletId, opts?: RequestOptions) {
    return this.request<SessionView>('POST', `/sessions/${enc(sessionId)}/cancel`, { ...opts, body: { wallet_id: walletId } })
  }
}
