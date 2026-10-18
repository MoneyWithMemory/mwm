import type { AgentProfile } from '@/api/types'
import { formatAssetAmount } from '@/lib/format'
import { policyIssue, policyMessage, sendableAmount } from '@/vault/policy'
import type { VaultPolicy } from '@/vault/types'

/** The two parts of one account: the AI wallet (agents trade with it) and its own Vault. */
export type MoveDirection = 'to_vault' | 'to_wallet'

/** One asset as the Move sheet sees it: its balance on both sides, atomic units. */
export interface MoveAsset {
  ticker: string
  precision: number
  wallet: number
  vault: number
  /** What the wallet's active Seller Desk lists: it stays in the wallet (the backend refuses to move it). */
  listed?: number
}

/** The lot the active Seller Desk lists of `assetId`; 0 while the desk is paused or sells another asset. */
export function deskLot(profile: Pick<AgentProfile, 'seller_active' | 'offered_asset_id' | 'offered_amount'>, assetId: string): number {
  return profile.seller_active && profile.offered_asset_id === assetId ? profile.offered_amount : 0
}

/** What can leave the source of `direction`: the wallet's balance beyond the desk's lot, or what the Vault's policy lets it send. */
export function maxMovable(direction: MoveDirection, asset: MoveAsset, policy: VaultPolicy): number {
  return direction === 'to_vault' ? Math.max(0, asset.wallet - (asset.listed ?? 0)) : sendableAmount(policy, asset.ticker, asset.vault)
}

const DECIMAL = /^\d+(\.\d*)?$|^\.\d+$/

/** "1,250.5" in display units → atomic units; null unless it is a plain number within the asset's precision. */
export function parseAmount(text: string, precision: number): number | null {
  const value = text.trim().replace(/,/g, '')
  if (!DECIMAL.test(value)) return null
  const decimals = value.split('.')[1] ?? ''
  if (decimals.replace(/0+$/, '').length > precision) return null
  return Math.round(Number(value) * 10 ** precision)
}

/** Why `amount` (atomic units, null if unreadable) cannot move, in plain words; null when it can. */
export function moveIssue(direction: MoveDirection, asset: MoveAsset, amount: number | null, policy: VaultPolicy): string | null {
  if (amount === null || amount <= 0) {
    return asset.precision === 0 ? 'Enter a whole amount greater than 0.' : 'Enter an amount greater than 0.'
  }
  const toVault = direction === 'to_vault'
  const format = (n: number) => formatAssetAmount(n, asset.precision, asset.ticker)
  if (amount > (toVault ? asset.wallet : asset.vault)) return `Not enough ${asset.ticker} in your ${toVault ? 'Wallet' : 'Vault'}.`
  // The backend's own sentence: the Seller Desk's lot stays where the agents can sell it.
  const listed = asset.listed ?? 0
  if (toVault && asset.wallet - amount < listed) return `${format(listed)} are listed on your Seller Desk. Lower the lot or pause the desk first.`
  // The policy governs only what the Vault sends.
  const issue = toVault ? null : policyIssue(policy, asset.ticker, amount)
  return issue && policyMessage(issue, policy, asset.ticker, format)
}
