import { Check, ChevronDown, Plus } from 'lucide-react'
import { motion } from 'motion/react'
import { lazy, Suspense, useState } from 'react'
import { useWallets, type WalletId, type WalletSummary } from '@/api'
import { Avatar } from '@/components/ui/Avatar'
import { Sheet } from '@/components/ui/Sheet'
import { toast } from '@/components/ui/toastStore'
import { cn } from '@/lib/cn'
import { shortAddress } from '@/lib/format'
import { SPRING_SNAPPY } from '@/lib/motion'
import { loadWdkOnboarding } from '@/wdk'

const WdkOnboardingSheet = lazy(() => loadWdkOnboarding().then((m) => ({ default: m.WdkOnboardingSheet })))

interface WalletSwitcherProps {
  walletId: WalletId
  onSelect: (walletId: WalletId) => void
}

/** Header trigger with the active wallet; opens a sheet listing every wallet, plus the WDK onboarding. */
export function WalletSwitcher({ walletId, onSelect }: WalletSwitcherProps) {
  const [open, setOpen] = useState(false)
  const [wdkOpen, setWdkOpen] = useState(false)
  // The WDK chunk is fetched on first use only (hover or focus on the entry warms it up).
  const [wdkRequested, setWdkRequested] = useState(false)
  const wallets = useWallets()
  const active = wallets.data?.find((w) => w.wallet_id === walletId)

  const openWdk = () => {
    setOpen(false)
    setWdkRequested(true)
    setWdkOpen(true)
  }

  const onCreated = (wallet: WalletSummary) => {
    setWdkOpen(false)
    onSelect(wallet.wallet_id)
    toast.success('Wallet created', `${wallet.label} is now active.`)
  }

  return (
    <>
      <button
        type="button"
        className="pressable pressable-flat flex min-w-0 items-center gap-2 rounded-control px-1.5 py-1"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Avatar seed={active?.address ?? walletId} label={active?.label} size="sm" />
        <span className="flex min-w-0 flex-col items-start leading-tight">
          <span className="badge-nowrap text-sm font-semibold">{active?.label ?? 'Wallet'}</span>
          <span className="badge-nowrap text-[11px] text-hint">{active ? shortAddress(active.address) : ' '}</span>
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={SPRING_SNAPPY} className="text-hint" aria-hidden="true">
          <ChevronDown size={16} />
        </motion.span>
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Wallets">
        {wallets.loading && (
          <div className="flex flex-col gap-2" aria-busy="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-card bg-surface-muted" />
            ))}
          </div>
        )}
        {!wallets.data && wallets.error && (
          <div className="flex flex-col items-start gap-3 py-2">
            <p className="text-sm text-hint">Wallets are unavailable right now.</p>
            <button type="button" className="pressable rounded-control bg-surface-muted px-3 py-2 text-sm font-medium" onClick={wallets.refresh}>
              Retry
            </button>
          </div>
        )}
        {wallets.data && (
          <ul className="flex flex-col gap-1">
            {wallets.data.map((w) => {
              const selected = w.wallet_id === walletId
              return (
                <li key={w.wallet_id}>
                  <button
                    type="button"
                    className={cn(
                      'pressable pressable-flat flex w-full items-center gap-3 rounded-card px-3 py-2.5 text-left',
                      selected && 'bg-surface-muted',
                    )}
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => {
                      onSelect(w.wallet_id)
                      setOpen(false)
                    }}
                  >
                    <Avatar seed={w.address} label={w.label} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium">{w.label}</span>
                      <span className="badge-nowrap text-xs text-hint">{shortAddress(w.address)}</span>
                    </span>
                    {selected && <Check size={18} className="text-accent" aria-hidden="true" />}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        <button
          type="button"
          className="pressable pressable-flat mt-2 flex w-full items-center gap-3 rounded-card border border-dashed border-separator px-3 py-2.5 text-left text-accent"
          onClick={openWdk}
          onPointerEnter={() => void loadWdkOnboarding()}
          onFocus={() => void loadWdkOnboarding()}
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-full bg-accent/10" aria-hidden="true">
            <Plus size={18} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">Create / Import Wallet via Tether WDK</span>
            <span className="text-xs text-hint">Regtest only</span>
          </span>
        </button>
      </Sheet>

      {wdkRequested && (
        <Suspense fallback={null}>
          <WdkOnboardingSheet open={wdkOpen} onClose={() => setWdkOpen(false)} onCreated={onCreated} />
        </Suspense>
      )}
    </>
  )
}
