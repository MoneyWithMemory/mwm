import type { VaultPolicy } from './types'

/**
 * The Vault's Tether WDK policy, as the UI reads it from VaultState.policy (the Vault service
 * enforces it; the mock enforces the same rules). It governs what the Vault sends; anything may
 * arrive. Amounts are atomic units, keyed by ticker.
 */

/** The demo policy: the Vault service's defaults, and the mock's. */
export const DEMO_POLICY: Omit<VaultPolicy, 'used_today'> = {
  assets: ['USDT', 'PEPE'],
  max_per_move: { USDT: 5_000, PEPE: 1_000_000 },
  max_per_day: { USDT: 10_000, PEPE: 2_000_000 },
}

export const FOREIGN_INVOICE_MESSAGE = 'Vault policy: the Vault pays only the invoices it asks your Wallet for. To send to your Wallet, use Move.'

export type PolicyIssue = 'asset' | 'per_move' | 'per_day'

/** What is left of today's cap for `ticker`. */
export function leftToday(policy: VaultPolicy, ticker: string): number {
  return Math.max(0, (policy.max_per_day[ticker] ?? 0) - (policy.used_today[ticker] ?? 0))
}

/** Why the policy refuses sending `amount` of `ticker` now, or null when it allows it. */
export function policyIssue(policy: VaultPolicy, ticker: string, amount: number): PolicyIssue | null {
  if (!policy.assets.includes(ticker)) return 'asset'
  if (amount > (policy.max_per_move[ticker] ?? 0)) return 'per_move'
  if (amount > leftToday(policy, ticker)) return 'per_day'
  return null
}

/** The most the Vault can send of `ticker` right now: its balance, within both caps. */
export function sendableAmount(policy: VaultPolicy, ticker: string, balance: number): number {
  if (!policy.assets.includes(ticker)) return 0
  return Math.max(0, Math.min(balance, policy.max_per_move[ticker] ?? 0, leftToday(policy, ticker)))
}

/** The refusal in plain words. `format` turns an amount of `ticker` into text, e.g. "5,000 USDT". */
export function policyMessage(issue: PolicyIssue, policy: VaultPolicy, ticker: string, format: (amount: number) => string): string {
  switch (issue) {
    case 'asset':
      return `Vault policy: the Vault only moves ${policy.assets.join(' and ')}.`
    case 'per_move':
      return `Vault policy: at most ${format(policy.max_per_move[ticker] ?? 0)} per move.`
    case 'per_day': {
      const left = leftToday(policy, ticker)
      return left > 0
        ? `Vault policy: ${format(left)} left for today.`
        : `Vault policy: today's limit of ${format(policy.max_per_day[ticker] ?? 0)} is used up.`
    }
  }
}
