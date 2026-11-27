// How a phone's message is typed into a pane (docs/design/REMOTE_CONTROL.md, "Sending a
// message"): checked, cleaned of control characters, pasted when the program asked for bracketed
// paste, then Enter as its own write a moment later, unless the agent started asking meanwhile.
// Pure parts + a small sender; main supplies the pane state and the PTY write.

import type { RemotePane, SendRefusal } from "../../src/lib/remote-protocol"
import { SEND_MAX } from "../../src/lib/remote-protocol"

export const ENTER_DELAY_MS = 60
const DEDUPE_MS = 10 * 60_000
const DEDUPE_MAX = 100

/** The text without escape or control characters (newlines and tabs stay), capped. */
export function cleanText(text: string): string {
  return (
    text
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "")
      .slice(0, SEND_MAX)
  )
}

/** What to write first: the text pasted (bracketed) or typed. Enter follows separately. */
export const firstWrite = (text: string, paste: boolean): string =>
  paste ? `\x1b[200~${text}\x1b[201~` : text

/** Why a pane can't take a message now, or null when it can. */
export function refusal(pane: RemotePane | undefined): SendRefusal | null {
  if (!pane) return "no-pane"
  if (!pane.started) return "not-started"
  if (pane.status === "waiting" && pane.kind === "agent") return "waiting"
  return null
}

export interface SenderDeps {
  pane: (id: string) => RemotePane | undefined // the latest pane list's entry
  write: (pane: string, data: string) => boolean // false: no such PTY (or still connecting)
  delay?: (ms: number) => Promise<void>
  now?: () => number
}

export type SendResult = { ok: boolean; reason?: SendRefusal }

/** Types messages into panes; a retried id (a reconnect) gets the first answer back. */
export class Sender {
  private seen = new Map<string, { at: number; result: Promise<SendResult> }>()
  private delay: (ms: number) => Promise<void>
  private now: () => number

  constructor(private readonly d: SenderDeps) {
    this.delay = d.delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    this.now = d.now ?? Date.now
  }

  send(deviceId: string, paneId: string, text: string, id: string): Promise<SendResult> {
    const key = `${deviceId}:${id}`
    const now = this.now()
    for (const [k, v] of this.seen) if (now - v.at > DEDUPE_MS) this.seen.delete(k)
    const again = this.seen.get(key)
    if (again) return again.result
    const result = this.type(paneId, text)
    this.seen.set(key, { at: now, result })
    while (this.seen.size > DEDUPE_MAX) this.seen.delete(this.seen.keys().next().value!)
    return result
  }

  private async type(paneId: string, raw: string): Promise<SendResult> {
    const pane = this.d.pane(paneId)
    const no = refusal(pane)
    if (no) return { ok: false, reason: no }
    const text = cleanText(raw)
    if (!text.trim()) return { ok: false, reason: "empty" }
    // A pane whose program never said (no renderer): agents paste, shells don't.
    const paste = pane!.paste ?? pane!.kind === "agent"
    if (!this.d.write(paneId, firstWrite(text, paste))) return { ok: false, reason: "no-pane" }
    await this.delay(ENTER_DELAY_MS)
    // The agent started asking between the paste and Enter: Enter would answer its dialog.
    if (refusal(this.d.pane(paneId)) === "waiting") return { ok: false, reason: "held" }
    return this.d.write(paneId, "\r") ? { ok: true } : { ok: false, reason: "no-pane" }
  }
}
