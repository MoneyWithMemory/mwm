import { ApiError, ERROR_CODES, type ApiClient, type RequestOptions } from '../client'
import type {
  AgentSearchRequest,
  AskRequest,
  AssetId,
  CreateSessionRequest,
  CreateWalletRequest,
  CreateWantRequest,
  SessionId,
  SetAliasRequest,
  ShopQuery,
  UpdateAgentProfileRequest,
  WalletId,
} from '../types'
import { mockEngine } from './engine'

/** Fake network latency, so loading states show up like they will against the backend. */
const MIN_LATENCY_MS = 150
const MAX_LATENCY_MS = 400
/** An on-chain move pays, mines a block and refreshes both sides: long enough to show its progress. */
export const MOVE_LATENCY_MS = 2_000
const ASK_LATENCY_MS = 900

function wait(signal?: AbortSignal, ms = MIN_LATENCY_MS + Math.random() * (MAX_LATENCY_MS - MIN_LATENCY_MS)): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
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

/**
 * Runs `fn` after the latency and returns a deep copy, so callers never share engine state.
 * The mock Vault (src/vault/mock.ts) answers through it too.
 */
export async function call<T>(fn: () => T, opts?: RequestOptions, latencyMs?: number): Promise<T> {
  await wait(opts?.signal, latencyMs)
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

  receiveInvoice(walletId: WalletId, assetId: AssetId, amount: number, opts?: RequestOptions) {
    return call(() => mockEngine.receiveInvoice(walletId, { asset_id: assetId, amount }), opts)
  }

  refreshWallet(walletId: WalletId, opts?: RequestOptions) {
    return call(() => mockEngine.refreshWallet(walletId), opts)
  }

  /** A refusal comes back at once; only a move that goes through waits for the chain. */
  async moveToVault(walletId: WalletId, assetId: AssetId, amount: number, opts?: RequestOptions) {
    const body = { asset_id: assetId, amount }
    await call(() => mockEngine.checkMoveToVault(walletId, body), opts)
    return call(() => mockEngine.moveToVault(walletId, body), opts, MOVE_LATENCY_MS)
  }

  getAdvice(walletId: WalletId, opts?: RequestOptions) {
    return call(() => mockEngine.getAdvice(walletId), opts)
  }

  /** A short wait, like the local model, so the thinking state shows. */
  ask(walletId: WalletId, body: AskRequest, opts?: RequestOptions) {
    return call(() => mockEngine.ask(walletId, body), opts, ASK_LATENCY_MS)
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

  getShop(walletId: WalletId, query?: ShopQuery, opts?: RequestOptions) {
    return call(() => mockEngine.getShop(walletId, query), opts)
  }

  createWant(body: CreateWantRequest, opts?: RequestOptions) {
    return call(() => mockEngine.createWant(body), opts)
  }

  closeListing(walletId: WalletId, listingId: string, opts?: RequestOptions) {
    return call(() => mockEngine.closeListing(walletId, listingId), opts)
  }

  agentSearch(body: AgentSearchRequest, opts?: RequestOptions) {
    return call(() => mockEngine.agentSearch(body), opts)
  }
}
