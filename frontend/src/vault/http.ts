import type { RequestOptions } from '@/api/client'
import { MOVE_TIMEOUT_MS, requestJson, type JsonRequestOptions, type Method } from '@/api/http'
import type { AssetAmountRequest, AssetId, TransferResult, WalletId } from '@/api/types'
import type { VaultClient } from './client'
import type { CreateVaultRequest, UnlockVaultRequest, VaultSendRequest, VaultState } from './types'

/** A refresh settles incoming transfers on Bitcoin regtest: slower than a read. */
const REFRESH_TIMEOUT_MS = 30_000

const enc = encodeURIComponent

/** Talks to the Vault service through the same-origin /vault proxy (see vite.config.ts). */
export class HttpVaultClient implements VaultClient {
  private readonly base: string

  constructor(base = '/vault') {
    this.base = base
  }

  private request<T>(method: Method, walletId: WalletId, action: string, opts: JsonRequestOptions = {}): Promise<T> {
    return requestJson<T>(this.base, method, `/${enc(walletId)}${action}`, opts)
  }

  get(walletId: WalletId, opts?: RequestOptions) {
    return this.request<VaultState>('GET', walletId, '', opts)
  }

  /** Creating funds the Vault's fees on regtest and prepares its outputs, so it can take a while. */
  create(walletId: WalletId, body: CreateVaultRequest, opts?: RequestOptions) {
    return this.request<VaultState>('POST', walletId, '/create', { ...opts, body, timeoutMs: MOVE_TIMEOUT_MS })
  }

  unlock(walletId: WalletId, password: string, opts?: RequestOptions) {
    const body: UnlockVaultRequest = { password }
    return this.request<VaultState>('POST', walletId, '/unlock', { ...opts, body })
  }

  lock(walletId: WalletId, opts?: RequestOptions) {
    return this.request<VaultState>('POST', walletId, '/lock', opts)
  }

  refresh(walletId: WalletId, opts?: RequestOptions) {
    return this.request<VaultState>('POST', walletId, '/refresh', { ...opts, timeoutMs: REFRESH_TIMEOUT_MS })
  }

  moveToWallet(walletId: WalletId, assetId: AssetId, amount: number, opts?: RequestOptions) {
    const body: AssetAmountRequest = { asset_id: assetId, amount }
    return this.request<TransferResult>('POST', walletId, '/move_to_wallet', { ...opts, body, timeoutMs: MOVE_TIMEOUT_MS })
  }

  send(walletId: WalletId, body: VaultSendRequest, opts?: RequestOptions) {
    return this.request<TransferResult>('POST', walletId, '/send', { ...opts, body, timeoutMs: MOVE_TIMEOUT_MS })
  }
}
