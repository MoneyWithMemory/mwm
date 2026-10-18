// The Vault's policy, the Move form's rules, the error sentences, and the mock Vault moving real
// balances with the mock backend (src/vault/, src/api/mock/). Run with `npm test`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ApiError } from '../src/api/client.ts'
import { mockEngine } from '../src/api/mock/engine.ts'
import { ADDRESSES, ASSETS } from '../src/api/mock/seed.ts'
import { asksForAsset, vaultCodeText, vaultErrorText } from '../src/vault/errors.ts'
import { mockVault } from '../src/vault/mock.ts'
import { deskLot, maxMovable, moveIssue, parseAmount, type MoveAsset } from '../src/vault/move.ts'
import { DEMO_POLICY, FOREIGN_INVOICE_MESSAGE, policyIssue, policyMessage, sendableAmount } from '../src/vault/policy.ts'
import type { VaultPolicy } from '../src/vault/types.ts'

const policy = (usedUsdt = 0): VaultPolicy => ({ ...DEMO_POLICY, used_today: { USDT: usedUsdt, PEPE: 0 } })
const usdt = (wallet: number, vault: number): MoveAsset => ({ ticker: 'USDT', precision: 0, wallet, vault })
const units = (n: number) => `${n.toLocaleString('en-US')} USDT`
const phrase = Array.from({ length: 12 }, () => 'abandon').join(' ')
const amountOf = (walletId: string, assetId: string) => mockEngine.getWallet(walletId).assets.find((a) => a.asset_id === assetId)?.amount ?? 0

function rejects(fn: () => unknown, code: string, status: number): ApiError {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof ApiError, 'an ApiError')
    assert.equal(err.code, code)
    assert.equal(err.status, status)
    return err
  }
  assert.fail(`expected ${code}`)
}

test('the policy caps what the Vault sends: per move, per day, USDT and PEPE only', () => {
  assert.equal(sendableAmount(policy(), 'USDT', 120), 120)
  assert.equal(sendableAmount(policy(), 'USDT', 9_000), 5_000)
  assert.equal(sendableAmount(policy(8_000), 'USDT', 9_000), 2_000)
  assert.equal(sendableAmount(policy(10_000), 'USDT', 9_000), 0)
  assert.equal(sendableAmount(policy(), 'BTC', 9_000), 0)
  assert.equal(policyIssue(policy(), 'USDT', 5_000), null)
  assert.equal(policyIssue(policy(), 'USDT', 5_001), 'per_move')
  assert.equal(policyIssue(policy(9_000), 'USDT', 1_001), 'per_day')
  assert.equal(policyIssue(policy(), 'BTC', 1), 'asset')
})

test('policy refusals read as plain sentences', () => {
  assert.equal(policyMessage('per_move', policy(), 'USDT', units), 'Vault policy: at most 5,000 USDT per move.')
  assert.equal(policyMessage('per_day', policy(9_000), 'USDT', units), 'Vault policy: 1,000 USDT left for today.')
  assert.equal(policyMessage('per_day', policy(10_000), 'USDT', units), "Vault policy: today's limit of 10,000 USDT is used up.")
  assert.equal(policyMessage('asset', policy(), 'BTC', units), 'Vault policy: the Vault only moves USDT and PEPE.')
})

test('amounts parse in display units within the precision', () => {
  assert.equal(parseAmount('1,250', 0), 1_250)
  assert.equal(parseAmount(' 12 ', 0), 12)
  assert.equal(parseAmount('2.0', 0), 2)
  assert.equal(parseAmount('1.5', 0), null)
  assert.equal(parseAmount('0.25', 2), 25)
  assert.equal(parseAmount('.5', 1), 5)
  for (const text of ['', '.', 'abc', '-3', '1e3', '1.2.3']) assert.equal(parseAmount(text, 2), null, text)
})

test('Max and the form follow the source side, and the policy only when the Vault sends', () => {
  assert.equal(maxMovable('to_vault', usdt(9_000, 0), policy()), 9_000)
  assert.equal(maxMovable('to_wallet', usdt(0, 9_000), policy()), 5_000)
  assert.equal(moveIssue('to_vault', usdt(9_000, 0), 9_000, policy()), null)
  assert.equal(moveIssue('to_vault', usdt(10, 0), 11, policy()), 'Not enough USDT in your Wallet.')
  assert.equal(moveIssue('to_wallet', usdt(0, 10), 11, policy()), 'Not enough USDT in your Vault.')
  assert.equal(moveIssue('to_wallet', usdt(0, 9_000), 6_000, policy()), 'Vault policy: at most 5,000 USDT per move.')
  assert.equal(moveIssue('to_vault', usdt(10, 0), null, policy()), 'Enter a whole amount greater than 0.')
  assert.equal(moveIssue('to_vault', usdt(10, 0), 0, policy()), 'Enter a whole amount greater than 0.')
})

