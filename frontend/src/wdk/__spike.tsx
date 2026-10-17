import { useEffect, useState } from 'react'
import { deriveAddress, generateSeed, validateSeed } from './wdk'

type SpikeResult =
  | { ok: true; words: number; valid: boolean; address: string; ms: number }
  | { ok: false; error: string }

/** Dev-only check (/#wdk) that Tether WDK runs in this browser. Never renders the phrase. */
export function WdkSpike() {
  const [result, setResult] = useState<SpikeResult | null>(null)

  useEffect(() => {
    const started = performance.now()
    Promise.resolve()
      .then(async () => {
        const seed = generateSeed()
        const address = await deriveAddress(seed)
        return { ok: true as const, words: seed.split(' ').length, valid: validateSeed(seed), address, ms: Math.round(performance.now() - started) }
      })
      .catch((error: unknown) => ({ ok: false as const, error: String(error) }))
      .then((next) => {
        document.title = next.ok ? 'WDK OK' : 'WDK FAIL'
        setResult(next)
      })
  }, [])

  return (
    <main className="mx-auto flex max-w-[480px] flex-col gap-3 p-4 text-sm text-fg">
      <h1 className="text-base font-semibold">Tether WDK browser spike</h1>
      {!result && <p className="text-hint">Running…</p>}
      {result?.ok === true && (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-card bg-surface p-3 shadow-card">
          <dt className="text-hint">Seed</dt>
          <dd>{result.words} words, valid: {String(result.valid)}</dd>
          <dt className="text-hint">Address</dt>
          <dd className="select-text break-all">{result.address}</dd>
          <dt className="text-hint">Time</dt>
          <dd>{result.ms} ms</dd>
        </dl>
      )}
      {result?.ok === false && <p className="select-text text-danger">{result.error}</p>}
    </main>
  )
}
