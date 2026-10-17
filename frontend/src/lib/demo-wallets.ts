/**
 * Seeded demo wallets. Ids are proposed to the backend and pending
 * confirmation (STATUS, 11:06). Replaced by useWallets() once the API
 * client lands (M1.4).
 */
export const DEMO_WALLETS = [
  { id: 'wallet_a', label: 'Wallet A' },
  { id: 'wallet_b', label: 'Wallet B' },
  { id: 'wallet_sybil', label: 'Sybil' },
] as const

export type DemoWalletId = (typeof DEMO_WALLETS)[number]['id']
