import { ArrowDownUp, Lock, ShieldCheck } from 'lucide-react'
import { AnimatePresence, motion, useAnimate } from 'motion/react'
import { lazy, Suspense, useState, type FormEvent } from 'react'
import type { ActivityItem, Market, WalletId, WalletState } from '@/api'
import { ActionButton, AmountCountUp, AssetBadge, Button, Card, ErrorState, Input, Skeleton, toast } from '@/components/ui'
import { formatAssetAmount, formatSats, formatUsd } from '@/lib/format'
import { SHAKE_TRANSITION, SHAKE_X, viewSwap } from '@/lib/motion'
import { leftToday, useLockVault, useUnlockVault, vaultErrorText, type MoveDirection, type VaultPoll, type VaultPolicy, type VaultState } from '@/vault'
import { loadVaultOnboarding } from '@/wdk'
import type { OnboardingMode } from '@/wdk/WdkOnboardingSheet'
import { ActivityList } from '../ActivityList'
import { partAssets, vaultValueUsd, type PartAsset } from './assets'
import { VaultMark, WdkNote } from './marks'

// Tether WDK is a lazy chunk: it loads when the user starts creating or importing a Vault.
const VaultOnboardingSheet = lazy(() => loadVaultOnboarding().then((m) => ({ default: m.VaultOnboardingSheet })))

interface VaultPartProps {
  walletId: WalletId
  vault: VaultPoll
  wallet: WalletState | undefined
  market: Market | undefined
  onMove: (direction: MoveDirection) => void
  onRename: (address: string) => void
}

type View = 'loading' | 'error' | 'missing' | 'locked' | 'unlocked'

/** The self-custodial part of the account: create it, unlock it, or see and move what it holds. */
export function VaultPart({ walletId, vault, wallet, market, onMove, onRename }: VaultPartProps) {
  const [onboarding, setOnboarding] = useState<{ mode: OnboardingMode; open: boolean } | null>(null)
  const state = vault.data
  const view: View = !state ? (vault.error ? 'error' : 'loading') : !state.exists ? 'missing' : state.unlocked ? 'unlocked' : 'locked'

  const closeOnboarding = () => setOnboarding((o) => o && { ...o, open: false })
  // The open Vault taking the card's place is the confirmation: no toast over the next sheet.
  const created = (next: VaultState) => {
    closeOnboarding()
    vault.accept(next)
  }

  return (
    <>
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={view} variants={viewSwap} initial="initial" animate="animate" exit="exit">
          {view === 'loading' && <VaultSkeleton />}
          {view === 'error' && vault.error && (
            <ErrorState icon={Lock} title="Vault unavailable" message={vaultErrorText(vault.error)} onRetry={vault.refresh} />
          )}
          {view === 'missing' && <CreateCard onStart={(mode) => setOnboarding({ mode, open: true })} />}
          {view === 'locked' && <UnlockCard walletId={walletId} onUnlocked={vault.accept} />}
          {view === 'unlocked' && state && (
            <UnlockedVault
              walletId={walletId}
              state={state}
              wallet={wallet}
              market={market}
              onMove={onMove}
              onRename={onRename}
              onLocked={vault.accept}
            />
          )}
        </motion.div>
      </AnimatePresence>
      {onboarding && (
        <Suspense fallback={null}>
          <VaultOnboardingSheet
            open={onboarding.open}
            mode={onboarding.mode}
            walletId={walletId}
            walletAddress={wallet?.address}
            onClose={closeOnboarding}
            onCreated={created}
          />
        </Suspense>
      )}
    </>
  )
}

function VaultSkeleton() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-label="Loading Vault">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-11 w-40" />
        <Skeleton className="h-3 w-56" />
      </div>
      <Skeleton className="h-36 rounded-card" />
    </div>
  )
}

function CreateCard({ onStart }: { onStart: (mode: OnboardingMode) => void }) {
  const warm = () => void loadVaultOnboarding()
  return (
    <Card className="flex flex-col items-center gap-5 px-5 pt-8 pb-5 text-center @4xl:max-w-md">
      <VaultMark />
      <div className="flex flex-col gap-1.5">
        <h2 className="text-lg font-semibold tracking-tight">Your Vault</h2>
        <p className="max-w-72 text-sm text-hint">Only you hold its keys. Your agents can't see or spend it.</p>
      </div>
      <div className="grid w-full max-w-sm grid-cols-2 gap-2" onPointerEnter={warm} onFocus={warm}>
        <Button onClick={() => onStart('create')}>Create</Button>
        <Button variant="secondary" onClick={() => onStart('import')}>
          Import
        </Button>
      </div>
      <WdkNote>Self-custody by Tether WDK</WdkNote>
    </Card>
  )
}

