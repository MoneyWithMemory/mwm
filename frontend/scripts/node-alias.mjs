// Lets Node load the app's modules for `npm test`: '@/x' resolves to src/x.ts, as Vite's alias
// does, and so does an extensionless relative import inside src (Node runs the TypeScript itself).
// Loaded with `node --import ./scripts/node-alias.mjs`.
import { registerHooks } from 'node:module'

const SRC = new URL('../src/', import.meta.url)
const HAS_EXTENSION = /\.[cm]?[jt]sx?$/

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) return nextResolve(new URL(`${specifier.slice(2)}.ts`, SRC).href, context)
    if (specifier.startsWith('.') && !HAS_EXTENSION.test(specifier) && context.parentURL?.startsWith(SRC.href)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})
