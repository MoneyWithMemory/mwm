import { Check } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useSetAlias } from '@/api'
import { Button, Input, Sheet } from '@/components/ui'
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

  const label = saved ? 'Saved' : 'Save'

  return (
    <Sheet open={open} onClose={onClose} title="Rename contact">
      <form className="flex flex-col gap-3" onSubmit={submit}>
        <p className="select-text break-all text-xs text-hint">{shortAddress(address, 10, 6)}</p>
        <Input
          value={name}
          maxLength={MAX_LENGTH}
          placeholder="Alias"
          aria-label="Alias"
          error={error?.message}
          onChange={(event) => setName(event.target.value)}
        />
        <Button type="submit" fullWidth disabled={!trimmed} loading={pending}>
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
        </Button>
      </form>
    </Sheet>
  )
}
