// Browser stand-in for sodium-universal (aliased in vite.config.ts). Tether WDK only
// calls sodium_memzero, to wipe private-key bytes; sodium-native is Node-only.
export function sodium_memzero(buffer: Uint8Array): void {
  buffer.fill(0)
}
