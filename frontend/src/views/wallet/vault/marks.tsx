import { Lock, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** The Vault's emblem: a lock in a soft lavender circle. */
export function VaultMark({ className }: { className?: string }) {
  return (
    <span className={cn('grid size-14 shrink-0 place-items-center rounded-full bg-accent/15 text-accent shadow-glow-soft', className)} aria-hidden="true">
      <Lock size={24} />
    </span>
  )
}

/** The small line that credits Tether WDK, e.g. "Protected by Tether WDK policy". */
export function WdkNote({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn('flex items-center justify-center gap-1.5 text-[11px] font-medium text-hint', className)}>
      <ShieldCheck size={12} className="shrink-0 text-accent" aria-hidden="true" />
      {children}
    </p>
  )
}