test("Max leaves the Seller Desk's lot in the wallet, and the form says why before asking", () => {
  const pepe = (wallet: number, listed: number): MoveAsset => ({ ticker: 'PEPE', precision: 0, wallet, vault: 0, listed })
  assert.equal(maxMovable('to_vault', pepe(3_400_000, 1_000_000), policy()), 2_400_000)
  assert.equal(maxMovable('to_vault', pepe(1_000_000, 1_000_000), policy()), 0)
  assert.equal(moveIssue('to_vault', pepe(3_400_000, 1_000_000), 2_400_000, policy()), null)
  const listed = '1,000,000 PEPE are listed on your Seller Desk. Lower the lot or pause the desk first.'
  assert.equal(moveIssue('to_vault', pepe(1_000_000, 1_000_000), 1, policy()), listed)
  assert.equal(moveIssue('to_vault', pepe(1_000_000, 1_000_000), 2_000_000, policy()), 'Not enough PEPE in your Wallet.')
  const desk = { seller_active: true, offered_asset_id: ASSETS.pepe.asset_id, offered_amount: 5 }
  assert.equal(deskLot(desk, ASSETS.pepe.asset_id), 5)
  assert.equal(deskLot(desk, ASSETS.usdt.asset_id), 0)
  assert.equal(deskLot({ ...desk, seller_active: false }, ASSETS.pepe.asset_id), 0)
})

test("errors keep the server's own sentence; the UI words only what has none", () => {
  for (const message of [FOREIGN_INVOICE_MESSAGE, 'Your wallet does not hold 25 USDT.', 'The amount is listed on your Seller Desk.']) {
    assert.equal(vaultErrorText(new ApiError('any_code', message, 409)), message)
  }
  assert.equal(vaultErrorText(new ApiError('policy_denied', '', 403)), FOREIGN_INVOICE_MESSAGE)
  assert.equal(vaultErrorText(new ApiError('vault_locked', '', 409)), 'The Vault is locked. Unlock it and try again.')
  assert.equal(vaultErrorText(new ApiError('wrong_password', 'Invalid credentials', 401)), 'Wrong password.')
  const unreachable = "The Vault isn't reachable right now. Try again in a moment."
  for (const code of ['vault_unavailable', 'network_error', 'http_500', 'http_502']) {
    assert.equal(vaultErrorText(new ApiError(code, 'Failed to fetch', 500)), unreachable, code)
  }
  assert.equal(vaultErrorText(new ApiError('move_failed', 'The move did not go through. Nothing was sent.', 500)), 'The move did not go through. Nothing was sent.')
  // The proxy serves /vault to this computer only (vite.config.ts): a phone gets a bare 404.
  assert.equal(vaultErrorText(new ApiError('http_404', 'Not Found', 404)), 'Your Vault opens only on the computer that holds it.')
  // Create shows only what the code says, never the server's text about the phrase.
  assert.equal(vaultCodeText(new ApiError('invalid_mnemonic', 'words: abandon abandon …', 400)), 'Tether WDK did not accept this recovery phrase.')
  assert.equal(vaultCodeText(new ApiError('internal_error', 'seed abandon …', 500)), 'Something went wrong. Try again.')
})

test('mock: a move really leaves one part and lands in the other, as vault activity', () => {
  const usdtId = ASSETS.usdt.asset_id
  const walletUsdt = () => amountOf('wallet_a', usdtId)
  const vaultUsdt = () => mockVault.get('wallet_a').assets.find((a) => a.asset_id === usdtId)?.amount ?? 0

  // The Vault service answers 404; the backend's move_to_vault turns it into a 409, like vault_locked.
  rejects(() => mockEngine.moveToVault('wallet_a', { asset_id: usdtId, amount: 10 }), 'vault_missing', 409)
  rejects(() => mockEngine.checkMoveToVault('wallet_a', { asset_id: usdtId, amount: 10 }), 'vault_missing', 409)
  rejects(() => mockVault.create('wallet_a', { mnemonic: phrase, password: 'short' }), 'weak_password', 400)
  const created = mockVault.create('wallet_a', { mnemonic: phrase, password: 'correct horse' })
  assert.deepEqual([created.exists, created.unlocked, created.assets], [true, true, []])
  assert.ok(created.btc_sats && created.btc_sats > 0, 'funded for fees')
  rejects(() => mockVault.create('wallet_a', { mnemonic: phrase, password: 'correct horse' }), 'vault_exists', 409)

  const before = walletUsdt()
  mockEngine.moveToVault('wallet_a', { asset_id: usdtId, amount: 10 })
  assert.equal(walletUsdt(), before - 10)
  assert.equal(vaultUsdt(), 10)
  mockVault.moveToWallet('wallet_a', usdtId, 5)
  assert.equal(walletUsdt(), before - 5)
  assert.equal(vaultUsdt(), 5)
  assert.equal(mockVault.get('wallet_a').policy.used_today.USDT, 5)

  const moves = mockEngine.getWallet('wallet_a').activity.filter((item) => item.kind === 'vault')
  assert.deepEqual(moves.map((item) => [item.direction, item.amount, item.counterparty_address]), [['in', 5, null], ['out', 10, null]])
  rejects(() => mockEngine.moveToVault('wallet_a', { asset_id: usdtId, amount: before * 10 }), 'insufficient_funds', 409)
})

