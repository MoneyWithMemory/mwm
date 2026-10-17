import type { CSSProperties } from 'react'
import { cn } from '@/lib/cn'

const SIZES = {
  sm: 'size-7 text-[11px]',
  md: 'size-9 text-xs',
  lg: 'size-11 text-sm',
} as const

/** Stable hue (0–359) from a seed such as an address or wallet id. */
function hueFor(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0
  return hash % 360
}

/** "Wallet A" → "WA", "Sybil" → "SY"; no label → last two characters of the seed. */
function initialsFor(label: string | undefined, seed: string): string {
  const words = label?.trim().split(/\s+/).filter(Boolean) ?? []
  if (words.length === 0) return seed.slice(-2).toUpperCase()
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

interface AvatarProps {
  /** Address or wallet id: drives the color, so the same counterparty always looks the same. */
  seed: string
  label?: string
  size?: keyof typeof SIZES
  className?: string
}

export function Avatar({ seed, label, size = 'md', className }: AvatarProps) {
  const style = { '--avatar-hue': hueFor(seed) } as CSSProperties

  return (
    <span
      className={cn('avatar inline-flex shrink-0 items-center justify-center rounded-full font-semibold', SIZES[size], className)}
      style={style}
      aria-hidden="true"
    >
      {initialsFor(label, seed)}
    </span>
  )
}
