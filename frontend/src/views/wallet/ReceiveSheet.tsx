import { QRCodeSVG } from 'qrcode.react'
import { memo } from 'react'
import { CopyButton, Sheet } from '@/components/ui'

interface ReceiveSheetProps {
  open: boolean
  onClose: () => void
  address: string
}

/**
 * The wallet re-renders on every poll. Memoizing the QR keeps it from being recomputed
 * while the sheet animates or sits open: it only changes when the address does.
 */
const AddressQr = memo(function AddressQr({ value }: { value: string }) {
  return (
    <div className="rounded-card bg-white p-3">
      <QRCodeSVG value={value} size={176} />
    </div>
  )
})

export function ReceiveSheet({ open, onClose, address }: ReceiveSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Receive">
      <div className="flex flex-col items-center gap-4">
        <AddressQr value={address} />
        <div className="flex w-full items-center gap-2 rounded-control bg-surface-muted py-2 pr-2 pl-3">
          <span className="select-text min-w-0 flex-1 break-all text-xs">{address}</span>
          <CopyButton text={address} size="md" />
        </div>
        <p className="text-xs text-hint">Only send regtest assets to this address.</p>
      </div>
    </Sheet>
  )
}
