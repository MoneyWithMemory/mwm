import { Skeleton } from '@/components/ui'

/** Loading layout: same blocks and heights as the loaded view, so nothing jumps when data arrives. */
export function WalletSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-label="Loading wallet">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-11 w-48" />
      </div>
      <div className="flex justify-around">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col items-center gap-2">
            <Skeleton variant="circular" className="size-11" />
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>
      <Skeleton className="h-64 rounded-card" />
      <Skeleton className="h-32 rounded-card" />
      <Skeleton className="h-40 rounded-card" />
    </div>
  )
}
