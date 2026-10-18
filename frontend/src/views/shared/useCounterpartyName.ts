import { useWallet, useWallets } from '@/api'
import { shortAddress } from '@/lib/format'

/**
 * How walletId names a counterparty address: its own alias, else the label of a wallet on this
 * device (e.g. "Wallet B"), else the short address. `alias` is what avatars use for initials.
 */
export function useCounterpartyName(walletId: string) {
  const wallet = useWallet(walletId)
  const wallets = useWallets()
  return (address: string): { name: string; alias?: string } => {
    const alias = wallet.data?.local_aliases[address] ?? wallets.data?.find((w) => w.address === address)?.label
    return { name: alias ?? shortAddress(address), alias }
  }
}
