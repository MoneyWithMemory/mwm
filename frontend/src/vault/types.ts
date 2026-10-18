import type { AssetId, WalletId } from '@/api/types'

/**
 * Vault service contract (vault/, proxied at same-origin /vault). Self-custodial with Tether WDK:
 * its own recovery phrase, encrypted with the user's password; the backend and the agents never
 * see the phrase, the balances or the moves. Amounts are atomic units, like the backend's.
 */

export interface VaultAsset {
  asset_id: AssetId
  ticker: string
  /** Spendable. */
  amount: number
  /** Incoming, not settled yet. */
  pending: number
}

/** Enforced by the Vault's Tether WDK policy on every send. Keyed by ticker. */
export interface VaultPolicy {
  assets: string[]
  max_per_move: Record<string, number>
  max_per_day: Record<string, number>
  used_today: Record<string, number>
}

/** GET /vault/{wallet_id}: one Vault per wallet id. */
export interface VaultState {
  wallet_id: WalletId
  exists: boolean
  unlocked: boolean
  /** null when missing or locked. */
  address: string | null
  /** BTC that pays the Vault's fees; null when locked. */
  btc_sats: number | null
  /** [] when missing or locked. */
  assets: VaultAsset[]
  policy: VaultPolicy
}

/** POST /vault/{wallet_id}/create. The phrase comes from Tether WDK in the browser. */
export interface CreateVaultRequest {
  mnemonic: string
  password: string
}

/** POST /vault/{wallet_id}/unlock */
export interface UnlockVaultRequest {
  password: string
}

/** POST /vault/{wallet_id}/send: the policy refuses any invoice not issued by the Vault's own wallet. */
export interface VaultSendRequest {
  invoice: string
  /** Only for an invoice that names no asset (its wallet never held it): the service asks for it. */
  asset_id?: AssetId
}

/** Error codes of the Vault service, plus the backend's for its move_to_vault. */
export const VAULT_ERROR_CODES = {
  exists: 'vault_exists',
  invalidMnemonic: 'invalid_mnemonic',
  weakPassword: 'weak_password',
  wrongPassword: 'wrong_password',
  missing: 'vault_missing',
  locked: 'vault_locked',
  policyDenied: 'policy_denied',
  unavailable: 'vault_unavailable',
  insufficientFunds: 'insufficient_funds',
  invalidInvoice: 'invalid_invoice',
} as const

/** Shortest password the Vault accepts (400 weak_password below it). */
export const MIN_PASSWORD_LENGTH = 8
