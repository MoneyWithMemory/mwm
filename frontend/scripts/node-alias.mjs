// Lets Node load the app's modules for `npm test`: '@/x' resolves to src/x.ts, as Vite's alias
// does (Node runs the TypeScript itself). Loaded with `node --import ./scripts/node-alias.mjs`.
import { registerHooks } from 'node:module'

const SRC = new URL('../src/', import.meta.url)

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) return nextResolve(new URL(`${specifier.slice(2)}.ts`, SRC).href, context)
    return nextResolve(specifier, context)
  },
})
