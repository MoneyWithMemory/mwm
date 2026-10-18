// One Vault per AI wallet id: a self-custodial RGB wallet built with Tether WDK and UTEXO's wdk-wallet-rgb.
// The backend and the agents never see its recovery phrase; every outbound move goes through the WDK
// policy-governed account (see policy.js).
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import * as bip39 from 'bip39'
import WDK, { PolicyViolationError } from '@tetherto/wdk'
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import { openSecret, sealSecret, WrongPasswordError } from './crypto.js'
import { invalidRequest, VaultError } from './errors.js'
import { Mutex } from './mutex.js'
import { denialMessage, OWN_WALLET_RULE, PolicyLedger, RGB_WALLET, vaultPolicies } from './policy.js'

const rgblib = createRequire(import.meta.url)('@utexo/rgb-lib')

const WALLET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
const MIN_PASSWORD = 8
// Password guessing: after this many wrong passwords in a row, a Vault does not unlock for a pause.
const MAX_WRONG_PASSWORDS = 5
const UNLOCK_PAUSE_MS = 60_000
const FEE_RATE = 1
const INVOICE_TTL_S = 3600
// Demo-only (regtest): BTC for fees, held in colorable UTXOs so a receive never waits for one.
const FUND_BTC = '0.01'
const MIN_FEE_SATS = 100_000
const UTXO_TARGET = 5
const UTXO_SIZE_SATS = 10_000

const validateAsset = (assetId) => {
  if (typeof assetId !== 'string' || !assetId.startsWith('rgb:') || assetId.length > 200) throw invalidRequest('Choose an asset.')
}

const validateAmount = (amount) => {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw invalidRequest('The amount must be a whole number above zero.')
}

// Offline parse of an RGB invoice (no keys, no network): what it asks for, or null if it is not an invoice.
export function decodeInvoice (invoice) {
  let parsed
  try {
    parsed = new rgblib.Invoice(invoice)
  } catch {
    return null
  }
  try {
    const data = parsed.invoiceData()
    return { assetId: data.assetId ?? null, amount: data.assignment?.Fungible ?? null }
  } finally {
    parsed.drop()
  }
}

const insufficientFunds = () =>
  new VaultError(409, 'insufficient_funds', 'Your Vault does not hold that much yet. Incoming moves count once settled.')

function transferError (err) {
  const message = String(err?.message)
  if (/Insufficient(Spendable|Total)Assets|InsufficientAllocationSlots/.test(message)) return insufficientFunds()
  if (/InsufficientBitcoins/.test(message)) {
    return new VaultError(409, 'insufficient_fees', 'Your Vault needs a little bitcoin for fees.')
  }
  if (/Invoice|Recipient/.test(message)) return new VaultError(400, 'invalid_invoice', 'This invoice cannot be paid.')
  return new VaultError(502, 'transfer_failed', 'The move could not be completed. Try again in a moment.')
}

