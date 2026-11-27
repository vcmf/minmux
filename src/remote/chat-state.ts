// The phone's per-pane chat and outbox: pure reducers (tested), used by the pane screen.
import type { ChatItem } from "../lib/remote-chat"
import type { HostMessage, SendRefusal } from "../lib/remote-protocol"

export interface ChatState {
  items: ChatItem[]
  more: boolean
  unavailable?: "no-agent" | "error"
  loaded: boolean
}

export const emptyChat: ChatState = { items: [], more: false, loaded: false }

/** Applies one `chat` message: a fresh start, older items before, or upserts by id. */
export function applyChat(s: ChatState, m: Extract<HostMessage, { t: "chat" }>): ChatState {
  if (m.reset) return { items: m.items, more: !!m.more, unavailable: m.unavailable, loaded: true }
  if (m.older) {
    const have = new Set(s.items.map((i) => i.id))
    return { ...s, items: [...m.items.filter((i) => !have.has(i.id)), ...s.items], more: !!m.more }
  }
  const at = new Map(s.items.map((it, i) => [it.id, i]))
  const items = [...s.items]
  for (const it of m.items) {
    const i = at.get(it.id)
    if (i === undefined) {
      at.set(it.id, items.length)
      items.push(it)
    } else items[i] = it
  }
  return { ...s, items }
}

/** A message from this page, until minmux says it was typed (or why not). */
export interface Outgoing {
  id: string
  pane: string
  text: string
  at: number
  state: "sending" | "sent" | "failed"
  reason?: SendRefusal | "offline"
}

export const RETRY_WITHIN_MS = 60_000

/** After a reconnect: unanswered sends under a minute old go again (same id); older ones fail. */
export function resendable(out: Outgoing[], now: number): { again: Outgoing[]; next: Outgoing[] } {
  const again: Outgoing[] = []
  const next = out.map((o) => {
    if (o.state !== "sending") return o
    if (now - o.at < RETRY_WITHIN_MS) {
      again.push(o)
      return o
    }
    return { ...o, state: "failed" as const, reason: "offline" as const }
  })
  return { again, next }
}

/** An ack lands on its message. */
export const acked = (out: Outgoing[], m: Extract<HostMessage, { t: "ack" }>): Outgoing[] =>
  out.map((o) =>
    o.id === m.id
      ? { ...o, state: m.ok ? "sent" : "failed", reason: m.ok ? undefined : m.reason }
      : o,
  )

const REFUSALS: Record<NonNullable<Outgoing["reason"]>, string> = {
  "not-allowed": "This device can only view. Change it in minmux's Settings.",
  waiting: "The agent is asking something. Answer it on the computer first.",
  held: "Pasted but not sent: the agent started asking. Press Enter on the computer, or answer it.",
  "no-pane": "That pane is gone.",
  "not-started": "That pane hasn't started on the computer yet.",
  empty: "Nothing to send.",
  multiline: "This program would run each line on its own. Send one line at a time.",
  error: "Couldn't send.",
  offline: "Not sent: the connection dropped.",
}
export const refusalText = (r: Outgoing["reason"]) => (r ? REFUSALS[r] : "")
