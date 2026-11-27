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
  // Upserts by id, kept in conversation order (seq). An item older than the first one loaded
  // (a late update far back) is left for "Load earlier".
  const items = [...s.items]
  const first = items[0]?.seq
  for (const it of m.items) {
    const i = items.findIndex((x) => x.id === it.id)
    if (i >= 0) {
      items[i] = it
      continue
    }
    if (it.seq !== undefined && first !== undefined && it.seq < first) continue
    let at = items.length
    if (it.seq !== undefined) while (at > 0 && (items[at - 1]!.seq ?? -1) > it.seq) at--
    items.splice(at, 0, it)
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
  held: "In the agent's input box, not sent: it started asking. Answer it, then press Enter on the computer.",
  "no-pane": "That pane is gone.",
  "not-started": "That pane hasn't started on the computer yet.",
  empty: "Nothing to send.",
  multiline: "This program would run each line on its own. Send one line at a time.",
  error: "Couldn't send.",
  offline: "Not sent: the connection dropped.",
}
export const refusalText = (r: Outgoing["reason"]) => (r ? REFUSALS[r] : "")
