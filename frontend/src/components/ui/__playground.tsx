import { Bitcoin, Coins, Plus, RefreshCw, Send, Sparkles } from 'lucide-react'
import { useState } from 'react'
import type { CanonicalSwapTerms, SettlementStep } from '@/api/types'
import { AmountCountUp } from './AmountCountUp'
import { ApprovalCard } from './ApprovalCard'
import { AssetBadge } from './AssetBadge'
import { Avatar } from './Avatar'
import { Badge } from './Badge'
import { Button } from './Button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './Card'
import { Checkbox } from './Checkbox'
import { Chip } from './Chip'
import { CopyButton } from './CopyButton'
import { EmptyState } from './EmptyState'
import { ErrorState } from './ErrorState'
import { IconButton } from './IconButton'
import { IconSwap } from './IconSwap'
import { Input } from './Input'
import { Modal } from './Modal'
import { OverlayLayer } from './OverlayLayer'
import { SegmentedControl } from './SegmentedControl'
import { Sheet } from './Sheet'
import { Skeleton } from './Skeleton'
import { StepList } from './StepList'
import { Tabs } from './Tabs'
import { TextArea } from './TextArea'
import { ThinkingState } from './ThinkingState'
import { ToastProvider } from './Toast'
import { toast } from './toastStore'
import { Toggle } from './Toggle'
import { TrustBadge } from './TrustBadge'

const MOCK_TERMS: CanonicalSwapTerms = {
  session_id: 'session-demo-01',
  asset_id: 'rgb-pepe-sample-id-1234',
  rgb_amount: 1000000,
  payment_asset_id: 'rgb-usdt-sample-id-5678',
  payment_amount: 110,
  agreed_price_usd: 110,
  network_fee_sat: 2000,
  buyer_address: 'bcrt1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh',
  seller_address: 'bcrt1q7x4g82n044pt0z6484r59z5z70s8jpx08fsk9e',
  expiry_unix: Math.floor(Date.now() / 1000) + 3600,
}

const MOCK_STEPS: SettlementStep[] = [
  { index: 1, name: 'create_swap_offer', status: 'done' },
  { index: 2, name: 'accept_swap_offer', status: 'done' },
  { index: 3, name: 'accept_swap_request', status: 'done' },
  { index: 4, name: 'complete_swap_proposal', status: 'running' },
  { index: 5, name: 'process_swap_completion', status: 'pending' },
  { index: 6, name: 'broadcast_swap_completion', status: 'pending' },
  { index: 7, name: 'accept_swap_transfers', status: 'pending' },
]

