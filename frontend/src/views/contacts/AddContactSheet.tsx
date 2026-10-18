import { ClipboardPaste, ScanLine } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useSetAlias } from '@/api'
import { Button, IconButton, Input, Sheet, toast } from '@/components/ui'
import { useWalletContext } from '@/lib/navigation'
import { parseContactCode } from './parseCode'
import { canScanQr } from './canScanQr'
import { QrScanner } from './QrScanner'

interface AddContactSheetProps {
  open: boolean
  onClose: () => void
}

export function AddContactSheet({ open, onClose }: AddContactSheetProps) {
  const { walletId } = useWalletContext()
  const { run, pending, error, reset } = useSetAlias()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const address = parseContactCode(code)
  const codeError = code.trim() && !address ? 'Enter a valid regtest address (bcrt1…) or scan a QR code.' : undefined
  const nameError = !name.trim() ? 'Give this contact a name.' : undefined

  const close = () => {
    setScanning(false)
    setScanError(null)
    reset()
    onClose()
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    setTouched(true)
    if (!address || nameError || pending) return
    run(walletId, { address, name: name.trim() }).then(
      () => {
        toast('Contact added', { type: 'success' })
        setCode('')
        setName('')
        setTouched(false)
        close()
      },
      () => {},
    )
  }

  const paste = async () => {
    try {
      setCode(await navigator.clipboard.readText())
      setScanError(null)
    } catch {
      setScanError('Paste is not available here. Type or paste the code in the field.')
    }
  }

  return (
    <Sheet open={open} onClose={close} title="Add contact">
      <form className="flex flex-col gap-1" onSubmit={submit}>
        <p className="pb-2 text-sm text-hint">Enter an address or code, or scan a QR code. No account needed.</p>

        {scanning ? (
          <div className="flex flex-col gap-2 pb-2">
            <QrScanner
              onDetected={(value) => {
                const found = parseContactCode(value)
                if (found) {
                  setCode(found)
                  setScanning(false)
                  setScanError(null)
                } else {
                  setScanError('That QR code is not a valid regtest address.')
                }
              }}
              onFailed={(message) => {
                setScanning(false)
                setScanError(message)
              }}
            />
            <Button variant="ghost" size="sm" onClick={() => setScanning(false)}>
              Stop scanning
            </Button>
          </div>
        ) : (
          <Input
            className="select-text"
            label="Address or code"
            placeholder="bcrt1q…"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={code}
            error={codeError ?? (touched && !address ? 'Enter an address or scan a QR code.' : undefined)}
            suffix={
              <IconButton size="sm" aria-label="Paste from clipboard" onClick={paste}>
                <ClipboardPaste size={16} aria-hidden="true" />
              </IconButton>
            }
            onChange={(e) => {
              setCode(e.target.value)
              setScanError(null)
            }}
          />
        )}

        {!scanning && canScanQr() && (
          <Button variant="secondary" size="sm" className="mb-2 self-start" onClick={() => setScanning(true)}>
            <ScanLine size={16} aria-hidden="true" />
            Scan QR code
          </Button>
        )}
        <p className="min-h-4 text-xs text-warning" role="status">
          {scanError}
        </p>

        <Input
          label="Name"
          placeholder="How you will see this contact"
          maxLength={24}
          value={name}
          error={touched ? nameError : undefined}
          onChange={(e) => setName(e.target.value)}
        />
        <p className="min-h-4 text-xs text-danger" role="alert">
          {error?.message}
        </p>
        <Button type="submit" fullWidth loading={pending}>
          Add contact
        </Button>
      </form>
    </Sheet>
  )
}
