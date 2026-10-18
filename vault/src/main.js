// Entry point: `npm start` (Node 22, see README). Binds 127.0.0.1 only.
import { createBackendClient } from './backend.js'
import { loadConfig } from './config.js'
import { createRegtest } from './regtest.js'
import { createVaultServer } from './server.js'

const stamp = () => new Date().toISOString()
const log = {
  info: (message) => console.log(`${stamp()} ${message}`),
  warn: (message) => console.warn(`${stamp()} WARN ${message}`),
  error: (message) => console.error(`${stamp()} ERROR ${message}`)
}

// The rgb-lib binding is a native V8 addon built at install time; it builds on Node 22, not on Node 24+.
try {
  await import('@utexo/rgb-lib')
} catch (err) {
  log.error(`The RGB native library did not load on Node ${process.version} (${err.message}). ` +
    'Install and run the Vault with Node 22: see vault/README.md.')
  process.exit(1)
}

const { VaultService } = await import('./vault.js')
const config = loadConfig()
const service = new VaultService({
  config,
  regtest: createRegtest(config),
  backend: createBackendClient(config.backendUrl),
  log
})
const server = createVaultServer(service, { log })

server.listen(config.port, config.host, () => {
  log.info(`MwM Vault on http://${config.host}:${config.port} (Vaults in ${config.vaultDir}, backend ${config.backendUrl})`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // Locking wipes every unlocked Vault's seed from memory before exit.
    service.closeAll()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  })
}
