import './buffer-global'
import WDK from '@tetherto/wdk'
import WalletManagerBtc, { type BtcWalletConfig } from '@tetherto/wdk-wallet-btc'

/** Key the BTC wallet is registered under in WDK. */
const CHAIN = 'bitcoin'

// The onboarding only derives keys: every network call fails on purpose, so no
// seed-derived address ever reaches a public Electrum server. The MwM backend owns
// the on-chain wallet once the mnemonic is submitted.
const offline = () => Promise.reject(new Error('Tether WDK runs offline here: the MwM backend owns the wallet'))
const OFFLINE_CLIENT: NonNullable<BtcWalletConfig['client']> = {
  connect: async () => {},
  close: async () => {},
  reconnect: async () => {},
  getBalance: offline,
  listUnspent: offline,
  getHistory: offline,
  getBlockHeight: offline,
  getTransaction: offline,
  broadcast: offline,
  estimateFee: offline,
}

// wdk-wallet-btc beta.17 types getAccount without the core's newer signer overload;
// the runtime contract is the same (checked in the M3.1 spike), so the cast stays here.
const BtcWalletManager = WalletManagerBtc as unknown as Parameters<WDK['registerWallet']>[1]
const BTC_CONFIG: BtcWalletConfig = { network: 'regtest', bip: 84, client: OFFLINE_CLIENT }

/** Lowercase, single-spaced words: the form BIP-39 validation expects. */
export function normalizeSeed(seed: string): string {
  return seed.trim().toLowerCase().split(/\s+/).join(' ')
}

/** A new random 12-word BIP-39 recovery phrase. */
export function generateSeed(): string {
  return WDK.getRandomSeedPhrase(12)
}

export function validateSeed(seed: string): boolean {
  return WDK.isValidSeed(normalizeSeed(seed))
}

/** BIP-84 regtest address of account 0 (m/84'/1'/0'/0/0), derived locally by WDK. */
export async function deriveAddress(seed: string): Promise<string> {
  const wdk = new WDK(normalizeSeed(seed)).registerWallet(CHAIN, BtcWalletManager, BTC_CONFIG)
  try {
    const account = await wdk.getAccount(CHAIN, 0)
    return await account.getAddress()
  } finally {
    // Erases the private-key material WDK keeps for the account.
    wdk.dispose()
  }
}
