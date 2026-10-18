import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openSecret, sealSecret, WrongPasswordError } from '../src/crypto.js'
import { TEST_MNEMONIC } from './fakes.js'

const secret = () => Buffer.from(TEST_MNEMONIC, 'utf8')

test('a sealed recovery phrase opens with the right password', async () => {
  const sealed = await sealSecret(secret(), 'correct horse', 'wallet_a')
  const opened = await openSecret(sealed, 'correct horse', 'wallet_a')
  assert.equal(opened.toString('utf8'), TEST_MNEMONIC)
})

test('the sealed file holds no trace of the phrase and never repeats salt or IV', async () => {
  const one = await sealSecret(secret(), 'correct horse', 'wallet_a')
  const two = await sealSecret(secret(), 'correct horse', 'wallet_a')
  const text = JSON.stringify(one)
  for (const word of new Set(TEST_MNEMONIC.split(' '))) assert.ok(!text.includes(word))
  assert.notEqual(one.salt, two.salt)
  assert.notEqual(one.iv, two.iv)
  assert.notEqual(one.ciphertext, two.ciphertext)
})

test('a wrong password does not open it', async () => {
  const sealed = await sealSecret(secret(), 'correct horse', 'wallet_a')
  await assert.rejects(openSecret(sealed, 'wrong horse', 'wallet_a'), WrongPasswordError)
})

test('a sealed file opens only for its own wallet id', async () => {
  const sealed = await sealSecret(secret(), 'correct horse', 'wallet_a')
  await assert.rejects(openSecret(sealed, 'correct horse', 'wallet_b'), WrongPasswordError)
})

test('a tampered file does not open', async () => {
  const sealed = await sealSecret(secret(), 'correct horse', 'wallet_a')
  const bytes = Buffer.from(sealed.ciphertext, 'base64')
  bytes[0] ^= 1
  await assert.rejects(openSecret({ ...sealed, ciphertext: bytes.toString('base64') }, 'correct horse', 'wallet_a'), WrongPasswordError)
})
