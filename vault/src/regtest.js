// Demo-only plumbing for the local regtest chain, through the repo's scripts/regtest.sh: fees for a new Vault
// and the block that confirms a move. On a real network the user funds fees and miners confirm.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { VaultError } from './errors.js'

const run = promisify(execFile)
const TIMEOUT_MS = 120_000
// The indexer needs a moment to see a fresh block before rgb-lib syncs against it.
const INDEXER_SETTLE_MS = 500

export function createRegtest ({ regtestScript, composeProject }) {
  const env = composeProject ? { ...process.env, COMPOSE_PROJECT_NAME: composeProject } : process.env

  async function call (...args) {
    try {
      const { stdout } = await run(regtestScript, args, { env, timeout: TIMEOUT_MS })
      return stdout.trim()
    } catch {
      throw new VaultError(503, 'network_unavailable', 'The Bitcoin test network is not reachable right now. Try again in a moment.')
    }
  }

  return {
    async mine (blocks = 1) {
      await call('mine', String(blocks))
      await new Promise((resolve) => setTimeout(resolve, INDEXER_SETTLE_MS))
    },
    fund: (address, btc) => call('sendtoaddress', address, btc)
  }
}
