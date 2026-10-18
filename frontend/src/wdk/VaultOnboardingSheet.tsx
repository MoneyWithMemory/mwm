import { Eye, EyeOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { WalletId } from '@/api'
import { Button, IconButton, IconSwap, Input, Sheet } from '@/components/ui'
import { MIN_PASSWORD_LENGTH, useCreateVault, vaultCodeText, type VaultState } from '@/vault'
import { OnboardingFlow, type FinishControls, type OnboardingMode } from './WdkOnboardingSheet'
import { deriveAddress } from './wdk'

const VAULT_NOTICE =
  'Regtest demo, never use a real seed. Only your local Vault gets the phrase, encrypted with your password: the backend and the agents never see it.'
const WALLET_PHRASE = "This is your Wallet's recovery phrase. Your Vault needs its own."

interface VaultOnboardingSheetProps {
  open: boolean
  onClose: () => void
  walletId: WalletId
  /** The AI wallet's address: its own phrase is refused, since the backend keeps that one. */
  walletAddress: string | undefined
  mode: OnboardingMode
  onCreated: (vault: VaultState) => void
}

/**
 * The Vault's own recovery phrase, by Tether WDK in the browser (the same flow as a new wallet),
 * then a password that encrypts it in the Vault service. The phrase goes only to
 * POST /vault/{id}/create and leaves the flow's state as soon as the Vault exists.
 */
export function VaultOnboardingSheet({ open, onClose, walletId, walletAddress, mode, onCreated }: VaultOnboardingSheetProps) {
  return (
    <Sheet open={open} onClose={onClose} title="Vault via Tether WDK">
      <div className="mx-auto w-full max-w-md">
        <OnboardingFlow
          initialMode={mode}
          notice={VAULT_NOTICE}
          finish={(controls) => <PasswordStep {...controls} walletId={walletId} walletAddress={walletAddress} onCreated={onCreated} />}
        />
      </div>
    </Sheet>
  )
}

/**
 * Whether `seed` opens the AI wallet at `walletAddress`: Tether WDK and the backend derive the same
 * first BIP-84 address from one phrase. null while it derives.
 */
function useIsWalletPhrase(seed: string, walletAddress: string | undefined): boolean | null {
  const [same, setSame] = useState<boolean | null>(walletAddress ? null : false)
  useEffect(() => {
    if (!seed || !walletAddress) return
    let current = true
    deriveAddress(seed).then(
      (address) => {
        if (current) setSame(address === walletAddress)
      },
      () => {
        if (current) setSame(false)
      },
    )
    return () => {
      current = false
    }
  }, [seed, walletAddress])
  return same
}

interface PasswordStepProps extends FinishControls {
  walletId: WalletId
  walletAddress: string | undefined
  onCreated: (vault: VaultState) => void
}

function PasswordStep({ seed, back, wipe, walletId, walletAddress, onCreated }: PasswordStepProps) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [visible, setVisible] = useState(false)
  const [checked, setChecked] = useState(false)
  const create = useCreateVault()
  const walletPhrase = useIsWalletPhrase(seed, walletAddress)
  const tooShort = password.length < MIN_PASSWORD_LENGTH
  const mismatch = confirm !== password

  const submit = async () => {
    setChecked(true)
    if (tooShort || mismatch || walletPhrase !== false || create.pending) return
    try {
      const vault = await create.run(walletId, { mnemonic: seed, password })
      wipe()
      setPassword('')
      setConfirm('')
      onCreated(vault)
    } catch {
      // create.error drives the line below, from its code only: nothing derived from the phrase can surface.
    }
  }

  const type = visible ? 'text' : 'password'
  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="flex flex-col pb-3">
        <p className="text-sm font-medium">Set a password</p>
        <p className="text-xs text-hint">It unlocks your Vault on this computer.</p>
      </div>
      <Input
        label="Password"
        type={type}
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        error={checked && tooShort ? `At least ${MIN_PASSWORD_LENGTH} characters` : undefined}
        autoComplete="new-password"
        autoFocus
        suffix={
          <IconButton size="sm" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible((v) => !v)}>
            <IconSwap iconKey={visible ? 'hide' : 'show'}>{visible ? <EyeOff size={14} /> : <Eye size={14} />}</IconSwap>
          </IconButton>
        }
      />
      <Input
        label="Confirm password"
        type={type}
        value={confirm}
        onChange={(event) => setConfirm(event.target.value)}
        error={checked && !tooShort && mismatch ? 'The passwords differ' : undefined}
        autoComplete="new-password"
      />
      <div className="mt-1 flex gap-2">
        <Button type="button" variant="secondary" onClick={back} disabled={create.pending}>
          Back
        </Button>
        <Button type="submit" fullWidth loading={create.pending} disabled={!password || !confirm || walletPhrase !== false}>
          Create Vault
        </Button>
      </div>
      <p className="min-h-5 pt-1.5 text-xs text-danger" role="alert">
        {walletPhrase ? WALLET_PHRASE : create.error ? vaultCodeText(create.error) : ''}
      </p>
    </form>
  )
}