test('mock: the Vault pays only its own wallet, within the caps, and only when unlocked', () => {
  const usdtId = ASSETS.usdt.asset_id
  const foreign = mockEngine.receiveInvoice('wallet_b', { asset_id: usdtId, amount: 1 }).invoice
  assert.equal(rejects(() => mockVault.send('wallet_a', { invoice: foreign }), 'policy_denied', 403).message, FOREIGN_INVOICE_MESSAGE)
  rejects(() => mockVault.send('wallet_a', { invoice: 'rgb:someone-else/RGB20/1+bcrt:utxob:x' }), 'policy_denied', 403)
  rejects(() => mockVault.send('wallet_a', { invoice: 'hello' }), 'invalid_invoice', 400)
  rejects(() => mockVault.moveToWallet('wallet_a', usdtId, 5_001), 'policy_denied', 403)
  // An invoice that names no asset: the Vault asks which, then the policy still decides.
  const assetless = 'rgb:~/~/~/bcrt:utxob:someone-else'
  assert.ok(asksForAsset(rejects(() => mockVault.send('wallet_a', { invoice: assetless }), 'invalid_invoice', 400)))
  rejects(() => mockVault.send('wallet_a', { invoice: assetless, asset_id: usdtId }), 'policy_denied', 403)

  // Even an invoice its own wallet issued (the Receive sheet's): only move_to_wallet's own invoice is paid.
  const own = mockEngine.receiveInvoice('wallet_a', { asset_id: usdtId, amount: 2 }).invoice
  assert.equal(rejects(() => mockVault.send('wallet_a', { invoice: own }), 'policy_denied', 403).message, FOREIGN_INVOICE_MESSAGE)

  const locked = mockVault.lock('wallet_a')
  assert.deepEqual([locked.unlocked, locked.address, locked.btc_sats, locked.assets], [false, null, null, []])
  rejects(() => mockEngine.moveToVault('wallet_a', { asset_id: usdtId, amount: 1 }), 'vault_locked', 409)
  rejects(() => mockEngine.checkMoveToVault('wallet_a', { asset_id: usdtId, amount: 1 }), 'vault_locked', 409)
  rejects(() => mockVault.unlock('wallet_a', 'wrong horse'), 'wrong_password', 401)
  assert.equal(mockVault.unlock('wallet_a', 'correct horse').assets[0]?.amount, 5)
})

test('mock: move_to_vault leaves in the wallet what the Seller Desk lists and what deals in progress promise', () => {
  const pepeId = ASSETS.pepe.asset_id
  const usdtId = ASSETS.usdt.asset_id
  mockVault.create('wallet_b', { mnemonic: phrase, password: 'correct horse' })
  const lot = mockEngine.getWallet('wallet_b').agent_profile.offered_amount
  const spare = amountOf('wallet_b', pepeId) - lot
  const listed = rejects(() => mockEngine.moveToVault('wallet_b', { asset_id: pepeId, amount: spare + 1 }), 'desk_lot', 409)
  assert.equal(listed.message, `${lot.toLocaleString('en-US')} PEPE are listed on your Seller Desk. Lower the lot or pause the desk first.`)
  mockEngine.moveToVault('wallet_b', { asset_id: pepeId, amount: spare })
  assert.equal(amountOf('wallet_b', pepeId), lot)

  // While the price is negotiated, the buyer's ceiling is promised.
  const session = mockEngine.createSession({
    buyer_wallet_id: 'wallet_a',
    seller_address: ADDRESSES.b,
    asset_id: pepeId,
    rgb_amount: lot,
    buyer_max_ceiling_usd: 135,
    buyer_target_usd: 120,
    buyer_ai_prompt: '',
  })
  try {
    assert.equal(session.state, 'NEGOTIATING')
    const held = amountOf('wallet_a', usdtId)
    const promised = rejects(() => mockEngine.checkMoveToVault('wallet_a', { asset_id: usdtId, amount: held - 134 }), 'funds_committed', 409)
    assert.equal(promised.message, '135 USDT are promised in a deal in progress. Wait for it to finish or cancel it.')
    mockEngine.checkMoveToVault('wallet_a', { asset_id: usdtId, amount: held - 135 })
  } finally {
    mockEngine.cancel(session.session_id, 'wallet_a')
  }
  mockEngine.checkMoveToVault('wallet_a', { asset_id: usdtId, amount: amountOf('wallet_a', usdtId) })
})