function writeFileAtomic (file, data) {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

// A WDK instance holding the RGB wallet, and its account governed by `policies`. `seed` is the BIP-39 seed
// (bytes, not the phrase): WDK hands that same buffer down to rgb-sdk, which zeroes it when wdk.dispose() runs.
export async function openGovernedAccount ({ seed, WalletManager, walletConfig, policies }) {
  const wdk = new WDK(seed)
  wdk.registerWallet(RGB_WALLET, WalletManager, walletConfig)
  // Upstream quirk: WalletManagerRgb.dispose wipes the xpriv before the base class derives the lazy keyPair
  // it zeroes, so dispose would throw and leave the seed in memory. Reading it here (middlewares see the raw
  // account) caches it.
  wdk.registerMiddleware(RGB_WALLET, async (account) => account.keyPair)
  wdk.registerPolicy(policies)
  try {
    // Policies apply to accounts fetched after registerPolicy: this is the governed proxy.
    const account = await wdk.getAccount(RGB_WALLET, 0)
    return { wdk, account, address: await account.getAddress() }
  } catch (err) {
    wdk.dispose()
    throw err
  }
}

export class VaultService {
  #config
  #WalletManager
  #regtest
  #backend
  #log
  #now
  #vaults = new Map()

  constructor ({ config, WalletManager = WalletManagerRgb, regtest, backend, log, now = Date.now }) {
    this.#config = config
    this.#WalletManager = WalletManager
    this.#regtest = regtest
    this.#backend = backend
    this.#log = log
    this.#now = now
  }

  async state (walletId) {
    const vault = this.#vault(walletId)
    return vault.mutex.run(() => this.#state(vault))
  }

  async create (walletId, { mnemonic, password } = {}) {
    const vault = this.#vault(walletId)
    if (typeof mnemonic !== 'string' || typeof password !== 'string') throw invalidRequest('Send a recovery phrase and a password.')
    const phrase = mnemonic.trim().toLowerCase().split(/\s+/).join(' ')
    if (!WDK.isValidSeed(phrase)) throw new VaultError(400, 'invalid_mnemonic', 'This recovery phrase is not valid.')
    if (password.length < MIN_PASSWORD) {
      throw new VaultError(400, 'weak_password', `Use a password of at least ${MIN_PASSWORD} characters.`)
    }
    return vault.mutex.run(async () => {
      if (this.#exists(vault)) throw new VaultError(409, 'vault_exists', 'This wallet already has a Vault.')
      const { dir, seedFile } = vault.paths
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      // Its own memory, not Node's shared pool for small buffers, zeroed once sealed.
      const secret = Buffer.alloc(Buffer.byteLength(phrase))
      secret.write(phrase)
      try {
        writeFileAtomic(seedFile, JSON.stringify(await sealSecret(secret, password, walletId)))
        vault.session = await this.#open(vault, bip39.mnemonicToSeedSync(phrase))
      } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true })
        throw err
      } finally {
        secret.fill(0)
      }
      this.#log.info(`${walletId}: Vault created`)
      try {
        await this.#topUpUtxos(vault.session)
      } catch (err) {
        this.#log.warn(`${walletId}: no fee funding yet (${err.message}); the next receive retries`)
      }
      return this.#state(vault)
    })
  }

  async unlock (walletId, { password } = {}) {
    const vault = this.#vault(walletId)
    if (typeof password !== 'string') throw invalidRequest('Send your password.')
    return vault.mutex.run(async () => {
      if (!this.#exists(vault)) throw new VaultError(404, 'vault_missing', 'This wallet has no Vault yet.')
      // While paused, not even the right password is tried: a guesser learns nothing.
      if (this.#now() < vault.unlockPausedUntil) {
        throw new VaultError(429, 'too_many_attempts', 'Too many wrong passwords. Wait a minute and try again.')
      }
      let secret
      try {
        secret = await openSecret(JSON.parse(fs.readFileSync(vault.paths.seedFile, 'utf8')), password, walletId)
      } catch (err) {
        if (err instanceof WrongPasswordError) {
          vault.wrongPasswords += 1
          if (vault.wrongPasswords >= MAX_WRONG_PASSWORDS) {
            vault.wrongPasswords = 0
            vault.unlockPausedUntil = this.#now() + UNLOCK_PAUSE_MS
          }
          throw new VaultError(401, 'wrong_password', 'Wrong password.')
        }
        throw err
      }
      vault.wrongPasswords = 0
      try {
        vault.session ??= await this.#open(vault, bip39.mnemonicToSeedSync(secret.toString('utf8')))
      } finally {
        secret.fill(0)
      }
      return this.#state(vault)
    })
  }

  async lock (walletId) {
    const vault = this.#vault(walletId)
    return vault.mutex.run(() => {
      this.#close(vault)
      return this.#state(vault)
    })
  }

  // Receive only: the backend asks for this when the AI wallet moves funds into the Vault.
  async invoice (walletId, { asset_id: assetId, amount } = {}) {
    const vault = this.#vault(walletId)
    validateAsset(assetId)
    validateAmount(amount)
    return vault.mutex.run(async () => {
      const session = this.#unlocked(vault)
      await this.#ensureFreeUtxo(session)
      const held = (await this.#listAssets(vault, session)).some((asset) => asset.assetId === assetId)
      // rgb-lib refuses an invoice bound to an asset the wallet never held, so the first one names no asset.
      const receive = await session.account.receiveAsset({
        assetId: held ? assetId : undefined,
        amount,
        minConfirmations: 1,
        durationSeconds: INVOICE_TTL_S
      })
      return { invoice: receive.invoice, recipient_id: receive.recipientId }
    })
  }

  async refresh (walletId) {
    const vault = this.#vault(walletId)
    return vault.mutex.run(async () => {
      const session = this.#unlocked(vault)
      // An incoming transfer needs two passes: the first validates and acknowledges the consignment,
      // the second settles it once its transaction is confirmed.
      for (let pass = 0; pass < 2; pass++) {
        try {
          await session.account.refreshWallet()
        } catch (err) {
          this.#log.warn(`${walletId}: refresh failed (${err.message})`)
          throw new VaultError(503, 'network_unavailable', 'The Bitcoin test network is not reachable right now. Try again in a moment.')
        }
      }
      return this.#state(vault)
    })
  }

  // Vault -> Wallet: the invoice comes from the Vault's own AI wallet, which is what the policy allows.
  async moveToWallet (walletId, { asset_id: assetId, amount } = {}) {
    const vault = this.#vault(walletId)
    validateAsset(assetId)
    validateAmount(amount)
    return vault.mutex.run(async () => {
      const session = this.#unlocked(vault)
      const asset = (await this.#listAssets(vault, session)).find((held) => held.assetId === assetId)
      if (!asset) throw insufficientFunds()
      // Dry run of the governed transfer before asking the wallet for an invoice: every rule must already
      // pass except own-wallet-only, which needs that invoice.
      const dryRun = await session.account.simulate.transfer({ token: assetId, recipient: null, amount })
      if (dryRun.decision === 'DENY' && dryRun.matched_rule !== OWN_WALLET_RULE) {
        throw this.#denied(vault, { ruleName: dryRun.matched_rule, reason: dryRun.reason, code: dryRun.code })
      }
      if (asset.balance.spendable < amount) throw insufficientFunds()
      const { invoice } = await this.#backend.receiveInvoice(walletId, assetId, amount) ?? {}
      const asked = typeof invoice === 'string' ? decodeInvoice(invoice) : null
      if (!asked || (asked.assetId !== null && asked.assetId !== assetId) || (asked.amount !== null && asked.amount !== amount)) {
        throw new VaultError(502, 'backend_error', 'Your wallet returned an invoice that does not match this move.')
      }
      vault.ledger.recordOwnInvoice({ invoice, assetId, amount })
      return this.#pay(vault, session, { assetId, amount, invoice })
    })
  }

  // Any invoice, through the same policy: it pays only an invoice move_to_wallet asked the Vault's own wallet
  // for, so a pasted one is refused, even one made by that wallet. `asset_id` is needed only for an invoice
  // that names no asset (a wallet's first receive of it).
  async send (walletId, { invoice, asset_id: chosenAsset } = {}) {
    const vault = this.#vault(walletId)
    if (typeof invoice !== 'string' || !invoice.trim()) throw invalidRequest('Paste an invoice to pay.')
    if (chosenAsset !== undefined) validateAsset(chosenAsset)
    const recipient = invoice.trim()
    const asked = decodeInvoice(recipient)
    if (!asked) throw new VaultError(400, 'invalid_invoice', 'This invoice cannot be read.')
    if (asked.assetId && chosenAsset && asked.assetId !== chosenAsset) {
      throw new VaultError(400, 'invalid_invoice', 'This invoice asks for another asset.')
    }
    const assetId = asked.assetId ?? chosenAsset
    if (!assetId) throw new VaultError(400, 'invalid_invoice', 'This invoice does not say which asset to pay: choose one.')
    if (!Number.isSafeInteger(asked.amount) || asked.amount <= 0) {
      throw new VaultError(400, 'invalid_invoice', 'This invoice does not say how much to pay.')
    }
    return vault.mutex.run(async () => {
      const session = this.#unlocked(vault)
      await this.#listAssets(vault, session)
      return this.#pay(vault, session, { assetId, amount: asked.amount, invoice: recipient })
    })
  }

  closeAll () {
    for (const vault of this.#vaults.values()) this.#close(vault)
  }

  #vault (walletId) {
    if (typeof walletId !== 'string' || !WALLET_ID_RE.test(walletId)) throw invalidRequest('This wallet id is not valid.')
    let vault = this.#vaults.get(walletId)
    if (!vault) {
      const dir = path.join(this.#config.vaultDir, walletId)
      const paths = { dir, seedFile: path.join(dir, 'seed.enc'), dataDir: path.join(dir, 'rgb'), ledgerFile: path.join(dir, 'policy.json') }
      vault = {
        walletId,
        paths,
        mutex: new Mutex(),
        ledger: new PolicyLedger({ file: paths.ledgerFile }),
        session: null,
        wrongPasswords: 0,
        unlockPausedUntil: 0
      }
      this.#vaults.set(walletId, vault)
    }
    return vault
  }

  #exists (vault) {
    return fs.existsSync(vault.paths.seedFile)
  }

  #unlocked (vault) {
    if (!this.#exists(vault)) throw new VaultError(404, 'vault_missing', 'This wallet has no Vault yet.')
    if (!vault.session) throw new VaultError(409, 'vault_locked', 'Unlock your Vault first.')
    return vault.session
  }

  // The session (WDK instance and governed account) lives until lock, which disposes it and wipes the seed.
  #open (vault, seed) {
    return openGovernedAccount({
      seed,
      WalletManager: this.#WalletManager,
      walletConfig: {
        network: this.#config.network,
        indexerUrl: this.#config.indexerUrl,
        transportEndpoint: this.#config.transportEndpoint,
        dataDir: vault.paths.dataDir
      },
      policies: vaultPolicies(vault.ledger)
    })
  }

  #close (vault) {
    const { session } = vault
    vault.session = null
    session?.wdk.dispose()
  }

  async #state (vault) {
    const locked = {
      wallet_id: vault.walletId,
      exists: this.#exists(vault),
      unlocked: false,
      address: null,
      btc_sats: null,
      assets: [],
      policy: vault.ledger.snapshot()
    }
    const { session } = vault
    if (!session) return locked
    const assets = (await this.#listAssets(vault, session))
      .map(({ assetId, ticker, balance }) => ({
        asset_id: assetId,
        ticker,
        amount: balance.spendable,
        pending: Math.max(0, balance.future - balance.settled)
      }))
      .filter(({ amount, pending }) => amount > 0 || pending > 0)
    let btcSats = null
    try {
      btcSats = Number(await session.account.getBalance())
    } catch (err) {
      this.#log.warn(`${vault.walletId}: BTC balance unavailable (${err.message})`)
    }
    return { ...locked, unlocked: true, address: session.address, btc_sats: btcSats, assets }
  }

  // The policy reads tickers from the ledger, so every asset list refreshes them.
  async #listAssets (vault, session) {
    const { nia = [] } = await session.account.listAssets()
    vault.ledger.setTickers(nia)
    return nia
  }

  // The one place value leaves the Vault: the WDK policy engine evaluates the call before rgb-lib sees it.
  async #pay (vault, session, { assetId, amount, invoice }) {
    let result
    try {
      result = await session.account.transfer({ token: assetId, recipient: invoice, amount, feeRate: FEE_RATE, minConfirmations: 1 })
    } catch (err) {
      if (err instanceof PolicyViolationError) {
        this.#log.info(`${vault.walletId}: policy denied a transfer (${err.ruleName})`)
        throw this.#denied(vault, err)
      }
      this.#log.warn(`${vault.walletId}: transfer failed (${err.message})`)
      throw transferError(err)
    } finally {
      vault.ledger.forgetInvoice(invoice)
    }
    vault.ledger.recordMove(vault.ledger.tickerOf(assetId), amount)
    this.#log.info(`${vault.walletId}: sent ${amount} ${vault.ledger.tickerOf(assetId)} (${result.hash})`)
    await this.#settleOutgoing(vault, session)
    return { txid: result.hash, asset_id: assetId, amount }
  }

  #denied (vault, verdict) {
    return new VaultError(403, 'policy_denied', denialMessage(verdict, vault.ledger))
  }

  // rgb-sdk sends without donation: the transaction is broadcast once the wallet acknowledged the consignment.
  // Wallet refresh (ack), Vault refresh (broadcast), mine (regtest), wallet refresh and Vault refresh (settle).
  // The move is already committed, so a failing step only leaves it for the next refresh of either side.
  async #settleOutgoing (vault, session) {
    const steps = [
      ['wallet refresh', () => this.#backend.refresh(vault.walletId)],
      ['Vault refresh', () => session.account.refreshWallet()],
      ['mine', () => this.#regtest.mine(1)],
      ['wallet refresh', () => this.#backend.refresh(vault.walletId)],
      ['Vault refresh', () => session.account.refreshWallet()]
    ]
    for (const [label, step] of steps) {
      try {
        await step()
      } catch (err) {
        this.#log.warn(`${vault.walletId}: ${label} after a move failed (${err.message})`)
      }
    }
  }

  async #ensureFreeUtxo (session) {
    const free = (await session.account.listUnspents()).filter(({ utxo, rgbAllocations, pendingBlinded }) =>
      utxo.colorable && utxo.exists && rgbAllocations.length === 0 && pendingBlinded === 0)
    if (free.length === 0) await this.#topUpUtxos(session)
  }

  // Demo-only (regtest): fund fees from the test miner, then create colorable UTXOs and confirm them.
  async #topUpUtxos (session) {
    if (Number(await session.account.getBalance()) < MIN_FEE_SATS) {
      await this.#regtest.fund(session.address, FUND_BTC)
      await this.#regtest.mine(1)
    }
    try {
      await session.account.createUtxos({ upTo: true, num: UTXO_TARGET, size: UTXO_SIZE_SATS, feeRate: FEE_RATE })
    } catch (err) {
      if (/AllocationsAlreadyAvailable/.test(err.message)) return
      throw err
    }
    await this.#regtest.mine(1)
  }
}
