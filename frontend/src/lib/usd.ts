/**
 * Prices are whole US dollars end to end: the demo USDT has no decimals and the swap settles
 * whole units (backend/config.py PAYMENT_ASSET_PRECISION = 0).
 */
export const WHOLE_USD_ERROR = 'Whole dollars only.'

export interface TypedUsd {
  /** The price in whole dollars; null when the field is empty or not a whole number. */
  value: number | null
  /** A decimal separator was typed: the field shows WHOLE_USD_ERROR. */
  cents: boolean
}

/** A price as typed in a USD field: digits only, a dot or comma means cents. */
export function parseUsd(text: string): TypedUsd {
  const value = text.trim()
  if (/^\d+$/.test(value)) return { value: Number(value), cents: false }
  return { value: null, cents: /^\d*[.,][\d.,]*$/.test(value) }
}
