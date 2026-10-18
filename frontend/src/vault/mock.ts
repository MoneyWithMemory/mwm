import { ApiError, type RequestOptions } from '@/api/client'
import { call, MOVE_LATENCY_MS } from '@/api/mock/MockApiClient'
import { connectMockVault, invoicePayee, mockEngine, receiveFromVault } from '@/api/mock/engine'
import { ASSET_LIST, randomHex } from '@/api/mock/seed'
import { sha256HexSync } from '@/api/mock/sha256'
import type { AssetId, AssetRef, TransferResult, WalletId } from '@/api/types'
import type { VaultClient } from '@/vault/client'
import { DEMO_POLICY, FOREIGN_INVOICE_MESSAGE, policyIssue, policyMessage } from '@/vault/policy'
import { MIN_PASSWORD_LENGTH, VAULT_ERROR_CODES as CODES, type CreateVaultRequest, type VaultPolicy, type VaultSendRequest, type VaultState } from '@/vault/types'

/** BTC the regtest faucet gives a new Vault for its fees, and what one send costs. */
const FUNDING_SATS = 100_000
const FEE_SATS = 1_000
/** Creating funds the Vault and prepares its outputs. */
const CREATE_LATENCY_MS = 1_200

interface MockVault {
  passwordHash: string
  unlocked: boolean
  address: string
  btcSats: number
  balances: Record<AssetId, number>
  /** What the Vault sent today, by ticker; `day` is the date it counts for. */
  usedToday: Record<string, number>
  day: string
  /** Invoices it issued for its wallet's move_to_vault, until they are paid. */
  invoices: Map<string, { assetId: AssetId; amount: number }>
  /** The invoice its own moveToWallet obtained from its wallet, until paid: the only one the policy pays. */
  ownInvoices: Set<string>
}

const vaults = new Map<WalletId, MockVault>()

const badRequest = (code: string, message: string) => new ApiError(code, message, 400)
const conflict = (code: string, message: string) => new ApiError(code, message, 409)
const denied = (message: string) => new ApiError(CODES.policyDenied, message, 403)

const today = () => new Date().toISOString().slice(0, 10)

function policyOf(vault: MockVault | undefined): VaultPolicy {
  const fresh = vault?.day === today()
  return { ...DEMO_POLICY, used_today: Object.fromEntries(DEMO_POLICY.assets.map((t) => [t, fresh ? (vault.usedToday[t] ?? 0) : 0])) }
}

function stateOf(walletId: WalletId): VaultState {
  const vault = vaults.get(walletId)
  const closed = { wallet_id: walletId, exists: vault !== undefined, unlocked: false, address: null, btc_sats: null, assets: [], policy: policyOf(vault) }
  if (!vault?.unlocked) return closed
  return {
    ...closed,
    unlocked: true,
    address: vault.address,
    btc_sats: vault.btcSats,
    assets: ASSET_LIST.filter((a) => (vault.balances[a.asset_id] ?? 0) > 0).map((a) => ({
      asset_id: a.asset_id,
      ticker: a.ticker,
      amount: vault.balances[a.asset_id],
      pending: 0,
    })),
  }
}

function vaultOrThrow(walletId: WalletId): MockVault {
  const vault = vaults.get(walletId)
  if (!vault) throw new ApiError(CODES.missing, 'You have no Vault yet. Create it first.', 404)
  return vault
}

function unlockedOrThrow(walletId: WalletId): MockVault {
  const vault = vaultOrThrow(walletId)
  if (!vault.unlocked) throw conflict(CODES.locked, 'The Vault is locked. Unlock it and try again.')
  return vault
}

/** A taproot-looking regtest address from the phrase's hash: the phrase itself is never kept. */
function addressFrom(digest: string): string {
  const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
  return 'bcrt1p' + Array.from({ length: 58 }, (_, i) => charset[parseInt(digest.slice(i % 62, (i % 62) + 2), 16) % 32]).join('')
}

