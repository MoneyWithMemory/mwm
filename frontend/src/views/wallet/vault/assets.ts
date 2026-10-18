import type { AssetBalance, Market } from '@/api'
import type { MoveAsset, VaultState } from '@/vault'

/** One of the Vault's assets with its balance on both sides of the account (atomic units). */
export interface PartAsset extends MoveAsset {
  asset_id: string
  /** Arriving in the Vault, not settled yet. */
  pending: number
}

/**
 * The assets the Vault may hold (its policy's, USDT and PEPE, in that order), each with the
 * wallet's and the Vault's balance, 0 when empty. Ids and precision come from the wallet and the
 * market, so the rows exist before anything was moved.
 */
export function partAssets(vault: VaultState, walletAssets: AssetBalance[], market: Market | undefined): PartAsset[] {
  return vault.policy.assets.flatMap((ticker) => {
    const held = vault.assets.find((a) => a.ticker === ticker)
    const known = walletAssets.find((a) => a.ticker === ticker) ?? market?.assets.find((a) => a.ticker === ticker)
    const assetId = held?.asset_id ?? known?.asset_id
    if (!assetId) return []
    return [
      {
        asset_id: assetId,
        ticker,
        precision: known?.precision ?? 0,
        wallet: walletAssets.find((a) => a.asset_id === assetId)?.amount ?? 0,
        vault: held?.amount ?? 0,
        pending: held?.pending ?? 0,
      },
    ]
  })
}

/** USD value of what the Vault holds; assets without a price count as 0, like the wallet's total. */
export function vaultValueUsd(assets: PartAsset[], market: Market): number {
  return assets.reduce((sum, asset) => {
    const price = market.assets.find((p) => p.asset_id === asset.asset_id)?.price_usd ?? 0
    return sum + (asset.vault / 10 ** asset.precision) * price
  }, 0)
}
