import os from 'node:os'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')

export function loadConfig (env = process.env) {
  return {
    host: '127.0.0.1',
    port: Number(env.VAULT_PORT || 8200),
    vaultDir: env.MWM_VAULT_DIR || path.join(os.homedir(), '.mwm', 'vault'),
    backendUrl: (env.BACKEND_URL || 'http://127.0.0.1:8000').replace(/\/+$/, ''),
    network: 'regtest',
    indexerUrl: env.VAULT_INDEXER_URL || 'tcp://127.0.0.1:50001',
    transportEndpoint: env.VAULT_TRANSPORT_ENDPOINT || 'rpc://127.0.0.1:3000/json-rpc',
    regtestScript: env.REGTEST_SCRIPT || path.join(REPO_ROOT, 'scripts', 'regtest.sh'),
    // Unset, Compose names the project after the repo folder, as for scripts/regtest.sh everywhere else.
    // Set it only when the Vault runs from another checkout than the one that started the chain.
    composeProject: env.COMPOSE_PROJECT_NAME || null
  }
}
