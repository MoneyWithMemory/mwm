import type { RequestOptions } from '@/api/client'
import type { AssetId, TransferResult, WalletId } from '@/api/types'
import type { CreateVaultRequest, VaultSendRequest, VaultState } from './types'

/** One method per Vault endpoint the browser calls. Implemented by HttpVaultClient and the mock. */
export interface VaultClient {
  get(walletId: WalletId, opts?: RequestOptions): Promise<VaultState>
  create(walletId: WalletId, body: CreateVaultRequest, opts?: RequestOptions): Promise<VaultState>
  unlock(walletId: WalletId, password: string, opts?: RequestOptions): Promise<VaultState>
  lock(walletId: WalletId, opts?: RequestOptions): Promise<VaultState>
  /** Settles incoming transfers. */
  refresh(walletId: WalletId, opts?: RequestOptions): Promise<VaultState>
  /** Vault → Wallet: the Vault asks the backend for its own wallet's invoice and pays it. */
  moveToWallet(walletId: WalletId, assetId: AssetId, amount: number, opts?: RequestOptions): Promise<TransferResult>
  send(walletId: WalletId, body: VaultSendRequest, opts?: RequestOptions): Promise<TransferResult>
}
