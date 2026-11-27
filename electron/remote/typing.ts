// How a phone's message is typed into a pane (docs/design/REMOTE_CONTROL.md, "Sending a
// message"): checked, cleaned of control characters, pasted when the program asked for bracketed
// paste, then Enter as its own write a moment later, unless the agent started asking meanwhile.
// Pure parts + a small sender; main supplies the pane state and the PTY write.

import type { RemotePane, SendRefusal } from "../../src/lib/remote-protocol"
import { SEND_MAX } from "../../src/lib/remote-protocol"

export const ENTER_DELAY_MS = 60
// A message still queued after this long (main was busy) isn't typed: the phone's request has
// nearly timed out (host-server SEND_TIMEOUT_MS) and it would call it failed.
export const SEND_STALE_MS = 20_000
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
      .replace(/[\ud800-\udbff]$/, "") // never half an emoji
  )
}

/** What to write first: the text pasted (bracketed) or typed. Enter follows separately. */
export const firstWrite = (text: string, paste: boolean): string =>
  paste ? `\x1b[200~${text}\x1b[201~` : text

// `agent`: main's own view (the session ledger) too: after a renderer reload the pane list can
// show an agent pane as a shell until the next hook. A dialog main knows of blocks any pane.
/** Why a pane can't take a message now, or null when it can. */
export function refusal(
  pane: RemotePane | undefined,
  asking = false,
  between = true,
  agent = pane?.kind === "agent",
): SendRefusal | null {
  if (!pane) return "no-pane"
  if (!pane.started) return "not-started"
  if (asking || pane.asking) return "waiting"
  // An agent takes a message only between turns: a dialog can only be up during one.
  if (agent && !between) return "working"
  return null
}

export interface SenderDeps {
  pane: (id: string) => RemotePane | undefined // the latest pane list's entry
  write: (pane: string, data: string) => boolean // false: no such PTY (or still connecting)
  asking?: (pane: string) => boolean // main's latest hook state: the agent is asking
  between?: (pane: string) => boolean // the agent's turn is over (unset: always)
  isAgent?: (pane: string) => boolean // main knows an agent leads the pane
  pasteNow?: (pane: string) => Promise<boolean | undefined> // the terminal's mode right now
  submitted?: (pane: string) => void // a message was submitted (Enter written)
  allowed?: (deviceId: string) => Promise<boolean> // main's device check (may send)
  delay?: (ms: number) => Promise<void>
  now?: () => number
}

export type SendResult = { ok: boolean; reason?: SendRefusal }

/** Types messages into panes; a retried id (a reconnect) gets the first answer back. */
export class Sender {
  private seen = new Map<string, { at: number; result: Promise<SendResult> }>()
  private queues = new Map<string, Promise<unknown>>() // per pane: one paste + Enter at a time
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
    // Queued per pane, so a second message never pastes between the first one and its Enter.
    const prev = this.queues.get(paneId) ?? Promise.resolve()
    const queued = now
    const result = prev.then(() =>
      this.now() - queued > SEND_STALE_MS
        ? ({ ok: false, reason: "error" } as SendResult)
        : this.type(deviceId, paneId, text),
    )
    const tail = result.catch(() => {})
    this.queues.set(paneId, tail)
    void tail.then(() => this.queues.get(paneId) === tail && this.queues.delete(paneId))
    this.seen.set(key, { at: now, result })
    while (this.seen.size > DEDUPE_MAX) this.seen.delete(this.seen.keys().next().value!)
    return result
  }

  private async type(deviceId: string, paneId: string, raw: string): Promise<SendResult> {
    if (this.d.allowed && !(await this.d.allowed(deviceId)))
      return { ok: false, reason: "not-allowed" }
    const asking = () => this.d.asking?.(paneId) ?? false
    const between = () => this.d.between?.(paneId) ?? true
    const pane = this.d.pane(paneId)
    const agent = pane?.kind === "agent" || (this.d.isAgent?.(paneId) ?? false)
    const no = refusal(pane, asking(), between(), agent)
    if (no) return { ok: false, reason: no }
    const text = cleanText(raw)
    if (!text.trim()) return { ok: false, reason: "empty" }
    // A pane whose program never said (no renderer): agents paste, shells don't.
    // The terminal's own mode, asked now (the pushed list can be a second old: a shell turns it
    // off as a command starts); the list's, then "agents paste", when it can't say.
    const paste = (await this.d.pasteNow?.(paneId)) ?? pane!.paste ?? agent
    // Without bracketed paste every newline is an Enter: a multi-line message would run line by
    // line, past every check here.
    if (!paste && text.includes("\n")) return { ok: false, reason: "multiline" }
    // Typed keys: a tab would complete something; the message means a space.
    const typed = paste ? text : text.replace(/\t/g, " ")
    if (!this.d.write(paneId, firstWrite(typed, paste))) return { ok: false, reason: "no-pane" }
    await this.delay(ENTER_DELAY_MS)
    // The agent started asking between the paste and Enter: Enter would answer its dialog.
    // A turn started (someone at the desktop) or a dialog opened between the paste and Enter.
    if (refusal(this.d.pane(paneId), asking(), between(), agent))
      return { ok: false, reason: "held" }
    if (!this.d.write(paneId, "\r")) return { ok: false, reason: "no-pane" }
    this.d.submitted?.(paneId)
    return { ok: true }
  }
}
