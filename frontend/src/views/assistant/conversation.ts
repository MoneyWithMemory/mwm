import { useCallback, useSyncExternalStore } from 'react'
import { api, type AskRequest, type AskView, type WalletId } from '@/api'
import { toApiError } from '@/api/client'

export type AssistantMessage =
  | { id: number; from: 'you'; text: string }
  | { id: number; from: 'ai'; reply: AskView }
  | { id: number; from: 'ai'; error: string }

export interface Conversation {
  messages: AssistantMessage[]
  /** An answer is on its way: one question at a time. */
  waiting: boolean
}

const EMPTY: Conversation = { messages: [], waiting: false }

// One conversation per wallet, in memory only: switching wallet switches conversation.
const conversations = new Map<WalletId, Conversation>()
const listeners = new Set<() => void>()
let nextId = 1

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function update(walletId: WalletId, change: (c: Conversation) => Conversation) {
  conversations.set(walletId, change(conversations.get(walletId) ?? EMPTY))
  listeners.forEach((listener) => listener())
}

async function send(walletId: WalletId, text: string, body: AskRequest) {
  if (conversations.get(walletId)?.waiting) return
  update(walletId, (c) => ({ messages: [...c.messages, { id: nextId++, from: 'you', text }], waiting: true }))
  let answer: AssistantMessage
  try {
    answer = { id: nextId++, from: 'ai', reply: await api.ask(walletId, body) }
  } catch (err) {
    const error = toApiError(err)
    answer = { id: nextId++, from: 'ai', error: error.status === 400 ? error.message : "Couldn't reach your wallet. Try again." }
  }
  update(walletId, (c) => ({ messages: [...c.messages, answer], waiting: false }))
}

/** The wallet's conversation with its local AI, and a way to ask: a preset with its label, or free text. */
export function useConversation(walletId: WalletId): [Conversation, (text: string, body: AskRequest) => void] {
  const conversation = useSyncExternalStore(subscribe, () => conversations.get(walletId) ?? EMPTY)
  const ask = useCallback((text: string, body: AskRequest) => void send(walletId, text, body), [walletId])
  return [conversation, ask]
}
