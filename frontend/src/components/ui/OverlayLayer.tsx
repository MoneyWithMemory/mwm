import { useState, type HTMLAttributes } from 'react'
import { cn } from '@/lib/cn'
import { OverlayRootContext } from '@/lib/overlay'

/**
 * Positioned container with an overlay host on top: <Sheet> and other overlays
 * rendered anywhere inside portal into it, so ancestors with transform or filter
 * (page transitions, .pressable) never clip or scroll them.
 */
export function OverlayLayer({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null)

  return (
    <div className={cn('relative', className)} {...rest}>
      <OverlayRootContext.Provider value={root}>{children}</OverlayRootContext.Provider>
      <div ref={setRoot} className="pointer-events-none absolute inset-0 z-40 overflow-hidden *:pointer-events-auto" />
    </div>
  )
}
