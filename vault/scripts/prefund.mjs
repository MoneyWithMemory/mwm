// Prepares the demo Vault in one command: a Vault for the AI wallet, unlocked, holding some USDT (or another
// asset) moved in from the AI wallet (backend move_to_vault). Safe to re-run.
//
//   VAULT_DEMO_PASSWORD='...' PATH=$HOME/.mwm/node22/bin:$PATH node scripts/prefund.mjs
//
// Env: VAULT_DEMO_PASSWORD (required, 8+ characters), PREFUND_WALLET_ID (wallet_a), PREFUND_TICKER (USDT),
// PREFUND_AMOUNT (500: the Vault ends up holding at least this much),
// PREFUND_MNEMONIC_FILE (unset: a new Vault gets a fresh WDK phrase; set, its phrase is imported from that file),
// BACKEND_URL (http://127.0.0.1:8000), VAULT_URL (http://127.0.0.1:8200).
import fs from 'node:fs'
import WDK from '@tetherto/wdk'

const PASSWORD = process.env.VAULT_DEMO_PASSWORD
const WALLET = process.env.PREFUND_WALLET_ID || 'wallet_a'
const TICKER = process.env.PREFUND_TICKER || 'USDT'
const AMOUNT = Number(process.env.PREFUND_AMOUNT || 500)
const MNEMONIC_FILE = process.env.PREFUND_MNEMONIC_FILE
const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000'
const VAULT_URL = process.env.VAULT_URL || 'http://127.0.0.1:8200'

async function api (base, method, route, body) {
  const res = await fetch(base + route, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  })
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status} ${data?.message ?? ''}`)
  return data
}

// A fresh phrase is never written anywhere: the Vault seals it with the password, which is all a re-run needs.
const recoveryPhrase = () => MNEMONIC_FILE ? fs.readFileSync(MNEMONIC_FILE, 'utf8').trim() : WDK.getRandomSeedPhrase()

const held = (state, assetId) => state.assets.find((asset) => asset.asset_id === assetId)?.amount ?? 0

async function main () {
  if (!PASSWORD || PASSWORD.length < 8) throw new Error('Set VAULT_DEMO_PASSWORD (8+ characters).')
  if (!Number.isSafeInteger(AMOUNT) || AMOUNT <= 0) throw new Error('PREFUND_AMOUNT must be a whole number above zero.')

  let vault = await api(VAULT_URL, 'GET', `/vault/${WALLET}`)
  if (!vault.exists) {
    vault = await api(VAULT_URL, 'POST', `/vault/${WALLET}/create`, { mnemonic: recoveryPhrase(), password: PASSWORD })
    console.log(`Vault created for ${WALLET}.`)
  } else if (!vault.unlocked) {
    vault = await api(VAULT_URL, 'POST', `/vault/${WALLET}/unlock`, { password: PASSWORD })
    console.log(`Vault unlocked for ${WALLET}.`)
  }

  const wallet = await api(BACKEND_URL, 'GET', `/api/wallets/${WALLET}`)
  const asset = wallet.assets.find((candidate) => candidate.ticker === TICKER)
  if (!asset) throw new Error(`${WALLET} holds no ${TICKER}.`)
  const missing = AMOUNT - held(vault, asset.asset_id)
  if (missing > 0) {
    const { txid } = await api(BACKEND_URL, 'POST', `/api/wallets/${WALLET}/move_to_vault`, { asset_id: asset.asset_id, amount: missing })
    console.log(`Moved ${missing} ${TICKER} from ${WALLET} to its Vault (${txid}).`)
    for (let attempt = 0; attempt < 6 && held(vault, asset.asset_id) < AMOUNT; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000))
      vault = await api(VAULT_URL, 'POST', `/vault/${WALLET}/refresh`)
    }
  }
  const balances = vault.assets.map(({ ticker, amount, pending }) => `${ticker} ${amount}${pending ? ` (+${pending} pending)` : ''}`)
  console.log(`Vault ${WALLET}: ${balances.join(', ') || 'empty'}; ${vault.btc_sats ?? 0} sats for fees.`)
}

main().catch((err) => {
  console.error(`prefund: ${err.message}`)
  process.exit(1)
})