/** The WDK policy check, then the balance: the same order as the Vault service. */
function checkSend(vault: MockVault, asset: AssetRef, amount: number): void {
  const policy = policyOf(vault)
  const issue = policyIssue(policy, asset.ticker, amount)
  if (issue) throw denied(policyMessage(issue, policy, asset.ticker, (n) => `${n.toLocaleString('en-US')} ${asset.ticker}`))
  if ((vault.balances[asset.asset_id] ?? 0) < amount) throw conflict(CODES.insufficientFunds, `Your Vault does not hold ${amount.toLocaleString('en-US')} ${asset.ticker}.`)
}

/** Pays one of this Vault's own wallet's invoices (checked by the caller). */
function pay(vault: MockVault, invoice: string, asset: AssetRef, amount: number): TransferResult {
  checkSend(vault, asset, amount)
  const txid = randomHex(32)
  receiveFromVault(invoice, txid)
  if (vault.day !== today()) vault.usedToday = {}
  vault.day = today()
  vault.balances[asset.asset_id] -= amount
  vault.usedToday[asset.ticker] = (vault.usedToday[asset.ticker] ?? 0) + amount
  vault.btcSats -= FEE_SATS
  return { txid, asset_id: asset.asset_id, amount }
}

/** The mock Vault service, synchronous: MockVaultClient adds the latency and the copies. */
export const mockVault = {
  get: stateOf,

  /** Keeps a hash of the password and nothing readable of the phrase. */
  create(walletId: WalletId, body: CreateVaultRequest): VaultState {
    if (vaults.has(walletId)) throw conflict(CODES.exists, 'This wallet already has a Vault.')
    const words = body.mnemonic.trim().toLowerCase().split(/\s+/)
    if (words.length !== 12 && words.length !== 24) throw badRequest(CODES.invalidMnemonic, 'Not a valid recovery phrase.')
    if (body.password.length < MIN_PASSWORD_LENGTH) throw badRequest(CODES.weakPassword, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
    vaults.set(walletId, {
      passwordHash: sha256HexSync(body.password),
      unlocked: true,
      address: addressFrom(sha256HexSync(words.join(' '))),
      btcSats: FUNDING_SATS,
      balances: {},
      usedToday: {},
      day: today(),
      invoices: new Map(),
      ownInvoices: new Set(),
    })
    return stateOf(walletId)
  },

  unlock(walletId: WalletId, password: string): VaultState {
    const vault = vaultOrThrow(walletId)
    if (sha256HexSync(password) !== vault.passwordHash) throw new ApiError(CODES.wrongPassword, 'Wrong password.', 401)
    vault.unlocked = true
    return stateOf(walletId)
  },

  lock(walletId: WalletId): VaultState {
    vaultOrThrow(walletId).unlocked = false
    return stateOf(walletId)
  },

  /** Incoming transfers settle as they are paid, so a refresh only reads. */
  refresh(walletId: WalletId): VaultState {
    unlockedOrThrow(walletId)
    return stateOf(walletId)
  },

  /** Vault → Wallet: asks the backend for its own wallet's invoice, then pays it through the policy. */
  moveToWallet(walletId: WalletId, assetId: AssetId, amount: number): TransferResult {
    const { vault } = checkMove(walletId, assetId, amount)
    const { invoice } = mockEngine.receiveInvoice(walletId, { asset_id: assetId, amount })
    vault.ownInvoices.add(invoice)
    try {
      return send(walletId, { invoice })
    } finally {
      vault.ownInvoices.delete(invoice)
    }
  },

  send,
}

/** Vault → Wallet before the invoice exists: the policy's dry run, then the balance. */
function checkMove(walletId: WalletId, assetId: AssetId, amount: number): { vault: MockVault; asset: AssetRef } {
  const vault = unlockedOrThrow(walletId)
  const asset = ASSET_LIST.find((a) => a.asset_id === assetId && a.schema !== 'BTC')
  if (!asset) throw denied(policyMessage('asset', policyOf(vault), assetId, String))
  if (!Number.isInteger(amount) || amount <= 0) throw badRequest('invalid_request', 'Enter a whole amount greater than 0.')
  checkSend(vault, asset, amount)
  return { vault, asset }
}

/** Any invoice: the policy lets through only the one its moveToWallet obtained from its own wallet. */
function send(walletId: WalletId, body: VaultSendRequest): TransferResult {
  const { vault, payee } = authorize(walletId, body)
  return pay(vault, body.invoice.trim(), payee.asset, payee.amount)
}

/** The policy's verdict on an invoice before anything is paid: the invoice's payee, or the refusal. */
function authorize(walletId: WalletId, { invoice, asset_id: chosen }: VaultSendRequest) {
  const vault = unlockedOrThrow(walletId)
  const text = invoice.trim()
  const payee = invoicePayee(text)
  if (!payee && !text.startsWith('rgb:')) throw badRequest(CODES.invalidInvoice, 'This invoice cannot be read.')
  // Like the service: an invoice from a wallet that never held the asset names none ("rgb:~/…").
  if (!payee && text.startsWith('rgb:~/') && !chosen) {
    throw badRequest(CODES.invalidInvoice, 'This invoice does not say which asset to pay: choose one.')
  }
  if (payee && chosen && payee.asset.asset_id !== chosen) throw badRequest(CODES.invalidInvoice, 'This invoice asks for another asset.')
  // Like the service's own-wallet rule: an invoice pasted here is refused, even one the wallet issued.
  if (!payee || !vault.ownInvoices.has(text)) throw denied(FOREIGN_INVOICE_MESSAGE)
  checkSend(vault, payee.asset, payee.amount)
  return { vault, payee }
}

// The backend's move_to_vault reaches this Vault for its invoice, as it reaches VAULT_URL.
connectMockVault({
  ready(walletId) {
    unlockedOrThrow(walletId)
  },
  invoice(walletId, assetId, amount) {
    const vault = unlockedOrThrow(walletId)
    const invoice = `rgb:${assetId.slice(4)}/RGB20/${amount}+bcrt:utxob:${randomHex(16)}?endpoints=rpc://127.0.0.1:3000/json-rpc`
    vault.invoices.set(invoice, { assetId, amount })
    return invoice
  },
  receive(invoice) {
    for (const vault of vaults.values()) {
      const expected = vault.invoices.get(invoice)
      if (!expected) continue
      vault.invoices.delete(invoice)
      vault.balances[expected.assetId] = (vault.balances[expected.assetId] ?? 0) + expected.amount
      return
    }
  },
})

/** In-browser Vault for API_MODE "mock": one per wallet id, moving balances with the mock backend. */
export class MockVaultClient implements VaultClient {
  get(walletId: WalletId, opts?: RequestOptions) {
    return call(() => mockVault.get(walletId), opts)
  }

  create(walletId: WalletId, body: CreateVaultRequest, opts?: RequestOptions) {
    return call(() => mockVault.create(walletId, body), opts, CREATE_LATENCY_MS)
  }

  unlock(walletId: WalletId, password: string, opts?: RequestOptions) {
    return call(() => mockVault.unlock(walletId, password), opts)
  }

  lock(walletId: WalletId, opts?: RequestOptions) {
    return call(() => mockVault.lock(walletId), opts)
  }

  refresh(walletId: WalletId, opts?: RequestOptions) {
    return call(() => mockVault.refresh(walletId), opts)
  }

  /** A refusal comes back at once; only a move the policy allows waits for the chain. */
  async moveToWallet(walletId: WalletId, assetId: AssetId, amount: number, opts?: RequestOptions) {
    await call(() => void checkMove(walletId, assetId, amount), opts)
    return call(() => mockVault.moveToWallet(walletId, assetId, amount), opts, MOVE_LATENCY_MS)
  }

  /** A refusal comes back at once; only a payment the policy allows waits for the chain. */
  async send(walletId: WalletId, body: VaultSendRequest, opts?: RequestOptions) {
    await call(() => void authorize(walletId, body), opts)
    return call(() => mockVault.send(walletId, body), opts, MOVE_LATENCY_MS)
  }
}
