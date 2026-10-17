import type { ReactNode } from 'react'

interface StateMessageProps {
  title: string
  body: string
  action?: ReactNode
}

/** Empty and error states. Stopgap until EmptyState/ErrorState land in components/ui. */
export function StateMessage({ title, body, action }: StateMessageProps) {
  return (
    <div className="flex flex-col items-start gap-1 rounded-card bg-surface p-4 shadow-card">
      <p className="text-sm font-semibold">{title}</p>
      <p className="text-sm text-hint">{body}</p>
      {action && <div className="pt-2">{action}</div>}
    </div>
  )
}
