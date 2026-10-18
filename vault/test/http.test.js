// The HTTP API end to end on a stand-in RGB wallet: validation, lifecycle, and the governed moves.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { createBackendClient } from '../src/backend.js'
import { createVaultServer, readJson } from '../src/server.js'
import { VaultService } from '../src/vault.js'
import { ANY_100_INVOICE, makeFakeWallet, PEPE_ID, silentLog, TEST_MNEMONIC, USDT_40_INVOICE, USDT_ID } from './fakes.js'

const PASSWORD = 'correct horse battery'
const MOVE_INSTEAD = 'Vault policy: the Vault pays only the invoices it asks your Wallet for. To send to your Wallet, use Move.'

function listen (server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
}

// Stands in for the backend's receive_invoice and refresh; `down` makes it drop connections.
function fakeBackend () {
  const backend = { down: false, requests: [], invoice: USDT_40_INVOICE }
  backend.server = http.createServer((req, res) => {
    if (backend.down) return req.socket.destroy()
    backend.requests.push(`${req.method} ${req.url}`)
    let body
    if (req.url.endsWith('/receive_invoice')) {
      body = { invoice: backend.invoice, recipient_id: 'bcrt:utxob:x', asset_id: USDT_ID, amount: 40, expires_at: null }
    } else {
      body = { wallet_id: 'wallet_a', refreshed: true }
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  return backend
}

describe('Vault HTTP API', () => {
  let base
  let vaultDir
  let server
  let backend
  const fake = makeFakeWallet()
  const chain = []
  const regtest = {
    async mine (blocks) { chain.push(`mine ${blocks}`) },
    async fund (address, btc) { chain.push(`fund ${address} ${btc}`) }
  }
  let clock = Date.now()

  const call = async (method, route, body) => {
    const res = await fetch(base + route, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
    })
    return { status: res.status, body: await res.json() }
  }

  // With the headers a browser or a proxy sends, Host included, which fetch does not let a caller set.
  const raw = (method, route, headers, body) => new Promise((resolve, reject) => {
    const req = http.request(base + route, { method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(body)
  })

  before(async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwm-vault-http-'))
    backend = fakeBackend()
    const backendUrl = await listen(backend.server)
    const service = new VaultService({
      config: { vaultDir, network: 'regtest', indexerUrl: 'tcp://127.0.0.1:1', transportEndpoint: 'rpc://127.0.0.1:1/json-rpc' },
      WalletManager: fake.FakeWalletManager,
      regtest,
      backend: createBackendClient(backendUrl),
      log: silentLog,
      now: () => clock
    })
    server = createVaultServer(service, { log: silentLog })
    base = await listen(server)
  })

  after(() => {
    server.close()
    backend.server.close()
    fs.rmSync(vaultDir, { recursive: true, force: true })
  })

  test('health and an empty Vault', async () => {
    assert.deepEqual(await call('GET', '/vault/health'), { status: 200, body: { ok: true } })
    const { status, body } = await call('GET', '/vault/wallet_a')
    assert.equal(status, 200)
    assert.equal(body.exists, false)
    assert.equal(body.unlocked, false)
    assert.deepEqual(body.assets, [])
    assert.deepEqual(body.policy.max_per_move, { USDT: 5000, PEPE: 1_000_000 })
  })

  test('create validates its input', async () => {
    assert.equal((await call('POST', '/vault/wallet_a/create', '{not json')).body.code, 'invalid_request')
    assert.equal((await call('POST', '/vault/wallet_a/create', {})).body.code, 'invalid_request')
    const badPhrase = await call('POST', '/vault/wallet_a/create', { mnemonic: 'one two three', password: PASSWORD })
    assert.deepEqual([badPhrase.status, badPhrase.body.code], [400, 'invalid_mnemonic'])
    const weak = await call('POST', '/vault/wallet_a/create', { mnemonic: TEST_MNEMONIC, password: 'short' })
    assert.deepEqual([weak.status, weak.body.code], [400, 'weak_password'])
    const badId = await call('POST', '/vault/..%2Fetc/create', { mnemonic: TEST_MNEMONIC, password: PASSWORD })
    assert.deepEqual([badId.status, badId.body.code], [400, 'invalid_request'])
  })

  test('create stores only the sealed phrase, unlocks, and prepares fees (regtest)', async () => {
    const { status, body } = await call('POST', '/vault/wallet_a/create', { mnemonic: TEST_MNEMONIC, password: PASSWORD })
    assert.equal(status, 201)
    assert.equal(body.unlocked, true)
    assert.equal(body.address, 'bcrt1pfakevaultaddress')
    assert.equal(body.btc_sats, 1_000_000)
    assert.deepEqual(body.assets.find((asset) => asset.ticker === 'USDT'), { asset_id: USDT_ID, ticker: 'USDT', amount: 1_000_000, pending: 0 })
    const sealed = fs.readFileSync(path.join(vaultDir, 'wallet_a', 'seed.enc'), 'utf8')
    assert.ok(!sealed.includes('abandon'))
    assert.equal(fs.statSync(path.join(vaultDir, 'wallet_a', 'seed.enc')).mode & 0o777, 0o600)
    assert.equal(fake.called('createUtxos').length, 1)
    assert.deepEqual(chain, ['mine 1'])
    const again = await call('POST', '/vault/wallet_a/create', { mnemonic: TEST_MNEMONIC, password: PASSWORD })
    assert.deepEqual([again.status, again.body.code], [409, 'vault_exists'])
  })

  test('lock and unlock', async () => {
    const locked = await call('POST', '/vault/wallet_a/lock')
    assert.deepEqual([locked.status, locked.body.unlocked, locked.body.address, locked.body.assets], [200, false, null, []])
    assert.ok(fake.called('dispose').length >= 1)
    const whileLocked = await call('POST', '/vault/wallet_a/invoice', { asset_id: USDT_ID, amount: 5 })
    assert.deepEqual([whileLocked.status, whileLocked.body.code], [409, 'vault_locked'])
    const wrong = await call('POST', '/vault/wallet_a/unlock', { password: 'not the password' })
    assert.deepEqual([wrong.status, wrong.body.code], [401, 'wrong_password'])
    const missing = await call('POST', '/vault/wallet_b/unlock', { password: PASSWORD })
    assert.deepEqual([missing.status, missing.body.code], [404, 'vault_missing'])
    const unlocked = await call('POST', '/vault/wallet_a/unlock', { password: PASSWORD })
    assert.deepEqual([unlocked.status, unlocked.body.unlocked], [200, true])
  })

  test('unlock pauses for a minute after five wrong passwords in a row', async () => {
    const unlock = (password) => call('POST', '/vault/wallet_a/unlock', { password })
    await call('POST', '/vault/wallet_a/lock')
    for (let attempt = 0; attempt < 4; attempt++) assert.equal((await unlock('a guess')).status, 401)
    // A right password ends the row.
    assert.equal((await unlock(PASSWORD)).status, 200)
    assert.equal((await unlock('a guess')).status, 401)
    assert.equal((await unlock(PASSWORD)).status, 200)
    await call('POST', '/vault/wallet_a/lock')
    for (let attempt = 0; attempt < 5; attempt++) assert.equal((await unlock('a guess')).status, 401)
    const paused = await unlock(PASSWORD)
    assert.deepEqual([paused.status, paused.body], [429, { code: 'too_many_attempts', message: 'Too many wrong passwords. Wait a minute and try again.' }])
    clock += 59_000
    assert.equal((await unlock(PASSWORD)).status, 429)
    clock += 1000
    const unlocked = await unlock(PASSWORD)
    assert.deepEqual([unlocked.status, unlocked.body.unlocked], [200, true])
  })

  test('a page from another site or device cannot drive the Vault, the app on this computer can', async () => {
    // A cross-site form or no-cors fetch: a body that is not JSON, or an Origin that is not this computer.
    const form = await raw('POST', '/vault/wallet_b/create', { 'content-type': 'text/plain;charset=UTF-8' },
      JSON.stringify({ mnemonic: TEST_MNEMONIC, password: PASSWORD }))
    assert.deepEqual([form.status, form.body.code], [415, 'unsupported_media_type'])
    assert.equal((await call('GET', '/vault/wallet_b')).body.exists, false)
    // The app opened from the LAN, on another device, carries the LAN address as its Origin.
    for (const origin of ['http://evil.example', 'null', 'http://192.168.1.20:5173']) {
      const denied = await raw('POST', '/vault/wallet_a/lock', { origin, 'sec-fetch-site': 'cross-site' })
      assert.deepEqual([denied.status, denied.body.code], [403, 'forbidden'])
    }
    // A DNS name rebound to 127.0.0.1 makes a page same-origin with the Vault, but its Host names that page's site.
    for (const method of ['GET', 'POST']) {
      const rebound = await raw(method, '/vault/wallet_a', { host: 'rebound.evil.example:8200', origin: 'http://rebound.evil.example:8200' })
      assert.deepEqual([rebound.status, rebound.body.code], [403, 'forbidden'])
    }
    assert.equal((await call('GET', '/vault/wallet_a')).body.unlocked, true)
    // The app through its /vault proxy, which sets Host to the Vault's.
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173']) {
      const allowed = await raw('POST', '/vault/wallet_a/refresh', { origin, 'sec-fetch-site': 'same-origin' })
      assert.deepEqual([allowed.status, allowed.body.unlocked], [200, true])
    }
  })

  test('invoice is receive-only and validated', async () => {
    assert.equal((await call('POST', '/vault/wallet_a/invoice', { asset_id: 'btc', amount: 5 })).body.code, 'invalid_request')
    assert.equal((await call('POST', '/vault/wallet_a/invoice', { asset_id: USDT_ID, amount: 0 })).body.code, 'invalid_request')
    const { status, body } = await call('POST', '/vault/wallet_a/invoice', { asset_id: USDT_ID, amount: 5 })
    assert.deepEqual([status, body], [200, { invoice: 'rgb:~/~/BF/bcrt:utxob:fake', recipient_id: 'bcrt:utxob:fake' }])
    assert.equal(fake.called('receiveAsset').at(-1).args[0].assetId, USDT_ID)
  })

  test('move_to_wallet pays the invoice of its own wallet and settles both sides', async () => {
    backend.requests.length = 0
    chain.length = 0
    const { status, body } = await call('POST', '/vault/wallet_a/move_to_wallet', { asset_id: USDT_ID, amount: 40 })
    assert.deepEqual([status, body], [200, { txid: 'f'.repeat(64), asset_id: USDT_ID, amount: 40 }])
    assert.deepEqual(fake.called('transfer').at(-1).args[0], { token: USDT_ID, recipient: USDT_40_INVOICE, amount: 40, feeRate: 1, minConfirmations: 1 })
    assert.deepEqual(backend.requests, [
      'POST /api/wallets/wallet_a/receive_invoice',
      'POST /api/wallets/wallet_a/refresh',
      'POST /api/wallets/wallet_a/refresh'
    ])
    assert.deepEqual(chain, ['mine 1'])
    assert.equal((await call('GET', '/vault/wallet_a')).body.policy.used_today.USDT, 40)
  })

  test('move_to_wallet over a limit is denied before any invoice is requested', async () => {
    backend.requests.length = 0
    const { status, body } = await call('POST', '/vault/wallet_a/move_to_wallet', { asset_id: USDT_ID, amount: 6000 })
    assert.deepEqual([status, body], [403, { code: 'policy_denied', message: 'Vault policy: at most 5,000 USDT per move.' }])
    assert.deepEqual(backend.requests, [])
  })

  test('move_to_wallet reports a backend that is down', async () => {
    backend.down = true
    try {
      const { status, body } = await call('POST', '/vault/wallet_a/move_to_wallet', { asset_id: USDT_ID, amount: 40 })
      assert.deepEqual([status, body.code], [503, 'backend_unavailable'])
    } finally {
      backend.down = false
    }
  })

  test('move_to_wallet refuses an invoice that does not match the move', async () => {
    const { status, body } = await call('POST', '/vault/wallet_a/move_to_wallet', { asset_id: USDT_ID, amount: 41 })
    assert.deepEqual([status, body.code], [502, 'backend_error'])
  })

  test('send is denied by the policy, even for an invoice its own wallet made: Move pays that one', async () => {
    const transfers = fake.called('transfer').length
    // The very invoice the wallet's receive_invoice returned to move_to_wallet above.
    const { status, body } = await call('POST', '/vault/wallet_a/send', { invoice: USDT_40_INVOICE })
    assert.deepEqual([status, body], [403, { code: 'policy_denied', message: MOVE_INSTEAD }])
    assert.equal(fake.called('transfer').length, transfers)
    assert.equal((await call('POST', '/vault/wallet_a/send', { invoice: 'rgb:garbage' })).body.code, 'invalid_invoice')
  })

  test('send to an invoice naming no asset needs the asset, and is denied all the same', async () => {
    const unnamed = await call('POST', '/vault/wallet_a/send', { invoice: ANY_100_INVOICE })
    assert.deepEqual([unnamed.status, unnamed.body.code], [400, 'invalid_invoice'])
    const chosen = await call('POST', '/vault/wallet_a/send', { invoice: ANY_100_INVOICE, asset_id: USDT_ID })
    assert.deepEqual([chosen.status, chosen.body.message], [403, MOVE_INSTEAD])
    const mismatch = await call('POST', '/vault/wallet_a/send', { invoice: USDT_40_INVOICE, asset_id: PEPE_ID })
    assert.deepEqual([mismatch.status, mismatch.body.message], [400, 'This invoice asks for another asset.'])
  })

  test('unknown routes and methods', async () => {
    assert.equal((await call('GET', '/vault/wallet_a/teleport')).status, 404)
    assert.equal((await call('GET', '/elsewhere')).status, 404)
    assert.equal((await call('POST', '/vault/wallet_a')).status, 405)
    assert.equal((await call('GET', '/vault/wallet_a/create')).status, 405)
  })
})

test('a request body is zeroed once parsed', async () => {
  const chunks = [Buffer.from(`{"mnemonic":"${TEST_MNEMONIC.slice(0, 20)}`), Buffer.from(`${TEST_MNEMONIC.slice(20)}","password":"x"}`)]
  const req = { headers: { 'content-type': 'application/json' }, async * [Symbol.asyncIterator] () { yield * chunks } }
  assert.deepEqual(await readJson(req), { mnemonic: TEST_MNEMONIC, password: 'x' })
  assert.ok(chunks.every((chunk) => chunk.every((byte) => byte === 0)))
})
