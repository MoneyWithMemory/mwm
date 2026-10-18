// The recovery phrase at rest: scrypt derives a key from the user's password, AES-256-GCM seals the phrase.
// The wallet id is bound as additional authenticated data, so a sealed file only opens for its own Vault.
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto'

const KDF = { N: 2 ** 15, r: 8, p: 1 }
const KEY_BYTES = 32
// scrypt needs 128 * N * r bytes; Node's default ceiling (32 MiB) is exactly that, so give it headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024

export class WrongPasswordError extends Error {
  constructor () {
    super('Wrong password.')
    this.name = 'WrongPasswordError'
  }
}

function deriveKey (password, salt, { N, r, p }) {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM }, (err, key) => err ? reject(err) : resolve(key))
  })
}

const aadFor = (walletId) => Buffer.from(`mwm-vault:v1:${walletId}`, 'utf8')

export async function sealSecret (secret, password, walletId) {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(password, salt, KDF)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(aadFor(walletId))
    const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()])
    return {
      v: 1,
      kdf: 'scrypt',
      ...KDF,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64')
    }
  } finally {
    key.fill(0)
  }
}

// Returns the secret as a Buffer the caller zeroes once used. A wrong password and a tampered file look
// the same to GCM, and both mean the Vault cannot be opened with this password.
export async function openSecret (sealed, password, walletId) {
  if (sealed?.v !== 1 || sealed.kdf !== 'scrypt') throw new Error('Unsupported Vault file format.')
  const key = await deriveKey(password, Buffer.from(sealed.salt, 'base64'), sealed)
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'))
    decipher.setAAD(aadFor(walletId))
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    const opened = decipher.update(Buffer.from(sealed.ciphertext, 'base64'))
    try {
      return Buffer.concat([opened, decipher.final()])
    } finally {
      opened.fill(0)
    }
  } catch {
    throw new WrongPasswordError()
  } finally {
    key.fill(0)
  }
}
