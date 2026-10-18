import { CopyButton } from '@/components/ui'

/** The swap transaction id, copyable. Shown from step 6 on: once broadcast, it is the proof to check. */
export function TxidRow({ txid, label = 'Transaction ID' }: { txid: string; label?: string }) {
  return (
    <div className="flex w-full items-center gap-2 rounded-control bg-surface-muted py-1.5 pr-1.5 pl-3 text-left">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-[11px] text-hint">{label}</span>
        <span className="select-text break-all font-mono text-xs">{txid}</span>
      </span>
      <CopyButton text={txid} size="md" />
    </div>
  )
}
