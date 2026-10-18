import { Eye, EyeOff, ShieldAlert } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState, type ReactNode } from 'react'
import { useCreateWallet, type WalletSummary } from '@/api'
import { Button, CopyButton, IconButton, IconSwap, Input, Sheet, Tabs, TextArea, type TabItem } from '@/components/ui'
import { cn } from '@/lib/cn'
import { fade } from '@/lib/motion'
import { deriveAddress, generateSeed, normalizeSeed, validateSeed } from './wdk'

export type OnboardingMode = 'create' | 'import'
type Mode = OnboardingMode
type Step = 'phrase' | 'confirm' | 'finish'

const TABS: TabItem<Mode>[] = [
  { id: 'create', label: 'Create' },
  { id: 'import', label: 'Import' },
]

const CONFIRM_COUNT = 3
const DEFAULT_LABEL = 'WDK Wallet'
const WALLET_NOTICE = 'Regtest demo: the recovery phrase is sent to your local MwM backend to open the RGB wallet. Never use a real seed.'

/** Three distinct word positions (0-based, ascending) the user must type back. */
function pickPositions(total: number): number[] {
  const picked = new Set<number>()
  const random = new Uint32Array(1)
  while (picked.size < CONFIRM_COUNT) {
    crypto.getRandomValues(random)
    picked.add(random[0] % total)
  }
  return [...picked].sort((a, b) => a - b)
}

interface WdkOnboardingSheetProps {
  open: boolean
  onClose: () => void
  onCreated: (wallet: WalletSummary) => void
}

/**
 * "Create / Import Wallet via Tether WDK". The flow lives inside the sheet, so closing
 * it (or creating the wallet) unmounts the flow and drops the phrase from memory.
 * The phrase never goes to console, storage or the URL: only to POST /api/wallets/create.
 */
export function WdkOnboardingSheet({ open, onClose, onCreated }: WdkOnboardingSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Wallet via Tether WDK">
      <OnboardingFlow
        notice={WALLET_NOTICE}
        finish={({ seed, back }) => <FinishStep seed={seed} onBack={back} onCreated={onCreated} />}
      />
    </Sheet>
  )
}

export interface FinishControls {
  /** The confirmed (create) or validated (import) phrase. */
  seed: string
  back: () => void
  /** Drops the phrase from the flow's state, once it has been handed over. */
  wipe: () => void
}

interface OnboardingFlowProps {
  initialMode?: Mode
  /** Where the phrase goes, on top of every step. */
  notice: string
  /** The step after the phrase: what the phrase is for (a wallet name, the Vault's password). */
  finish: (controls: FinishControls) => ReactNode
}

