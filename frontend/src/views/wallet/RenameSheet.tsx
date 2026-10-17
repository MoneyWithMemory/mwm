import { Check } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSetAlias } from '@/api'
import { Sheet } from '@/components/ui'
import { cn } from '@/lib/cn'
import { shortAddress } from '@/lib/format'
import { textSwap } from '@/lib/motion'

interface RenameSheetProps {
  open: boolean
  onClose: () => void
  walletId: string
  address: string
  currentName: string
}

const MAX_LENGTH = 24

export function RenameSheet({ open, onClose, walletId, address, currentName }: RenameSheetProps) {
  const [name, setName] = useState(currentName)
  const [saved, setSaved] = useState(false)
  const { run, pending, error } = useSetAlias()
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const trimmed = name.trim()

  useEffect(() => () => clearTimeout(timer.current), [])

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!trimmed || pending || saved) return
    run(walletId, { address, name: trimmed }).then(
      () => {
        setSaved(true)
        timer.current = setTimeout(onClose, 600)
      },
      () => {},
    )
  }

  const label = saved ? 'Saved' : pending ? 'Saving' : 'Save'

  return (
    <Sheet open={open} onClose={onClose} title="Rename contact">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <p className="select-text break-all text-xs text-hint">{shortAddress(address, 10, 6)}</p>
        <input
          className="w-full rounded-control bg-surface-muted px-3 py-2.5 text-base outline-none placeholder:text-hint"
          value={name}
          maxLength={MAX_LENGTH}
          placeholder="Alias"
          aria-label="Alias"
          aria-invalid={error ? true : undefined}
          onChange={(event) => setName(event.target.value)}
        />
        <p className="min-h-4 text-xs text-danger" role="alert">
          {error?.message}
        </p>
        <button
          type="submit"
          className={cn(
            'pressable flex items-center justify-center rounded-control bg-accent py-3 text-sm font-semibold text-on-accent',
            (!trimmed || pending) && 'opacity-50',
          )}
          aria-disabled={!trimmed || pending}
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={label}
              className="flex items-center gap-1.5"
              variants={textSwap}
              initial="initial"
              animate="animate"
              exit="exit"
            >
              {saved && <Check size={16} aria-hidden="true" />}
              {label}
            </motion.span>
          </AnimatePresence>
        </button>
      </form>
    </Sheet>
  )
}