export function UiPlayground() {
  const [modalOpen, setModalOpen] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [btnLoading, setBtnLoading] = useState(false)
  const [activeTab, setActiveTab] = useState<'wallet' | 'trade' | 'contacts'>('wallet')
  const [activeSegment, setActiveSegment] = useState<'all' | 'usdt' | 'pepe'>('all')
  const [toggleVal, setToggleVal] = useState(true)
  const [checkboxVal, setCheckboxVal] = useState(false)
  const [balance, setBalance] = useState(1250.75)
  const [inputVal, setInputVal] = useState('')
  const [hasInputError, setHasInputError] = useState(false)
  const [swapIconState, setSwapIconState] = useState(false)
  const [signedState, setSignedState] = useState(false)

  return (
    <ToastProvider>
      <OverlayLayer className="min-h-screen bg-bg p-4 sm:p-8 text-fg ui-shell">
        <div className="mx-auto max-w-xl space-y-8 pb-20">
          {/* Header */}
          <div className="border-b border-separator/40 pb-4">
            <div className="flex items-center justify-between">
              <div>
                <h1 className="text-xl font-bold tracking-tight text-fg">MwM UI Kit Playground</h1>
                <p className="text-xs text-hint mt-0.5">
                  Telegram-style components, motion tokens, zero layout shift.
                </p>
              </div>
              <Badge variant="accent">Dev Only</Badge>
            </div>
          </div>

          {/* Section: Buttons */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">Buttons & States</h2>
            <Card>
              <CardHeader>
                <CardTitle>Interactive Buttons</CardTitle>
                <CardDescription>Hover and pressed transitions via .pressable and motion tokens</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="primary" loading={btnLoading} trailingArrow>
                    Primary Action
                  </Button>
                  <Button variant="secondary" loading={btnLoading}>
                    Secondary
                  </Button>
                  <Button variant="ghost" loading={btnLoading}>
                    Ghost
                  </Button>
                  <Button variant="danger" loading={btnLoading}>
                    Danger
                  </Button>
                </div>

                <div className="flex items-center gap-3 pt-2 border-t border-separator/30">
                  <Button size="sm" variant="secondary" onClick={() => setBtnLoading((l) => !l)}>
                    Toggle Loading
                  </Button>
                  <span className="text-xs text-hint">Zero layout shift when morphing to spinner</span>
                </div>

                <div className="flex items-center gap-2 pt-2">
                  <IconButton aria-label="Add" variant="primary">
                    <Plus size={16} />
                  </IconButton>
                  <IconButton aria-label="Send" variant="secondary">
                    <Send size={15} />
                  </IconButton>
                  <IconButton aria-label="Bitcoin" variant="ghost">
                    <Bitcoin size={16} />
                  </IconButton>
                  <IconButton aria-label="Loading" loading variant="secondary">
                    <Coins size={16} />
                  </IconButton>
                </div>
              </CardContent>
            </Card>
          </section>

          {/* Section: AmountCountUp */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">
              AmountCountUp (Tabular Numbers)
            </h2>
            <Card className="p-4 flex items-center justify-between">
              <div>
                <span className="text-xs text-hint block mb-1">Total Estimated Balance</span>
                <AmountCountUp value={balance} prefix="$" decimals={2} className="text-2xl font-bold" />
              </div>
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="secondary" onClick={() => setBalance((b) => b + 150)}>
                  +$150
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setBalance((b) => Math.max(0, b - 100))}>
                  -$100
                </Button>
              </div>
            </Card>
          </section>

          {/* Section: Navigation (Tabs & SegmentedControl) */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">Tabs & Segmented Control</h2>
            <Card className="p-4 space-y-4">
              <div>
                <span className="text-xs text-hint block mb-2">Sliding Pill Tabs (SPRING_TABS)</span>
                <Tabs
                  activeId={activeTab}
                  onChange={setActiveTab}
                  tabs={[
                    { id: 'wallet', label: 'Wallet' },
                    { id: 'trade', label: 'P2P Trade', badge: 'Live' },
                    { id: 'contacts', label: 'Contacts' },
                  ]}
                  fullWidth
                />
              </div>

              <div>
                <span className="text-xs text-hint block mb-2">Segmented Control</span>
                <SegmentedControl
                  value={activeSegment}
                  onChange={setActiveSegment}
                  options={[
                    { value: 'all', label: 'Combined $' },
                    { value: 'usdt', label: 'USDT-RGB' },
                    { value: 'pepe', label: 'PEPE-RGB' },
                  ]}
                />
              </div>
            </Card>
          </section>

          {/* Section: Badges, Assets & Trust */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">Badges, Assets & Trust</h2>
            <Card className="p-4 space-y-4">
              <div>
                <span className="text-xs text-hint block mb-2">Official Asset Badges (Zero emoji)</span>
                <div className="flex flex-wrap items-center gap-3">
                  <AssetBadge ticker="BTC" asset_id="btc" showTicker />
                  <AssetBadge ticker="USDT" asset_id="rgb:usdt" showTicker />
                  <AssetBadge ticker="PEPE" asset_id="rgb:pepe" showTicker />
                  <AssetBadge ticker="MEME" asset_id="custom-seed-id" showTicker />
                </div>
              </div>

              <div>
                <span className="text-xs text-hint block mb-2">Trust Tiers (Layer-0 Memory Graph)</span>
                <div className="flex flex-wrap items-center gap-2">
                  <TrustBadge tier="High Authenticity" reliabilityPct={94} />
                  <TrustBadge tier="Ring Anomaly Detected" reliabilityPct={38} />
                  <TrustBadge tier="Unverified" />
                </div>
              </div>

              <div>
                <span className="text-xs text-hint block mb-2">Status Badges & Chips</span>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="accent">Active</Badge>
                  <Badge variant="success">Confirmed</Badge>
                  <Badge variant="warning">Pending</Badge>
                  <Badge variant="danger">Blocked</Badge>
                  <Chip active>Active Chip</Chip>
                  <Chip onRemove={() => toast.info('Removed chip')}>Removable</Chip>
                </div>
              </div>

              <div>
                <span className="text-xs text-hint block mb-2">Avatars (Deterministic Hue)</span>
                <div className="flex items-center gap-2">
                  <Avatar seed="wallet_a" label="Wallet A" />
                  <Avatar seed="wallet_b" label="Wallet B" />
                  <Avatar seed="wallet_sybil" label="Sybil" />
                  <Avatar seed="bcrt1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" />
                </div>
              </div>
            </Card>
          </section>

          {/* Section: Form Controls */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">Inputs & Form Controls</h2>
            <Card className="p-4 space-y-4">
              <Input
                label="Asking Price (USD)"
                placeholder="100.00"
                prefix="$"
                value={inputVal}
                onChange={(e) => setInputVal(e.target.value)}
                hint="Public price seen by all peer buyer agents"
                error={hasInputError ? 'Price must be greater than secret reserve' : undefined}
                shake={hasInputError}
              />

              <Button
                size="sm"
                variant="secondary"
                onClick={() => setHasInputError((err) => !err)}
              >
                {hasInputError ? 'Clear Input Error' : 'Trigger Error Shake'}
              </Button>

              <TextArea
                label="Agent Prompt Strategy"
                placeholder="Negotiate conservatively; start with a 15% discount..."
                hint="Never shared with counterparty. Stays on your local device."
              />

              <div className="pt-2 border-t border-separator/30 space-y-3">
                <Toggle
                  checked={toggleVal}
                  onChange={setToggleVal}
                  label="Seller Desk Active"
                  description="Accept incoming P2P negotiations automatically"
                />
                <Checkbox
                  checked={checkboxVal}
                  onChange={setCheckboxVal}
                  label="I understand signatures are executed on Bitcoin regtest"
                />
              </div>
            </Card>
          </section>

          {/* Section: Feedback & Transitions */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">
              Transitions & Micro-interactions
            </h2>
            <Card className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-medium text-fg block">IconSwap (2px blur + scale)</span>
                  <span className="text-xs text-hint">Click button to swap icons smoothly</span>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setSwapIconState((s) => !s)}
                  className="gap-2"
                >
                  <IconSwap iconKey={swapIconState ? 'sparkle' : 'refresh'}>
                    {swapIconState ? (
                      <Sparkles size={14} className="text-accent" />
                    ) : (
                      <RefreshCw size={14} className="text-hint" />
                    )}
                  </IconSwap>
                  <span>Swap Icon</span>
                </Button>
              </div>

              <div className="flex items-center justify-between pt-2 border-t border-separator/30">
                <div>
                  <span className="text-xs font-medium text-fg block">CopyButton</span>
                  <span className="text-xs text-hint font-mono">bcrt1qxy2kgdy…0wlh</span>
                </div>
                <div className="flex items-center gap-2">
                  <CopyButton text="bcrt1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" />
                  <CopyButton text="bcrt1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" variant="button" />
                </div>
              </div>

              <div className="pt-2 border-t border-separator/30">
                <span className="text-xs text-hint block mb-2">Toast Triggers</span>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={() => toast.info('New negotiation round incoming')}>
                    Info Toast
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => toast.success('Swap terms signed by both parties')}>
                    Success Toast
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => toast.error('Terms hash mismatch')}>
                    Error Toast
                  </Button>
                </div>
              </div>
            </Card>
          </section>

          {/* Section: AI Thinking State */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">
              QVAC AI Thinking State (12–30s)
            </h2>
            <ThinkingState
              statusText="Local QVAC agent reasoning…"
              detail="Analyzing round 2 seller offer of $110 against $120 budget ceiling"
              thoughts="The seller dropped the ask from $130 to $110. My ceiling is $120, so $110 is within acceptable range. I will propose $105 to test if they will meet in the middle."
            />
          </section>

          {/* Section: ApprovalCard */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">ApprovalCard (Terms Review)</h2>
            <ApprovalCard
              terms={MOCK_TERMS}
              termsHash="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
              assetTicker="PEPE"
              paymentTicker="USDT"
              myRole="buyer"
              mySigned={signedState}
              counterpartySigned={true}
              onSign={() => {
                setSignedState(true)
                toast.success('Terms signed successfully!')
              }}
              onCancel={() => {
                setSignedState(false)
                toast.info('Session cancelled')
              }}
            />
          </section>

          {/* Section: StepList */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">
              7-Step Atomic Settlement (StepList)
            </h2>
            <Card className="p-4">
              <StepList steps={MOCK_STEPS} />
            </Card>
          </section>

          {/* Section: Overlays (Modal & Sheet) */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">Overlays (Sheet & Modal)</h2>
            <Card className="p-4 flex items-center gap-3">
              <Button variant="secondary" onClick={() => setModalOpen(true)}>
                Open Modal (Center Scale)
              </Button>
              <Button variant="secondary" onClick={() => setSheetOpen(true)}>
                Open Bottom Sheet
              </Button>
            </Card>
          </section>

          {/* Section: Skeletons & Empty/Error States */}
          <section className="space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-hint">Loading, Empty & Error States</h2>
            <Card className="p-4 space-y-3">
              <div className="flex items-center gap-3">
                <Skeleton variant="circular" width={36} height={36} />
                <div className="space-y-1.5 flex-1">
                  <Skeleton variant="text" width="60%" />
                  <Skeleton variant="text" width="40%" />
                </div>
              </div>
              <Skeleton variant="rectangular" height={48} />
            </Card>

            <Card>
              <EmptyState
                title="No active sessions"
                description="Start a P2P negotiation with a peer wallet from your contacts."
                action={<Button size="sm" variant="primary">New Trade</Button>}
              />
            </Card>

            <Card>
              <ErrorState
                title="Connection failed"
                message="Cannot reach backend at 127.0.0.1:8000. Ensure the API server is active."
                onRetry={() => toast.info('Retrying connection…')}
              />
            </Card>
          </section>
        </div>

        {/* Modal instance */}
        <Modal open={modalOpen} onClose={() => setModalOpen(false)} title="Peer Review">
          <div className="space-y-3 text-xs text-hint leading-relaxed">
            <p>
              This is a centered modal dialog scaling from 0.96 with motion tokens. It handles
              focus traps, Escape key navigation, and portals cleanly to the local OverlayLayer.
            </p>
            <div className="pt-2 flex justify-end gap-2">
              <Button size="sm" variant="secondary" onClick={() => setModalOpen(false)}>
                Dismiss
              </Button>
              <Button size="sm" variant="primary" onClick={() => setModalOpen(false)}>
                Confirm
              </Button>
            </div>
          </div>
        </Modal>

        {/* Sheet instance */}
        <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} title="Receive RGB Assets">
          <div className="space-y-3 text-xs text-hint leading-relaxed">
            <p>
              Mobile bottom sheet rising from origin-bottom with 250ms open and 150ms close asymmetry.
            </p>
            <div className="p-3 bg-surface-muted rounded-control font-mono select-text text-fg">
              bcrt1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh
            </div>
            <Button fullWidth variant="primary" onClick={() => setSheetOpen(false)}>
              Done
            </Button>
          </div>
        </Sheet>
      </OverlayLayer>
    </ToastProvider>
  )
}