/** Phrase by Tether WDK: generated in the browser and confirmed (three words), or imported and validated. */
export function OnboardingFlow({ initialMode = 'create', notice, finish }: OnboardingFlowProps) {
  const [mode, setMode] = useState<Mode>(initialMode)
  const [step, setStep] = useState<Step>('phrase')
  // Create: generated once per opening. Import: whatever the user pastes.
  const [generated, setGenerated] = useState(generateSeed)
  const [imported, setImported] = useState('')
  const seed = mode === 'create' ? generated : normalizeSeed(imported)

  const switchMode = (next: Mode) => {
    setMode(next)
    setStep('phrase')
  }

  const wipe = () => {
    setGenerated('')
    setImported('')
  }

  return (
    <div className="flex flex-col gap-4 pb-2">
      <RegtestBanner notice={notice} />
      <Tabs tabs={TABS} activeId={mode} onChange={switchMode} layoutId="wdk-mode" fullWidth />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div key={`${mode}:${step}`} variants={fade} initial="initial" animate="animate" exit="exit" className="flex flex-col gap-4">
          {mode === 'create' && step === 'phrase' && <RevealStep phrase={generated} onContinue={() => setStep('confirm')} />}
          {mode === 'create' && step === 'confirm' && (
            <ConfirmStep phrase={generated} onBack={() => setStep('phrase')} onContinue={() => setStep('finish')} />
          )}
          {mode === 'import' && step === 'phrase' && (
            <ImportStep value={imported} onChange={setImported} onContinue={() => setStep('finish')} />
          )}
          {step === 'finish' && finish({ seed, back: () => setStep(mode === 'create' ? 'confirm' : 'phrase'), wipe })}
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function RegtestBanner({ notice }: { notice: string }) {
  return (
    <div role="note" className="flex items-start gap-2.5 rounded-control border border-warning/25 bg-warning/10 p-3 text-xs leading-relaxed text-warning">
      <ShieldAlert size={16} className="mt-px shrink-0" aria-hidden="true" />
      <p>{notice}</p>
    </div>
  )
}

function RevealStep({ phrase, onContinue }: { phrase: string; onContinue: () => void }) {
  const [revealed, setRevealed] = useState(false)
  const [seen, setSeen] = useState(false)
  const words = phrase.split(' ')

  const toggle = () => {
    setRevealed((r) => !r)
    setSeen(true)
  }

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex flex-col">
          <p className="text-sm font-medium">Your recovery phrase</p>
          <p className="text-xs text-hint">Generated on this device by Tether WDK. Write it down in order.</p>
        </div>
        <IconButton variant="secondary" aria-label={revealed ? 'Hide recovery phrase' : 'Reveal recovery phrase'} onClick={toggle}>
          <IconSwap iconKey={revealed ? 'hide' : 'show'}>{revealed ? <EyeOff size={16} /> : <Eye size={16} />}</IconSwap>
        </IconButton>
      </div>

      <div className="relative">
        <ol
          aria-hidden={!revealed}
          className={cn(
            'grid grid-cols-3 gap-2 transition-[filter] duration-fast ease-smooth-out',
            revealed ? 'select-text' : 'pointer-events-none blur-[6px]',
          )}
        >
          {words.map((word, i) => (
            <li key={i} className="flex items-baseline gap-1.5 rounded-control bg-surface-muted px-2.5 py-2 text-sm">
              <span className="amount text-[11px] text-hint">{i + 1}</span>
              <span className="font-medium">{word}</span>
            </li>
          ))}
        </ol>
        {!revealed && (
          <div className="absolute inset-0 grid place-items-center">
            <Button variant="secondary" size="sm" onClick={toggle}>
              <Eye size={14} aria-hidden="true" />
              Reveal phrase
            </Button>
          </div>
        )}
      </div>

      <div className="flex min-h-8 items-center justify-between gap-3">
        <p className="text-xs text-hint">Anyone with these words controls these funds.</p>
        {revealed && <CopyButton text={phrase} label="Copy" copiedLabel="Copied" variant="button" size="sm" />}
      </div>

      <Button fullWidth trailingArrow disabled={!seen} onClick={onContinue}>
        I wrote it down
      </Button>
    </>
  )
}

function ConfirmStep({ phrase, onBack, onContinue }: { phrase: string; onBack: () => void; onContinue: () => void }) {
  const words = phrase.split(' ')
  const [positions] = useState(() => pickPositions(words.length))
  const [answers, setAnswers] = useState<string[]>(() => positions.map(() => ''))
  const [checked, setChecked] = useState(false)
  const wrong = positions.map((p, i) => answers[i].trim().toLowerCase() !== words[p])

  const submit = () => {
    setChecked(true)
    if (!wrong.some(Boolean)) onContinue()
  }

  return (
    <>
      <div className="flex flex-col">
        <p className="text-sm font-medium">Confirm your phrase</p>
        <p className="text-xs text-hint">Type the words at these positions.</p>
      </div>
      <form
        className="flex flex-col"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        {positions.map((p, i) => (
          <Input
            key={p}
            label={`Word #${p + 1}`}
            value={answers[i]}
            onChange={(event) => {
              const next = [...answers]
              next[i] = event.target.value
              setAnswers(next)
              setChecked(false)
            }}
            error={checked && wrong[i] ? `This is not word #${p + 1}` : undefined}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
        ))}
        <div className="mt-1 flex gap-2">
          <Button type="button" variant="secondary" onClick={onBack}>
            Back
          </Button>
          <Button type="submit" fullWidth trailingArrow disabled={answers.some((a) => !a.trim())}>
            Continue
          </Button>
        </div>
      </form>
    </>
  )
}

function ImportStep({ value, onChange, onContinue }: { value: string; onChange: (value: string) => void; onContinue: () => void }) {
  const [touched, setTouched] = useState(false)
  const count = value.trim() ? normalizeSeed(value).split(' ').length : 0
  const valid = validateSeed(value)
  // Judge only complete phrases (or after Continue), so typing never flashes an error.
  const showError = !valid && (touched || count === 12 || count === 24)

  return (
    <>
      <TextArea
        label="Recovery phrase"
        placeholder="12 or 24 words separated by spaces"
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        // One-line messages: the hint row reserves a single line, so nothing shifts.
        error={showError ? 'Not a valid BIP-39 recovery phrase' : undefined}
        hint={valid ? `Valid ${count}-word phrase, checked by Tether WDK` : `${count} words`}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
      />
      <Button
        fullWidth
        trailingArrow
        disabled={count === 0}
        onClick={() => {
          setTouched(true)
          if (valid) onContinue()
        }}
      >
        Continue
      </Button>
    </>
  )
}

function FinishStep({ seed, onBack, onCreated }: { seed: string; onBack: () => void; onCreated: (wallet: WalletSummary) => void }) {
  const [label, setLabel] = useState(DEFAULT_LABEL)
  const [address, setAddress] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    deriveAddress(seed).then(
      (derived) => {
        if (current) setAddress(derived)
      },
      () => {
        if (current) setAddress('')
      },
    )
    return () => {
      current = false
    }
  }, [seed])
  const createWallet = useCreateWallet()
  const trimmed = label.trim()

  const submit = async () => {
    try {
      onCreated(await createWallet.run({ label: trimmed, mnemonic: seed }))
    } catch {
      // createWallet.error drives the message below; the backend text is not shown,
      // so nothing derived from the phrase can surface in the UI.
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (trimmed && !createWallet.pending) void submit()
      }}
    >
      <div className="flex flex-col gap-1 rounded-control bg-surface-muted p-3">
        <p className="text-xs text-hint">Derived by Tether WDK · BIP-84 regtest, account 0</p>
        <p className={cn('min-h-5 break-all text-sm', address ? 'select-text font-medium' : 'text-hint')}>
          {address === null ? 'Deriving…' : address || 'Could not derive the address.'}
        </p>
      </div>
      <Input label="Wallet name" value={label} onChange={(event) => setLabel(event.target.value)} maxLength={32} autoComplete="off" />
      <div className="flex flex-col">
        <div className="flex gap-2">
          <Button type="button" variant="secondary" onClick={onBack} disabled={createWallet.pending}>
            Back
          </Button>
          <Button type="submit" fullWidth loading={createWallet.pending} disabled={!trimmed}>
            Create wallet
          </Button>
        </div>
        <p className="min-h-5 pt-1.5 text-xs text-danger" role="alert">
          {createWallet.error ? `The wallet was not created (${createWallet.error.code}). Check the backend and try again.` : ''}
        </p>
      </div>
    </form>
  )
}