function UnlockCard({ walletId, onUnlocked }: { walletId: WalletId; onUnlocked: (state: VaultState) => void }) {
  const [password, setPassword] = useState('')
  const unlock = useUnlockVault()
  const [scope, animate] = useAnimate<HTMLDivElement>()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!password || unlock.pending) return
    unlock.run(walletId, password).then(onUnlocked, () => {
      // The whole block shakes once while the field turns red.
      void animate(scope.current, { x: SHAKE_X }, SHAKE_TRANSITION)
    })
  }

  return (
    <div ref={scope} className="@4xl:max-w-md">
      <Card className="flex flex-col items-center gap-5 px-5 pt-8 pb-5 text-center">
        <VaultMark />
        <h2 className="text-lg font-semibold tracking-tight">Vault locked</h2>
        <form className="flex w-full max-w-sm flex-col gap-1" onSubmit={submit}>
          <Input
            type="password"
            aria-label="Password"
            placeholder="Password"
            value={password}
            onChange={(event) => {
              setPassword(event.target.value)
              unlock.reset()
            }}
            error={unlock.error ? vaultErrorText(unlock.error) : undefined}
            shakeWithGroup
            autoComplete="current-password"
          />
          <Button type="submit" fullWidth loading={unlock.pending} disabled={!password}>
            Unlock
          </Button>
        </form>
      </Card>
    </div>
  )
}

interface UnlockedVaultProps extends Omit<VaultPartProps, 'vault'> {
  state: VaultState
  onLocked: (state: VaultState) => void
}

function UnlockedVault({ walletId, state, wallet, market, onMove, onRename, onLocked }: UnlockedVaultProps) {
  const lock = useLockVault()
  const assets = partAssets(state, wallet?.assets ?? [], market)
  const moves: ActivityItem[] = (wallet?.activity ?? []).filter((item) => item.kind === 'vault')

  const lockNow = () => {
    lock.run(walletId).then(onLocked, (err) => toast.error("Couldn't lock the Vault", vaultErrorText(err)))
  }

  return (
    <div className="flex flex-col gap-5 @4xl:grid @4xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] @4xl:items-start @4xl:gap-6">
      <div className="flex min-w-0 flex-col gap-5">
        <header className="flex flex-col gap-1">
          <p className="text-sm text-hint">Vault</p>
          <p className="text-hero">
            {market ? <AmountCountUp value={vaultValueUsd(assets, market)} prefix="$" /> : <span className="amount text-hint">—</span>}
          </p>
          <p className="flex items-center gap-1.5 text-xs text-hint">
            <Lock size={12} className="shrink-0 text-accent" aria-hidden="true" />
            Your agents can't see or spend the Vault.
          </p>
        </header>
        <div className="flex gap-5">
          <ActionButton variant="primary" icon={<ArrowDownUp size={22} />} label="Move" onClick={() => onMove('to_vault')} />
          <ActionButton icon={<Lock size={20} />} label="Lock" onClick={lockNow} disabled={lock.pending} />
        </div>
        <VaultAssets assets={assets} market={market} btcSats={state.btc_sats} />
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        <PolicyCard policy={state.policy} assets={assets} />
        {moves.length > 0 && wallet && (
          <ActivityList title="Moves" perspective="vault" items={moves} aliases={wallet.local_aliases} onRename={onRename} />
        )}
      </div>
    </div>
  )
}

function VaultAssets({ assets, market, btcSats }: { assets: PartAsset[]; market: Market | undefined; btcSats: number | null }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Vault assets">
      <h2 className="px-1 text-sm font-semibold text-hint">Assets</h2>
      <ul className="flex flex-col divide-y divide-separator rounded-card bg-surface shadow-card">
        {assets.map((asset) => {
          const price = market?.assets.find((p) => p.asset_id === asset.asset_id)?.price_usd ?? null
          return (
            <li key={asset.asset_id} className="flex items-center gap-3 p-3">
              <AssetBadge ticker={asset.ticker} asset_id={asset.asset_id} size="lg" />
              <span className="badge-nowrap min-w-0 flex-1 text-sm font-semibold">{asset.ticker}</span>
              <div className="flex flex-col items-end">
                <span className="amount text-base font-semibold">{formatAssetAmount(asset.vault, asset.precision, asset.ticker)}</span>
                <span className="amount text-xs text-hint">
                  {asset.pending > 0
                    ? `+${formatAssetAmount(asset.pending, asset.precision)} arriving`
                    : price === null
                      ? 'No price yet'
                      : formatUsd((asset.vault / 10 ** asset.precision) * price)}
                </span>
              </div>
            </li>
          )
        })}
      </ul>
      {btcSats !== null && <p className="amount px-1 text-xs text-hint">{formatSats(btcSats)} for fees</p>}
    </section>
  )
}

/** The rules the Vault's Tether WDK policy enforces on every send, in one glance. */
function PolicyCard({ policy, assets }: { policy: VaultPolicy; assets: PartAsset[] }) {
  return (
    <section className="flex flex-col gap-2" aria-label="Vault policy">
      <h2 className="flex items-center gap-1.5 px-1 text-sm font-semibold text-hint">
        <ShieldCheck size={14} className="text-accent" aria-hidden="true" />
        Tether WDK policy
      </h2>
      <ul className="flex flex-col divide-y divide-separator rounded-card bg-surface text-sm shadow-card">
        <li className="p-3 font-medium">Sends only to your own wallet</li>
        {assets.map((asset) => {
          const format = (amount: number) => formatAssetAmount(amount, asset.precision)
          return (
            <li key={asset.asset_id} className="flex items-baseline justify-between gap-3 p-3">
              <span className="font-medium">{asset.ticker}</span>
              <span className="amount truncate text-xs text-hint">
                {format(policy.max_per_move[asset.ticker] ?? 0)} a move · {format(leftToday(policy, asset.ticker))} left today
              </span>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
