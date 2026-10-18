// The policy matrix, enforced by the real WDK policy engine (wdk.registerPolicy) on a stand-in RGB account.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import WDK, { DENIAL_CODES, PolicyViolationError } from '@tetherto/wdk'
import { denialMessage, OWN_WALLET_RULE, PolicyLedger, RGB_WALLET, vaultPolicies } from '../src/policy.js'
import { makeFakeWallet, OTHER_ID, PEPE_ID, TEST_MNEMONIC, USDT_ID } from './fakes.js'

const OWN = 'rgb:own-invoice-from-the-ai-wallet'
const FOREIGN = 'rgb:somebody-elses-invoice'
const MOVE_INSTEAD = 'Vault policy: the Vault pays only the invoices it asks your Wallet for. To send to your Wallet, use Move.'

async function governed (ledger = new PolicyLedger()) {
  const fake = makeFakeWallet()
  const wdk = new WDK(TEST_MNEMONIC)
  wdk.registerWallet(RGB_WALLET, fake.FakeWalletManager, {})
  wdk.registerPolicy(vaultPolicies(ledger))
  const account = await wdk.getAccount(RGB_WALLET, 0)
  ledger.setTickers(fake.assets)
  return { account, ledger, fake }
}

const deniedBy = (ruleName, code = DENIAL_CODES.RULE_DENIED) => (err) => {
  assert.ok(err instanceof PolicyViolationError, `expected a PolicyViolationError, got ${err}`)
  assert.equal(err.code, code)
  if (ruleName) assert.equal(err.ruleName, ruleName)
  return true
}

test('allows a transfer to an invoice the Vault obtained from its own wallet', async () => {
  const { account, ledger, fake } = await governed()
  ledger.recordOwnInvoice({ invoice: OWN, assetId: USDT_ID, amount: 100 })
  const result = await account.transfer({ token: USDT_ID, recipient: OWN, amount: 100 })
  assert.equal(result.hash, 'f'.repeat(64))
  assert.equal(fake.called('transfer').length, 1)
})

test('denies a foreign invoice before the wallet sees it', async () => {
  const { account, fake } = await governed()
  await assert.rejects(account.transfer({ token: USDT_ID, recipient: FOREIGN, amount: 100 }), (err) => {
    deniedBy(OWN_WALLET_RULE)(err)
    assert.equal(err.reason, MOVE_INSTEAD)
    return true
  })
  assert.equal(fake.called('transfer').length, 0)
})

test('a foreign invoice for an asset the Vault never held reads as foreign, and stays denied', async () => {
  const { account, fake } = await governed()
  const unknownId = 'rgb:an-asset-this-vault-never-held'
  await assert.rejects(account.transfer({ token: unknownId, recipient: FOREIGN, amount: 100 }), (err) => {
    deniedBy(OWN_WALLET_RULE)(err)
    assert.equal(err.reason, MOVE_INSTEAD)
    return true
  })
  assert.equal(fake.called('transfer').length, 0)
  // Even an own invoice cannot carry an asset without a known, allowed ticker out of the Vault.
  const { account: fresh, ledger, fake: freshFake } = await governed()
  ledger.recordOwnInvoice({ invoice: OWN, assetId: unknownId, amount: 100 })
  await assert.rejects(fresh.transfer({ token: unknownId, recipient: OWN, amount: 100 }), (err) => err instanceof PolicyViolationError)
  assert.equal(freshFake.called('transfer').length, 0)
})

test('an own invoice is bound to its asset and amount', async () => {
  const { account, ledger } = await governed()
  ledger.recordOwnInvoice({ invoice: OWN, assetId: USDT_ID, amount: 100 })
  await assert.rejects(account.transfer({ token: USDT_ID, recipient: OWN, amount: 101 }), deniedBy(OWN_WALLET_RULE))
  await assert.rejects(account.transfer({ token: PEPE_ID, recipient: OWN, amount: 100 }), deniedBy(OWN_WALLET_RULE))
})

test('denies assets other than USDT and PEPE', async () => {
  const { account, ledger } = await governed()
  ledger.recordOwnInvoice({ invoice: OWN, assetId: OTHER_ID, amount: 10 })
  await assert.rejects(account.transfer({ token: OTHER_ID, recipient: OWN, amount: 10 }), (err) => {
    deniedBy('asset-allowlist')(err)
    assert.equal(err.reason, 'Vault policy: only USDT and PEPE can leave the Vault.')
    return true
  })
})

