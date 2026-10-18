import type { Role } from '@/api'

export type StrategyId = 'strict' | 'balanced' | 'flexible' | 'other'

export interface StrategyPreset {
  id: Exclude<StrategyId, 'other'>
  label: string
  /** What the owner reads under the picker. */
  description: string
  /** What the agent receives as its owner's strategy. Balanced is the agents' default: empty. */
  prompt: string
}

export const PROMPT_MAX_LENGTH = 500

export const STRATEGIES: Record<Role, StrategyPreset[]> = {
  seller: [
    {
      id: 'strict',
      label: 'Strict',
      description: 'Holds close to your asking price and gives ground slowly. Best price, fewer deals.',
      prompt: 'Strict: defend your list price. Concede only in small steps, and only after the buyer moves.',
    },
    {
      id: 'balanced',
      label: 'Balanced',
      description: 'Concedes steadily toward a fair middle as the buyer moves.',
      prompt: '',
    },
    {
      id: 'flexible',
      label: 'Flexible',
      description: 'Gives ground faster to close the deal.',
      prompt: 'Flexible: closing matters more than the last dollar. Concede in larger steps toward a reasonable buyer.',
    },
  ],
  buyer: [
    {
      id: 'strict',
      label: 'Strict',
      description: 'Opens low and raises in small steps. Best price, slower deals.',
      prompt: 'Strict: open low and raise only in small steps, and only after the seller moves.',
    },
    {
      id: 'balanced',
      label: 'Balanced',
      description: 'Raises steadily toward a fair middle as the seller moves.',
      prompt: '',
    },
    {
      id: 'flexible',
      label: 'Flexible',
      description: 'Raises faster to close the deal.',
      prompt: 'Flexible: closing matters more than the last dollar. Raise in larger steps toward a reasonable seller.',
    },
  ],
}

export const OTHER_DESCRIPTION = 'Your own words. Your agent follows them within your limits.'

/** The preset a saved strategy came from; any other text is the owner's own ("other"). */
export function strategyOf(role: Role, prompt: string): StrategyId {
  return STRATEGIES[role].find((s) => s.prompt === prompt.trim())?.id ?? 'other'
}
