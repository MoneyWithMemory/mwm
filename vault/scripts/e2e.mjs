// Regtest round trip through a running backend and Vault service:
//   AI wallet -> Vault (backend move_to_vault), Vault -> AI wallet (Vault move_to_wallet),
//   then real WDK policy denials: a move over max_per_move and a payment to another wallet's invoice.
// It moves funds, so it never defaults to the team's services: BACKEND_URL and VAULT_URL are required.
//
//   BACKEND_URL=http://127.0.0.1:8101 VAULT_URL=http://127.0.0.1:8201 npm run e2e
//
// Optional: E2E_WALLET_ID (wallet_a), E2E_OTHER_WALLET_ID (wallet_b), E2E_AMOUNT (30), E2E_PASSWORD.
// A missing Vault is created from a fresh phrase that is never stored anywhere: it is a throwaway test Vault.
import WDK from '@tetherto/wdk'

const { BACKEND_URL, VAULT_URL } = process.env
if (!BACKEND_URL || !VAULT_URL) {
  console.error('Set BACKEND_URL and VAULT_URL (test services only: this script moves funds).')
  process.exit(2)
}
const WALLET = process.env.E2E_WALLET_ID || 'wallet_a'
const OTHER = process.env.E2E_OTHER_WALLET_ID || 'wallet_b'
const AMOUNT = Number(process.env.E2E_AMOUNT || 30)
const BACK = AMOUNT - 10
const PASSWORD = process.env.E2E_PASSWORD || 'e2e vault password'

const results = []
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api (base, method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000)
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, body: data }
}

async function expectOk (label, call) {
  const started = Date.now()
  const res = await call()
  if (res.status >= 300) throw new Error(`${label}: HTTP ${res.status} ${JSON.stringify(res.body)}`)
  console.log(`ok   ${label} (${Date.now() - started} ms)`)
  results.push(label)
  return res.body
}

function check (label, condition, detail) {
  if (!condition) throw new Error(`${label}: ${detail}`)
  console.log(`ok   ${label}`)
  results.push(label)
}

const vaultAmount = (state, assetId) => state.assets.find((asset) => asset.asset_id === assetId)?.amount ?? 0
const walletAmount = (state, assetId) => state.assets.find((asset) => asset.asset_id === assetId)?.amount ?? 0

async function main () {
  await expectOk('backend health', () => api(BACKEND_URL, 'GET', '/api/health'))
  await expectOk('Vault health', () => api(VAULT_URL, 'GET', '/vault/health'))

  const wallet = await expectOk(`${WALLET} state`, () => api(BACKEND_URL, 'GET', `/api/wallets/${WALLET}`))
  const usdt = wallet.assets.find((asset) => asset.ticker === 'USDT')
  check(`${WALLET} holds USDT`, usdt && usdt.amount >= AMOUNT, `needs ${AMOUNT} USDT, has ${usdt?.amount ?? 0}`)

  let vault = await expectOk('Vault state', () => api(VAULT_URL, 'GET', `/vault/${WALLET}`))
  if (!vault.exists) {
    vault = await expectOk('create Vault (fresh WDK phrase)', () => api(VAULT_URL, 'POST', `/vault/${WALLET}/create`,
      { mnemonic: WDK.getRandomSeedPhrase(), password: PASSWORD }))
  } else if (!vault.unlocked) {
    vault = await expectOk('unlock Vault', () => api(VAULT_URL, 'POST', `/vault/${WALLET}/unlock`, { password: PASSWORD }))
  }
  const vaultBefore = vaultAmount(vault, usdt.asset_id)
  const walletBefore = usdt.amount

  // AI wallet -> Vault: the backend asks the Vault for an invoice and pays it.
  await expectOk(`move_to_vault ${AMOUNT} USDT`, () => api(BACKEND_URL, 'POST', `/api/wallets/${WALLET}/move_to_vault`,
    { asset_id: usdt.asset_id, amount: AMOUNT }))
  for (let attempt = 0; attempt < 6 && vaultAmount(vault, usdt.asset_id) < vaultBefore + AMOUNT; attempt++) {
    if (attempt > 0) await sleep(1000)
    vault = (await api(VAULT_URL, 'POST', `/vault/${WALLET}/refresh`)).body
  }
  check('Vault received it, settled', vaultAmount(vault, usdt.asset_id) === vaultBefore + AMOUNT,
    `Vault holds ${vaultAmount(vault, usdt.asset_id)}, expected ${vaultBefore + AMOUNT}`)

  // Vault -> AI wallet: governed WDK transfer to an invoice the Vault got from its own wallet.
  const moved = await expectOk(`move_to_wallet ${BACK} USDT`, () => api(VAULT_URL, 'POST', `/vault/${WALLET}/move_to_wallet`,
    { asset_id: usdt.asset_id, amount: BACK }))
  check('move_to_wallet returned a txid', /^[0-9a-f]{64}$/.test(moved.txid), JSON.stringify(moved))
  let walletAfter = 0
  for (let attempt = 0; attempt < 6; attempt++) {
    if (attempt > 0) {
      await sleep(1000)
      await api(BACKEND_URL, 'POST', `/api/wallets/${WALLET}/refresh`)
    }
    walletAfter = walletAmount((await api(BACKEND_URL, 'GET', `/api/wallets/${WALLET}`)).body, usdt.asset_id)
    if (walletAfter === walletBefore - AMOUNT + BACK) break
  }
  check(`${WALLET} got it back, settled`, walletAfter === walletBefore - AMOUNT + BACK,
    `wallet holds ${walletAfter}, expected ${walletBefore - AMOUNT + BACK}`)
  vault = (await api(VAULT_URL, 'POST', `/vault/${WALLET}/refresh`)).body
  check('Vault balance after the move back', vaultAmount(vault, usdt.asset_id) === vaultBefore + AMOUNT - BACK,
    `Vault holds ${vaultAmount(vault, usdt.asset_id)}, expected ${vaultBefore + AMOUNT - BACK}`)

  // Policy: over max_per_move, denied by the dry run before any invoice is requested.
  const tooMuch = vault.policy.max_per_move.USDT + 1
  const overLimit = await api(VAULT_URL, 'POST', `/vault/${WALLET}/move_to_wallet`, { asset_id: usdt.asset_id, amount: tooMuch })
  check(`move_to_wallet ${tooMuch} USDT denied`, overLimit.status === 403 && overLimit.body.code === 'policy_denied',
    JSON.stringify(overLimit))
  console.log(`     "${overLimit.body.message}"`)

  // Policy: another wallet's invoice, denied by the WDK engine inside the governed transfer.
  const foreign = await expectOk(`invoice from ${OTHER}`, () => api(BACKEND_URL, 'POST', `/api/wallets/${OTHER}/receive_invoice`,
    { asset_id: usdt.asset_id, amount: 1 }))
  // A wallet that never held USDT gets an invoice naming no asset, so the asset is chosen here.
  const denied = await api(VAULT_URL, 'POST', `/vault/${WALLET}/send`, { invoice: foreign.invoice, asset_id: usdt.asset_id })
  check(`send to ${OTHER}'s invoice denied`, denied.status === 403 && denied.body.code === 'policy_denied', JSON.stringify(denied))
  console.log(`     "${denied.body.message}"`)

  console.log(`\nPASS ${results.length}/${results.length}`)
}

main().catch((err) => {
  console.error(`FAIL ${err.message}`)
  console.error(`(passed before failing: ${results.length})`)
  process.exit(1)
})
