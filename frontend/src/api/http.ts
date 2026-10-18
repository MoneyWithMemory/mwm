import { ApiError, ERROR_CODES, readableMessage, type ApiClient, type RequestOptions } from './client'
import type {
  AdviceView,
  AgentProfile,
  AgentSearchRequest,
  AgentSearchResult,
  AskRequest,
  AskView,
  ApiErrorBody,
  AssetAmountRequest,
  AssetId,
  Contact,
  CreateSessionRequest,
  CreateWantRequest,
  CreateWalletRequest,
  Health,
  Market,
  ReceiveInvoice,
  RefreshResult,
  SessionId,
  SessionSummary,
  SessionView,
  SetAliasRequest,
  ShopListing,
  ShopQuery,
  SignRequest,
  TransferResult,
  UpdateAgentProfileRequest,
  WalletId,
  WalletState,
  WalletSummary,
} from './types'

const DEFAULT_TIMEOUT_MS = 15_000
/** Signing can start the on-chain swap; allow for slow regtest calls. */
const SIGN_TIMEOUT_MS = 120_000
/** A move waits for the swap lock, pays, mines a block and refreshes both sides. */
export const MOVE_TIMEOUT_MS = 120_000
/** The local model answers in at most ~12 s, else the backend sends the quick version. */
const ASK_TIMEOUT_MS = 25_000

export type Method = 'GET' | 'POST' | 'PUT'

export type JsonRequestOptions = RequestOptions & { body?: unknown; timeoutMs?: number }

const enc = encodeURIComponent

function isErrorBody(value: unknown): value is ApiErrorBody {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value
}

/**
 * One JSON request to `${base}${path}`. Rejects with ApiError: the {code, message} body of a
 * non-2xx response, or a client-side code. The Vault client (src/vault/http.ts) shares it.
 */
export async function requestJson<T>(base: string, method: Method, path: string, opts: JsonRequestOptions = {}): Promise<T> {
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
    const res = await fetch(`${base}${path}`, {
      method,
      signal: controller.signal,
      headers: opts.body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    })
    const data: unknown = await res.json().catch(() => undefined)
    if (!res.ok) {
      if (isErrorBody(data)) throw new ApiError(data.code, readableMessage(data.code, data.message), res.status)
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

/** Talks to the backend through the same-origin /api proxy (see vite.config.ts). */
export class HttpApiClient implements ApiClient {
  private readonly base: string

  constructor(base = '/api') {
    this.base = base
  }

  private request<T>(method: Method, path: string, opts: JsonRequestOptions = {}): Promise<T> {
    return requestJson<T>(this.base, method, path, opts)
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

  receiveInvoice(walletId: WalletId, assetId: AssetId, amount: number, opts?: RequestOptions) {
    const body: AssetAmountRequest = { asset_id: assetId, amount }
    return this.request<ReceiveInvoice>('POST', `/wallets/${enc(walletId)}/receive_invoice`, { ...opts, body })
  }

  refreshWallet(walletId: WalletId, opts?: RequestOptions) {
    return this.request<RefreshResult>('POST', `/wallets/${enc(walletId)}/refresh`, opts)
  }

  moveToVault(walletId: WalletId, assetId: AssetId, amount: number, opts?: RequestOptions) {
    const body: AssetAmountRequest = { asset_id: assetId, amount }
    return this.request<TransferResult>('POST', `/wallets/${enc(walletId)}/move_to_vault`, { ...opts, body, timeoutMs: MOVE_TIMEOUT_MS })
  }

  getAdvice(walletId: WalletId, opts?: RequestOptions) {
    return this.request<AdviceView>('GET', `/wallets/${enc(walletId)}/advice`, opts)
  }

  ask(walletId: WalletId, body: AskRequest, opts?: RequestOptions) {
    return this.request<AskView>('POST', `/wallets/${enc(walletId)}/ask`, { ...opts, body, timeoutMs: ASK_TIMEOUT_MS })
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

  sign(sessionId: SessionId, walletId: WalletId, termsHash: string, opts?: RequestOptions) {
    const body: SignRequest = { wallet_id: walletId, terms_hash: termsHash }
    return this.request<SessionView>('POST', `/sessions/${enc(sessionId)}/sign`, {
      ...opts,
      body,
      timeoutMs: SIGN_TIMEOUT_MS,
    })
  }

  cancel(sessionId: SessionId, walletId: WalletId, opts?: RequestOptions) {
    return this.request<SessionView>('POST', `/sessions/${enc(sessionId)}/cancel`, { ...opts, body: { wallet_id: walletId } })
  }

  getShop(walletId: WalletId, query: ShopQuery = {}, opts?: RequestOptions) {
    const params = new URLSearchParams({ wallet_id: walletId })
    for (const [key, value] of Object.entries(query)) if (value) params.set(key, value)
    return this.request<ShopListing[]>('GET', `/shop?${params}`, opts)
  }

  createWant(body: CreateWantRequest, opts?: RequestOptions) {
    return this.request<ShopListing>('POST', '/shop/wants', { ...opts, body })
  }

  closeListing(walletId: WalletId, listingId: string, opts?: RequestOptions) {
    return this.request<ShopListing>('POST', `/shop/${enc(listingId)}/close`, { ...opts, body: { wallet_id: walletId } })
  }

  agentSearch(body: AgentSearchRequest, opts?: RequestOptions) {
    return this.request<AgentSearchResult>('POST', '/shop/agent_search', { ...opts, body })
  }
}
