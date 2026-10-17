/**
 * Buying part of a desk's lot, priced as the backend does (api_server._lot_prices): the lot's
 * unit price times the amount, rounded half up. The whole lot keeps the desk's own price.
 */
export function proRataPrice(totalUsd: number, lotAmount: number, amount: number): number {
  if (lotAmount <= 0 || amount >= lotAmount) return totalUsd
  return Math.floor((totalUsd * amount) / lotAmount + 0.5)
}

/** Smallest part of a lot worth at least 1 USDT at its list price (atomic units). */
export function minLotAmount(totalUsd: number, lotAmount: number): number {
  return totalUsd > 0 ? Math.max(1, Math.ceil(lotAmount / totalUsd)) : lotAmount
}

export interface LimitTexts {
  target: string
  ceiling: string
}

/** A buyer's starting limits for a list price: target 80% and maximum 90% of it, within the balance. */
export function suggestedLimits(listPriceUsd: number, availableUsd: number): LimitTexts {
  const ceiling = Math.max(1, Math.min(Math.round(listPriceUsd * 0.9), Math.floor(availableUsd) || 1))
  return { ceiling: String(ceiling), target: String(Math.max(1, Math.min(Math.round(listPriceUsd * 0.8), ceiling))) }
}
