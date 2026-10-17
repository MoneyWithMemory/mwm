function Bar({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-control bg-surface-muted ${className}`} />
}

/** Loading layout: same blocks and heights as the loaded view, so nothing jumps when data arrives. */
export function WalletSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-label="Loading wallet">
      <div className="flex flex-col gap-2">
        <Bar className="h-4 w-20" />
        <Bar className="h-11 w-48" />
      </div>
      <div className="flex justify-around">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col items-center gap-2">
            <Bar className="size-14 rounded-full!" />
            <Bar className="h-3 w-14" />
          </div>
        ))}
      </div>
      <Bar className="h-40 w-full rounded-card!" />
      <Bar className="h-32 w-full rounded-card!" />
      <Bar className="h-40 w-full rounded-card!" />
    </div>
  )
}
