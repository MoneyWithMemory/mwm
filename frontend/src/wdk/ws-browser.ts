// Browser stand-in for the optional `ws` package (aliased in vite.config.ts). WDK's
// Electrum WebSocket transport imports it only outside the browser, but Vite's dev
// pre-bundling still has to resolve the import.
export default globalThis.WebSocket