test('denies a move over max_per_move', async () => {
  const { account, ledger } = await governed()
  ledger.recordOwnInvoice({ invoice: OWN, assetId: USDT_ID, amount: 5001 })
  await assert.rejects(account.transfer({ token: USDT_ID, recipient: OWN, amount: 5001 }), (err) => {
    deniedBy('max-per-move-USDT')(err)
    assert.equal(err.reason, 'Vault policy: at most 5,000 USDT per move.')
    return true
  })
  ledger.recordOwnInvoice({ invoice: OWN, assetId: PEPE_ID, amount: 1_000_000 })
  await account.transfer({ token: PEPE_ID, recipient: OWN, amount: 1_000_000 })
})

test('denies a move that would pass max_per_day, and says what is left', async () => {
  const { account, ledger } = await governed()
  ledger.recordMove('USDT', 8000)
  ledger.recordOwnInvoice({ invoice: OWN, assetId: USDT_ID, amount: 3000 })
  await assert.rejects(account.transfer({ token: USDT_ID, recipient: OWN, amount: 3000 }), (err) => {
    deniedBy('max-per-day-USDT')(err)
    assert.equal(denialMessage(err, ledger), 'Vault policy: at most 10,000 USDT per day. You can still move 2,000 USDT today.')
    return true
  })
  ledger.recordOwnInvoice({ invoice: OWN, assetId: USDT_ID, amount: 2000 })
  await account.transfer({ token: USDT_ID, recipient: OWN, amount: 2000 })
})

test('denies amounts that are not whole and positive', async () => {
  const { account, ledger } = await governed()
  ledger.recordOwnInvoice({ invoice: OWN, assetId: USDT_ID, amount: 1.5 })
  await assert.rejects(account.transfer({ token: USDT_ID, recipient: OWN, amount: 1.5 }), deniedBy('whole-amount'))
})

test('denies a fee rate above the cap', async () => {
  const { account, ledger, fake } = await governed()
  ledger.recordOwnInvoice({ invoice: OWN, assetId: USDT_ID, amount: 100 })
  await assert.rejects(account.transfer({ token: USDT_ID, recipient: OWN, amount: 100, feeRate: 500 }), deniedBy('fee-cap'))
  await account.transfer({ token: USDT_ID, recipient: OWN, amount: 100, feeRate: 1 })
  assert.equal(fake.called('transfer').length, 1)
})

test('reads, receives and UTXO upkeep are allowed', async () => {
  const { account, fake } = await governed()
  await account.listAssets()
  await account.listUnspents()
  await account.receiveAsset({ amount: 10 })
  await account.refreshWallet()
  await account.createUtxos({ upTo: true, num: 5 })
  assert.deepEqual(fake.calls.map((call) => call.method), ['listAssets', 'listUnspents', 'receiveAsset', 'refreshWallet', 'createUtxos'])
})

test('every other value-moving or signing call is denied by default', async () => {
  const { account, fake } = await governed()
  const attempts = [
    () => account.sendTransaction({ to: 'bcrt1qattacker', value: 50_000 }),
    () => account.sign('message'),
    () => account.signPsbt('cHNidP8B'),
    () => account.sendBegin({ invoice: FOREIGN, assetId: USDT_ID, amount: 1 }),
    () => account.sendEnd({ signedPsbt: 'cHNidP8B' }),
    () => account.getRgbWallet(),
    () => account.issueAssetNia({ ticker: 'X', name: 'X', amounts: [1], precision: 0 })
  ]
  for (const attempt of attempts) await assert.rejects(attempt(), deniedBy(undefined, DENIAL_CODES.NO_APPLICABLE_RULE))
  assert.deepEqual(fake.calls, [])
  assert.equal(account.keyPair, undefined)
})

test('simulate gives the dry-run verdict without calling the wallet', async () => {
  const { account, fake } = await governed()
  const fine = await account.simulate.transfer({ token: USDT_ID, recipient: null, amount: 100 })
  assert.equal(fine.decision, 'DENY')
  assert.equal(fine.matched_rule, OWN_WALLET_RULE)
  const tooBig = await account.simulate.transfer({ token: USDT_ID, recipient: null, amount: 6000 })
  assert.equal(tooBig.matched_rule, 'max-per-move-USDT')
  assert.equal(fake.called('transfer').length, 0)
})

test('daily usage persists across restarts and resets the next day', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwm-vault-ledger-'))
  try {
    const file = path.join(dir, 'policy.json')
    let now = new Date(2026, 9, 18, 10, 0)
    const clock = () => now
    new PolicyLedger({ file, now: clock }).recordMove('USDT', 700)
    const reopened = new PolicyLedger({ file, now: clock })
    assert.equal(reopened.usedToday('USDT'), 700)
    assert.equal(reopened.snapshot().used_today.USDT, 700)
    now = new Date(2026, 9, 19, 0, 1)
    assert.equal(reopened.usedToday('USDT'), 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
