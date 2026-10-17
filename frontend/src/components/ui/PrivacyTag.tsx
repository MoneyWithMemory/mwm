import { Eye, Lock } from 'lucide-react'
import { cn } from '@/lib/cn'

export interface PrivacyTagProps {
  /** public: every buyer sees it. private: it stays with this device's agent. */
  kind: 'public' | 'private'
  className?: string
}

/** Tiny label next to a field: who can see the value, instead of a sentence of hint text. */
export function PrivacyTag({ kind, className }: PrivacyTagProps) {
  const Icon = kind === 'public' ? Eye : Lock
  return (
    <span
      className={cn(
        'badge-nowrap inline-flex items-center gap-1 rounded-full bg-surface-raised/70 px-1.5 py-0.5 text-[10px] font-medium leading-none text-hint select-none',
        className,
      )}
    >
      <Icon size={10} aria-hidden="true" />
      {kind === 'public' ? 'Public' : 'Private'}
    </span>
  )
}
