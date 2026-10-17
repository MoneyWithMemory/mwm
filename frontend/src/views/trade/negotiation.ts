import type { Role, Round, SessionView } from '@/api'

export const SIDES: readonly Role[] = ['buyer', 'seller']

/** One agent turn of a round, as a chat message. The buyer opens every round. */
export interface ChatMessage {
  id: string
  side: Role
  round: number
  /** null when the agent spoke without a price (e.g. "No deal" on the last round). */
  priceUsd: number | null
  accepted: boolean
  /** Change from this side's previous offer, in %; the seller's first is measured from the list price. */
  deltaPct: number | null
  /** The requesting wallet's own agent reasoning, on its own side only. */
  thought: string | null
  message: string | null
}

function offerOf(round: Round, side: Role): number | null {
  return side === 'buyer' ? round.buyer_offer_usd : round.seller_offer_usd
}

function actionOf(round: Round, side: Role) {
  return side === 'buyer' ? round.buyer_action : round.seller_action
}

export function toMessages(session: SessionView): ChatMessage[] {
  const previous: Record<Role, number | null> = { buyer: null, seller: session.list_price_usd ?? null }
  const messages: ChatMessage[] = []
  for (const round of session.rounds) {
    for (const side of SIDES) {
      const priceUsd = offerOf(round, side)
      const message = round.public_messages[side]
      if (priceUsd === null && !message) continue
      const accepted = actionOf(round, side) === 'ACCEPT'
      const before = previous[side]
      messages.push({
        id: `${round.n}-${side}`,
        side,
        round: round.n,
        priceUsd,
        accepted,
        deltaPct: priceUsd !== null && before && !accepted ? ((priceUsd - before) / before) * 100 : null,
        thought: side === session.my_role ? round.my_private_thought : null,
        message,
      })
      if (priceUsd !== null) previous[side] = priceUsd
    }
  }
  return messages
}

/** Where each side stands now: its latest offer (the seller starts from the list price) and the deal, if any. */
export function standing(session: SessionView) {
  let bid: number | null = null
  let ask: number | null = session.list_price_usd ?? null
  let accepted: number | null = null
  const all: number[] = ask === null ? [] : [ask]
  for (const round of session.rounds) {
    for (const side of SIDES) {
      const price = offerOf(round, side)
      if (price === null) continue
      all.push(price)
      if (side === 'buyer') bid = price
      else ask = price
      if (actionOf(round, side) === 'ACCEPT') accepted = price
    }
  }
  const deal = session.agreed_price_usd ?? accepted
  return { bid, ask, deal, low: Math.min(...all), high: Math.max(...all) }
}

/** "You" on the requesting wallet's side, the counterparty's name on the other. */
export function sideNames(myRole: Role, counterpartyName: string): Record<Role, string> {
  return myRole === 'buyer' ? { buyer: 'You', seller: counterpartyName } : { buyer: counterpartyName, seller: 'You' }
}

/** The round in progress: while the buyer thinks it is the next one (the buyer opens each round). */
export function currentRound(session: SessionView): number {
  const last = session.rounds.at(-1)
  if (!last) return 1
  return session.thinking === 'buyer' && last.buyer_offer_usd !== null ? session.rounds.length + 1 : session.rounds.length
}
