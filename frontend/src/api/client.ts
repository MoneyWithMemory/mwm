import type {
  AdviceView,
  AgentProfile,
  AgentSearchRequest,
  AgentSearchResult,
  AskRequest,
  AskView,
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
  TransferResult,
  UpdateAgentProfileRequest,
  WalletId,
  WalletState,
  WalletSummary,
} from './types'

export interface RequestOptions {
  signal?: AbortSignal
}

/** One method per endpoint. Implemented by HttpApiClient and the mock. */
export interface ApiClient {
  health(opts?: RequestOptions): Promise<Health>
  market(opts?: RequestOptions): Promise<Market>
  listWallets(opts?: RequestOptions): Promise<WalletSummary[]>
  getWallet(walletId: WalletId, opts?: RequestOptions): Promise<WalletState>
  createWallet(body: CreateWalletRequest, opts?: RequestOptions): Promise<WalletSummary>
  setAlias(walletId: WalletId, body: SetAliasRequest, opts?: RequestOptions): Promise<Record<string, string>>
  updateAgentProfile(walletId: WalletId, body: UpdateAgentProfileRequest, opts?: RequestOptions): Promise<AgentProfile>
  getContacts(walletId: WalletId, opts?: RequestOptions): Promise<Contact[]>
  receiveInvoice(walletId: WalletId, assetId: AssetId, amount: number, opts?: RequestOptions): Promise<ReceiveInvoice>
  refreshWallet(walletId: WalletId, opts?: RequestOptions): Promise<RefreshResult>
  /** Pays the wallet's own Vault: the backend asks the Vault for the invoice itself, never the client. */
  moveToVault(walletId: WalletId, assetId: AssetId, amount: number, opts?: RequestOptions): Promise<TransferResult>
  getAdvice(walletId: WalletId, opts?: RequestOptions): Promise<AdviceView>
  /** Your AI: a preset or a free question, answered from the owner's own data on this device. */
  ask(walletId: WalletId, body: AskRequest, opts?: RequestOptions): Promise<AskView>
  createSession(body: CreateSessionRequest, opts?: RequestOptions): Promise<SessionView>
  listSessions(walletId: WalletId, opts?: RequestOptions): Promise<SessionSummary[]>
  getSession(sessionId: SessionId, walletId: WalletId, opts?: RequestOptions): Promise<SessionView>
  /** termsHash: the terms_hash shown to the user when they approved. */
  sign(sessionId: SessionId, walletId: WalletId, termsHash: string, opts?: RequestOptions): Promise<SessionView>
  cancel(sessionId: SessionId, walletId: WalletId, opts?: RequestOptions): Promise<SessionView>
  getShop(walletId: WalletId, query?: ShopQuery, opts?: RequestOptions): Promise<ShopListing[]>
  createWant(body: CreateWantRequest, opts?: RequestOptions): Promise<ShopListing>
  closeListing(walletId: WalletId, listingId: string, opts?: RequestOptions): Promise<ShopListing>
  agentSearch(body: AgentSearchRequest, opts?: RequestOptions): Promise<AgentSearchResult>
}

/** Client-side codes; the backend may send others in ApiErrorBody.code. */
export const ERROR_CODES = {
  network: 'network_error',
  timeout: 'timeout',
  aborted: 'aborted',
  badResponse: 'bad_response',
  notImplemented: 'not_implemented',
} as const

/** Every client rejects with this, whatever went wrong. */
export class ApiError extends Error {
  readonly code: string
  /** HTTP status, or 0 when the request never got a response. */
  readonly status: number

  constructor(code: string, message: string, status = 0) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err
  if (err instanceof Error) return new ApiError(ERROR_CODES.network, err.message)
  return new ApiError(ERROR_CODES.network, String(err))
}

/** Shown when the backend refuses a price with cents: prices are whole dollars (src/lib/usd.ts). */
export const WHOLE_USD_MESSAGE = 'Use whole dollars, for example 2.'

/**
 * A backend error message as people read it. A 400 invalid_request from the request schema lists
 * fields ("body.buyer_target_usd: Input should be a valid integer, …"): it becomes one plain
 * sentence. Every other message is already written for people and stays as it is.
 */
export function readableMessage(code: string, message: string): string {
  if (code !== 'invalid_request' || !/^(body|query|path)\./.test(message)) return message
  return /_usd: [^;]*integer/.test(message) ? WHOLE_USD_MESSAGE : 'Some values are not valid. Check them and try again.'
}
