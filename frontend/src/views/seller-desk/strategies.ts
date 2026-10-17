export const STRATEGIES = [
  { id: 'firm', label: 'Firm', prompt: 'Hold close to the asking price and concede slowly.' },
  { id: 'balanced', label: 'Balanced', prompt: 'Meet in the middle when the buyer is reasonable.' },
  { id: 'flexible', label: 'Flexible', prompt: 'Prefer closing quickly over squeezing the price.' },
] as const

export const PROMPT_MAX_LENGTH = 500
