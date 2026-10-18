import { ArrowUp, CalendarDays, Lock, ScanSearch } from 'lucide-react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { AskPreset, AskView, WalletId } from '@/api'
import { AiMark, Button, IconButton, StatusLine } from '@/components/ui'
import { cn } from '@/lib/cn'
import { chatBubble, listItem } from '@/lib/motion'
import { useConversation, type AssistantMessage } from './conversation'

const QUESTION_MAX = 280

const PRESETS: { preset: AskPreset; label: string; icon: typeof ScanSearch }[] = [
  { preset: 'analyze', label: 'Analyze my account', icon: ScanSearch },
  { preset: 'week', label: 'What happened this week?', icon: CalendarDays },
  { preset: 'vault', label: 'Should I move funds to my Vault?', icon: Lock },
]

const LEFT = { side: -1 }
const RIGHT = { side: 1 }

export interface AssistantChatProps {
  walletId: WalletId
  /** Closes Your AI and opens the move to the Vault. */
  onMoveToVault: () => void
  className?: string
}

/** Your AI's conversation: presets when it is empty, bubbles, a thinking bubble, and a composer. */
export function AssistantChat({ walletId, onMoveToVault, className }: AssistantChatProps) {
  const [{ messages, waiting }, ask] = useConversation(walletId)
  const [draft, setDraft] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const empty = messages.length === 0 && !waiting

  // The newest bubble stays in view.
  useEffect(() => {
    const list = listRef.current
    list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' })
  }, [messages.length, waiting])

  const askPreset = (preset: AskPreset, label: string) => ask(label, { preset })
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const question = draft.trim()
    if (!question || waiting) return
    ask(question, { question })
    setDraft('')
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
        {empty ? (
          <div className="flex flex-col gap-4 pt-2">
            <div className="flex items-center gap-3">
              <AiMark size={36} />
              <p className="text-sm text-hint">Ask about your account. It never leaves this device.</p>
            </div>
            <motion.div className="flex flex-col gap-2" variants={listItem} initial="initial" animate="animate">
              {PRESETS.map(({ preset, label, icon: Icon }) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => askPreset(preset, label)}
                  className="pressable flex h-12 items-center gap-3 rounded-control bg-surface-muted px-3.5 text-left text-sm font-medium text-fg hover:bg-surface-raised"
                >
                  <Icon size={16} className="shrink-0 text-accent" aria-hidden="true" />
                  {label}
                </button>
              ))}
            </motion.div>
          </div>
        ) : (
          <ol className="flex flex-col gap-2.5" aria-live="polite">
            <AnimatePresence initial={false}>
              {messages.map((message) => (
                <Bubble key={message.id} message={message} onMoveToVault={onMoveToVault} />
              ))}
              {waiting && (
                <motion.li key="thinking" className="flex origin-bottom-left justify-start" custom={LEFT} variants={chatBubble} initial="initial" animate="animate" exit="exit">
                  <div className="flex items-center gap-2.5 rounded-card rounded-bl-md bg-surface-muted px-3.5 py-2.5">
                    <AiMark size={18} thinking />
                    <StatusLine text="Thinking on this device…" className="text-xs" />
                  </div>
                </motion.li>
              )}
            </AnimatePresence>
          </ol>
        )}
      </div>

      <div className="flex shrink-0 flex-col gap-2 border-t border-separator px-4 pt-2.5 pb-1">
        {!empty && (
          <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 [scrollbar-width:none]">
            {PRESETS.map(({ preset, label }) => (
              <button
                key={preset}
                type="button"
                disabled={waiting}
                onClick={() => askPreset(preset, label)}
                className="pressable pressable-flat badge-nowrap h-8 shrink-0 rounded-full bg-surface-muted px-3 text-xs font-medium text-hint hover:text-fg disabled:opacity-50"
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <form onSubmit={submit} className="flex items-center gap-2">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            maxLength={QUESTION_MAX}
            placeholder="Ask about your account"
            aria-label="Ask your AI"
            enterKeyHint="send"
            className="h-11 min-w-0 flex-1 rounded-full bg-surface-muted px-4 text-sm text-fg outline-none placeholder:text-hint focus-visible:ring-2 focus-visible:ring-accent/60"
          />
          <IconButton type="submit" variant="primary" size="lg" aria-label="Send" disabled={!draft.trim() || waiting}>
            <ArrowUp size={18} aria-hidden="true" />
          </IconButton>
        </form>
      </div>
    </div>
  )
}

function Bubble({ message, onMoveToVault }: { message: AssistantMessage; onMoveToVault: () => void }) {
  if (message.from === 'you') {
    return (
      <motion.li className="flex origin-bottom-right justify-end" custom={RIGHT} variants={chatBubble} initial="initial" animate="animate" exit="exit">
        <p className="max-w-[85%] rounded-card rounded-br-md bg-accent/20 px-3.5 py-2 text-sm text-fg shadow-[inset_0_0_0_1px_rgb(185_168_246/0.3)] select-text">
          {message.text}
        </p>
      </motion.li>
    )
  }
  return (
    <motion.li className="flex origin-bottom-left justify-start" custom={LEFT} variants={chatBubble} initial="initial" animate="animate" exit="exit">
      <div className="flex max-w-[90%] flex-col gap-2 rounded-card rounded-bl-md bg-surface-muted px-3.5 py-2.5">
        {'error' in message ? (
          <p className="text-sm text-danger">{message.error}</p>
        ) : (
          <Answer reply={message.reply} onMoveToVault={onMoveToVault} />
        )}
      </div>
    </motion.li>
  )
}

function Answer({ reply, onMoveToVault }: { reply: AskView; onMoveToVault: () => void }) {
  // The facts behind a longer answer; one fact is the answer itself.
  const facts = reply.signals.length > 1 ? reply.signals : []
  return (
    <>
      <p className="text-sm leading-snug text-fg select-text">{reply.answer}</p>
      {facts.length > 0 && (
        <ul className="flex flex-col gap-1 border-l-2 border-accent/30 pl-2.5">
          {facts.map((signal) => (
            <li key={signal.id} className="text-xs leading-snug">
              <span className="font-medium text-fg">{signal.title}</span>
              <span className="text-hint"> · {signal.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {reply.action === 'move_to_vault' && (
        <Button size="sm" onClick={onMoveToVault} className="self-start">
          <Lock size={13} aria-hidden="true" />
          Move to Vault
        </Button>
      )}
      {reply.generated_by === 'qvac' ? (
        <p className="flex items-center gap-1.5 text-[11px] leading-tight text-hint">
          <AiMark size={10} />
          Local AI · QVAC
        </p>
      ) : (
        reply.note && <p className="text-[11px] leading-tight text-hint">{reply.note}</p>
      )}
    </>
  )
}
