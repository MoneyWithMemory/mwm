// The Vault's Transaction Policies, registered on the WDK instance with wdk.registerPolicy. The WDK policy
// engine wraps the RGB account in a proxy that denies by default: only the calls a rule allows reach rgb-lib.
import fs from 'node:fs'
import { DENIAL_CODES } from '@tetherto/wdk'

export const RGB_WALLET = 'rgb'
export const OWN_WALLET_RULE = 'own-wallet-only'

export const DEFAULT_LIMITS = Object.freeze({
  assets: ['USDT', 'PEPE'],
  max_per_move: { USDT: 5000, PEPE: 1_000_000 },
  max_per_day: { USDT: 10_000, PEPE: 2_000_000 },
  // sat/vB: a move never burns the Vault's bitcoin in fees, whatever rate a caller asks for.
  max_fee_rate: 10
})

// Calls that move no value out of the Vault: reads, receives, refresh, and colorable UTXOs (a send to itself).
// Everything else the RGB account exposes (sendTransaction, sign, signPsbt, sendBegin/sendEnd, getRgbWallet,
// createBackup, issueAssetNia, ...) has no rule, so the engine denies it.
const UPKEEP_OPERATIONS = ['listAssets', 'listUnspents', 'listTransfers', 'receiveAsset', 'refreshWallet', 'createUtxos']

const formatAmount = (n) => n.toLocaleString('en-US')

const pad = (n) => String(n).padStart(2, '0')
const localDay = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`

// What the transfer policy reads besides the call itself: the invoices this Vault obtained from its own
// wallet, today's totals (persisted, so a restart does not reset the daily limit) and asset tickers.
export class PolicyLedger {
  #file
  #limits
  #now
  #day
  #used
  #ownInvoices = new Map()
  #tickers = new Map()

  constructor ({ file = null, limits = DEFAULT_LIMITS, now = () => new Date() } = {}) {
    this.#file = file
    this.#limits = limits
    this.#now = now
    let saved = null
    try {
      saved = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : null
    } catch {}
    this.#day = saved?.day ?? localDay(now())
    this.#used = { ...saved?.used }
  }

  get limits () {
    return this.#limits
  }

  usedToday (ticker) {
    const today = localDay(this.#now())
    if (today !== this.#day) {
      this.#day = today
      this.#used = {}
    }
    return this.#used[ticker] ?? 0
  }

  remainingToday (ticker) {
    return Math.max(0, (this.#limits.max_per_day[ticker] ?? 0) - this.usedToday(ticker))
  }

  recordMove (ticker, amount) {
    this.#used[ticker] = this.usedToday(ticker) + amount
    if (!this.#file) return
    const tmp = `${this.#file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ day: this.#day, used: this.#used }), { mode: 0o600 })
    fs.renameSync(tmp, this.#file)
  }

  recordOwnInvoice ({ invoice, assetId, amount }) {
    this.#ownInvoices.set(invoice, { assetId, amount })
  }

  forgetInvoice (invoice) {
    this.#ownInvoices.delete(invoice)
  }

  // Own means: this exact invoice came from the Vault's own wallet, for this asset and amount.
  isOwnInvoice ({ recipient, token, amount } = {}) {
    const issued = typeof recipient === 'string' ? this.#ownInvoices.get(recipient) : undefined
    return issued !== undefined && issued.assetId === token && issued.amount === amount
  }

  setTickers (assets) {
    for (const { assetId, ticker } of assets) this.#tickers.set(assetId, ticker)
  }

  tickerOf (assetId) {
    return this.#tickers.get(assetId)
  }

  snapshot () {
    const { assets, max_per_move: perMove, max_per_day: perDay } = this.#limits
    return {
      assets: [...assets],
      max_per_move: { ...perMove },
      max_per_day: { ...perDay },
      used_today: Object.fromEntries(assets.map((ticker) => [ticker, this.usedToday(ticker)]))
    }
  }
}

