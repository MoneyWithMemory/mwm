// The real @utexo/wdk-wallet-rgb under WDK, offline (no indexer or proxy needed): governed, and wiped on lock.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import * as bip39 from 'bip39'
import { DENIAL_CODES, PolicyViolationError } from '@tetherto/wdk'
import WalletManagerRgb from '@utexo/wdk-wallet-rgb'
import { PolicyLedger, vaultPolicies } from '../src/policy.js'
import { openGovernedAccount } from '../src/vault.js'
import { TEST_MNEMONIC } from './fakes.js'

test('the real RGB account is governed, and disposing it zeroes the seed', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwm-vault-wdk-'))
  try {
    const seed = bip39.mnemonicToSeedSync(TEST_MNEMONIC)
    const { wdk, account, address } = await openGovernedAccount({
      seed,
      WalletManager: WalletManagerRgb,
      walletConfig: { network: 'regtest', indexerUrl: 'tcp://127.0.0.1:1', transportEndpoint: 'rpc://127.0.0.1:1/json-rpc', dataDir },
      policies: vaultPolicies(new PolicyLedger())
    })
    assert.match(address, /^bcrt1p/)
    assert.equal(account.keyPair, undefined)
    await assert.rejects(account.getRgbWallet(), (err) => err instanceof PolicyViolationError && err.code === DENIAL_CODES.NO_APPLICABLE_RULE)
    await assert.rejects(account.transfer({ token: 'rgb:x', recipient: 'rgb:y', amount: 1 }), PolicyViolationError)
    assert.ok(seed.some((byte) => byte !== 0))
    wdk.dispose()
    assert.ok(seed.every((byte) => byte === 0), 'the seed buffer is zeroed on dispose')
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
