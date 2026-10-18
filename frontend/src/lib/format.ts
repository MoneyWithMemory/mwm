/** Display formatting. Amounts arrive as integers in atomic units (see AssetBalance.precision). */

const usdFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
const intFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const decimalFormats = new Map<number, Intl.NumberFormat>()

function decimalFormat(precision: number): Intl.NumberFormat {
  let format = decimalFormats.get(precision)
  if (!format) {
    format = new Intl.NumberFormat('en-US', { maximumFractionDigits: precision })
    decimalFormats.set(precision, format)
  }
  return format
}

/** 1234.5 → "$1,234.50" */
export function formatUsd(value: number): string {
  return usdFormat.format(value)
}

/** 2000000 → "2,000,000 sats" */
export function formatSats(sats: number): string {
  return `${intFormat.format(sats)} sats`
}

/** Uses the fixed demo rate from GET /api/market (sats_per_usd). */
export function satsToUsd(sats: number, satsPerUsd: number): number {
  return sats / satsPerUsd
}

/** Atomic units → display units: (150000000, 6, "USDT") → "150 USDT". */
export function formatAssetAmount(amount: number, precision: number, ticker?: string): string {
  const text = decimalFormat(precision).format(amount / 10 ** precision)
  return ticker ? `${text} ${ticker}` : text
}

const unitFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 6, minimumFractionDigits: 2 })

/** Price per display unit of a lot: (150, 1000000, 0) → "$0.00015"; null for an empty lot. */
export function formatUnitPrice(totalUsd: number, amount: number, precision: number): string | null {
  const units = amount / 10 ** precision
  return units > 0 ? unitFormat.format(totalUsd / units) : null
}

/** "bcrt1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" → "bcrt1q…0wlh" */
export function shortAddress(address: string, head = 6, tail = 4): string {
  if (address.length <= head + tail + 1) return address
  return `${address.slice(0, head)}…${address.slice(-tail)}`
}