export function vaultPolicies (ledger) {
  const { assets, max_per_move: perMove, max_per_day: perDay, max_fee_rate: maxFeeRate } = ledger.limits

  // The context carries a snapshot of transfer()'s arguments: { token, recipient, amount, ... }.
  const transferOf = (context) => context.args[0] ?? {}
  const tickerOf = (context) => ledger.tickerOf(transferOf(context).token)
  const amountOf = (context) => transferOf(context).amount

  const isAllowedAsset = (context) => assets.includes(tickerOf(context))
  // An asset the Vault never held has no ticker yet: it cannot be sent anyway (the ALLOW rule needs an allowed
  // ticker), so the denial that explains it is the own-wallet one, not "only USDT and PEPE".
  const isOtherKnownAsset = (context) => tickerOf(context) !== undefined && !isAllowedAsset(context)
  const isWholeAmount = (context) => Number.isSafeInteger(amountOf(context)) && amountOf(context) > 0
  const withinPerMove = (context) => amountOf(context) <= perMove[tickerOf(context)]
  const withinPerDay = (context) => ledger.usedToday(tickerOf(context)) + amountOf(context) <= perDay[tickerOf(context)]
  const withinFeeCap = (context) => (transferOf(context).feeRate ?? 1) <= maxFeeRate
  const toOwnWallet = (context) => ledger.isOwnInvoice(transferOf(context))
  const not = (predicate) => (context) => !predicate(context)
  const forTicker = (ticker) => (context) => tickerOf(context) === ticker

  const deny = (name, reason, conditions) => ({ name, operation: 'transfer', action: 'DENY', reason, conditions })

  return [
    {
      id: 'vault-upkeep',
      name: 'Reads, receives and UTXO upkeep',
      scope: 'project',
      wallet: RGB_WALLET,
      rules: [{ name: 'allow-upkeep', operation: UPKEEP_OPERATIONS, action: 'ALLOW', conditions: [] }]
    },
    {
      id: 'vault-outbound',
      name: 'The Vault pays only your own wallet, within limits',
      scope: 'project',
      wallet: RGB_WALLET,
      rules: [
        deny('asset-allowlist', `Vault policy: only ${assets.join(' and ')} can leave the Vault.`, [isOtherKnownAsset]),
        deny('whole-amount', 'Vault policy: the amount must be a whole number above zero.', [not(isWholeAmount)]),
        deny('fee-cap', 'Vault policy: that network fee is too high.', [not(withinFeeCap)]),
        ...assets.map((ticker) => deny(`max-per-move-${ticker}`,
          `Vault policy: at most ${formatAmount(perMove[ticker])} ${ticker} per move.`, [forTicker(ticker), not(withinPerMove)])),
        ...assets.map((ticker) => deny(`max-per-day-${ticker}`,
          `Vault policy: at most ${formatAmount(perDay[ticker])} ${ticker} per day.`, [forTicker(ticker), not(withinPerDay)])),
        // Last on purpose: a dry run made before the wallet's invoice exists stops here once every limit passed.
        // Own means fetched by move_to_wallet: a pasted invoice is refused even when the user's Wallet made it,
        // so the reason points to Move.
        deny(OWN_WALLET_RULE, 'Vault policy: the Vault pays only the invoices it asks your Wallet for. To send to your Wallet, use Move.',
          [not(toOwnWallet)]),
        {
          name: 'allow-checked-transfer',
          operation: 'transfer',
          action: 'ALLOW',
          conditions: [isAllowedAsset, isWholeAmount, withinFeeCap, withinPerMove, withinPerDay, toOwnWallet]
        }
      ]
    }
  ]
}

// The message a user sees for a denial (a PolicyViolationError, or a simulate() result mapped to the same fields).
export function denialMessage ({ ruleName, reason, code }, ledger) {
  if (code !== DENIAL_CODES.RULE_DENIED) return 'Vault policy: the Vault does not allow this action.'
  const daily = /^max-per-day-(.+)$/.exec(ruleName ?? '')
  if (!daily) return reason
  const left = ledger.remainingToday(daily[1])
  return left > 0 ? `${reason} You can still move ${formatAmount(left)} ${daily[1]} today.` : `${reason} Try again tomorrow.`
}
