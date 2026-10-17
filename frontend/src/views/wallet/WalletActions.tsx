import { ArrowLeftRight, QrCode, Store, type LucideIcon } from 'lucide-react'

interface WalletActionsProps {
  onReceive: () => void
  onTrade: () => void
  onSellerDesk: () => void
}

function Action({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
  return (
    <button type="button" className="group flex flex-col items-center gap-2" onClick={onClick}>
      <span className="pressable flex size-14 items-center justify-center rounded-full bg-accent text-on-accent">
        <Icon size={22} aria-hidden="true" />
      </span>
      <span className="badge-nowrap text-xs font-medium">{label}</span>
    </button>
  )
}

export function WalletActions({ onReceive, onTrade, onSellerDesk }: WalletActionsProps) {
  return (
    <div className="flex justify-around">
      <Action icon={QrCode} label="Receive" onClick={onReceive} />
      <Action icon={ArrowLeftRight} label="P2P Trade" onClick={onTrade} />
      <Action icon={Store} label="Seller Desk" onClick={onSellerDesk} />
    </div>
  )
}
