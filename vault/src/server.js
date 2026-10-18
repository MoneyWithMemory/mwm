// HTTP API of the Vault (see vault/README.md). JSON in and out; errors are {code, message} like the backend's.
import http from 'node:http'
import { invalidRequest, VaultError } from './errors.js'

const MAX_BODY_BYTES = 64 * 1024
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// POST /vault/{wallet_id}/{action} -> VaultService method.
const ACTIONS = {
  create: 'create',
  unlock: 'unlock',
  lock: 'lock',
  invoice: 'invoice',
  refresh: 'refresh',
  move_to_wallet: 'moveToWallet',
  send: 'send'
}

const methodNotAllowed = () => new VaultError(405, 'method_not_allowed', 'This method is not allowed here.')
const notFound = () => new VaultError(404, 'not_found', 'Not found.')
const forbidden = () => new VaultError(403, 'forbidden', 'The Vault only takes requests from the MwM app.')

function isLoopback (url) {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname)
  } catch {
    return false
  }
}

// Only this computer calls the Vault: a browser through the app's /vault proxy, with the app opened on this
// computer. A page from another site could still fire a "simple" POST at it (no preflight: the page cannot read
// the answer, but the action would run), and a DNS name rebound to 127.0.0.1 would pass for this computer. A
// browser names the page behind every POST in Origin, which no script can set; the backend and the scripts send none.
function checkCaller (req) {
  if (!isLoopback(`http://${req.headers.host}`)) throw forbidden()
  const { origin } = req.headers
  if (req.method !== 'GET' && origin !== undefined && !isLoopback(origin)) throw forbidden()
}

const isJson = (contentType) => contentType?.split(';')[0].trim().toLowerCase() === 'application/json'

// From another site, a JSON body needs a CORS preflight, which the Vault never grants. The bytes are zeroed
// once parsed: create's body holds the recovery phrase, unlock's the password.
export async function readJson (req) {
  const chunks = []
  let size = 0
  try {
    for await (const chunk of req) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new VaultError(413, 'body_too_large', 'The request is too large.')
      chunks.push(chunk)
    }
    if (size === 0) return {}
    if (!isJson(req.headers['content-type'])) throw new VaultError(415, 'unsupported_media_type', 'The request body must be JSON.')
    const raw = Buffer.concat(chunks)
    let body
    try {
      body = JSON.parse(raw.toString('utf8'))
    } catch {
      throw invalidRequest('The request body must be JSON.')
    } finally {
      raw.fill(0)
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw invalidRequest('The request body must be a JSON object.')
    return body
  } finally {
    for (const chunk of chunks) chunk.fill(0)
  }
}

async function route (service, req, pathname) {
  checkCaller(req)
  if (pathname === '/vault/health') {
    if (req.method !== 'GET') throw methodNotAllowed()
    return [200, { ok: true }]
  }
  const match = /^\/vault\/([^/]+)(?:\/([a-z_]+))?\/?$/.exec(pathname)
  if (!match) throw notFound()
  let walletId
  try {
    walletId = decodeURIComponent(match[1])
  } catch {
    throw invalidRequest('This wallet id is not valid.')
  }
  const action = match[2]
  if (action === undefined) {
    if (req.method !== 'GET') throw methodNotAllowed()
    return [200, await service.state(walletId)]
  }
  if (!Object.hasOwn(ACTIONS, action)) throw notFound()
  if (req.method !== 'POST') throw methodNotAllowed()
  const result = await service[ACTIONS[action]](walletId, await readJson(req))
  return [action === 'create' ? 201 : 200, result]
}

export function createVaultServer (service, { log }) {
  return http.createServer(async (req, res) => {
    const started = Date.now()
    const { pathname } = new URL(req.url, 'http://vault.local')
    let status
    let body
    try {
      [status, body] = await route(service, req, pathname)
    } catch (err) {
      if (err instanceof VaultError) {
        status = err.status
        body = { code: err.code, message: err.message }
      } else {
        log.error(`${req.method} ${pathname}: ${err?.stack ?? err}`)
        status = 500
        body = { code: 'internal_error', message: 'Something went wrong in the Vault. Try again in a moment.' }
      }
    }
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload) })
    res.end(payload)
    log.info(`${req.method} ${pathname} ${status} ${Date.now() - started}ms`)
  })
}
