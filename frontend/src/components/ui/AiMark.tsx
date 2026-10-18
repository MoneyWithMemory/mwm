import { cn } from '@/lib/cn'

export interface AiMarkProps {
  /** Diameter in px. */
  size?: number
  /** Turns faster while the local AI is working. */
  thinking?: boolean
  className?: string
}

/** The local AI's mark: a small turning orb (.ai-orb in index.css). Decorative. */
export function AiMark({ size = 24, thinking = false, className }: AiMarkProps) {
  return <span className={cn('ai-orb', className)} data-thinking={thinking} style={{ width: size, height: size }} aria-hidden="true" />
}
