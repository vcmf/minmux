// The phone page's link to minmux (docs/design/REMOTE_CONTROL.md, "Connection loss and
// expiry"): one WebSocket, reconnected with backoff, at once when the page comes back to the
// front or the network returns. Before reconnecting it asks /api/session, which tells a dropped
// network from a locked or removed device (a refused socket looks the same as a lost one).

import {
  DEAD_AFTER_MS,
  PROTOCOL_VERSION,
  SEEN_EVERY_MS,
  parseHostMessage,
  type HostMessage,
  type SessionState,
} from "../lib/remote-protocol"

export type LinkState =
  | { state: "connecting" }
  | { state: "open"; machine: string; device: string }
  | { state: "reconnecting"; attempt: number; unreachable: boolean }
  | { state: "locked"; pin: boolean; machine: string; device: string }
  | { state: "no-access"; machine: string }
  | { state: "removed" } // revoked while connected
  | { state: "version" } // this page and minmux disagree: reload
  | { state: "disconnected"; machine: string } // "Disconnect all" on the computer

export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: (() => void) | null
}

export interface LinkDeps {
  socket: () => SocketLike
  session: () => Promise<SessionState> // throws when the machine can't be reached
  onState: (s: LinkState) => void
  onMessage: (m: HostMessage) => void
  /** Is the page in front of its user? While it is, the link says so (counts as use). */
  visible?: () => boolean
  client?: "web" | "minmux" // who says hello (another minmux uses this link too)
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
}

export const backoffMs = (attempt: number) => Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1))

export class Link {
  private ws: SocketLike | null = null
  private attempt = 0
  private machine = ""
  private timer: unknown = null
  private watchdog: unknown = null
  private lastTick = 0
  private lastSeen = 0
  private checking = false
  private stopped = false
  private final = false // locked / no access / removed / version: no automatic retry
  private now: () => number
  private setTimer: (fn: () => void, ms: number) => unknown
  private clearTimer: (t: unknown) => void

  constructor(private readonly d: LinkDeps) {
    this.now = d.now ?? Date.now
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>))
  }

  /** Checks the session and connects (or reports why it can't). */
  start(): void {
    this.final = false
    this.stopped = false
    this.d.onState({ state: "connecting" })
    void this.check()
  }

  /** The page came to the front, or the network came back: don't wait out the backoff. */
  wake(): void {
    if (this.stopped || this.final || this.checking) return
    if (this.ws && this.lastTick === 0) return // still connecting
    if (this.ws && this.now() - this.lastTick < DEAD_AFTER_MS) return this.seen(true)
    this.drop()
    this.attempt = Math.max(1, this.attempt)
    void this.check()
  }

  send(m: unknown): boolean {
    if (!this.ws || this.lastTick === 0) return false
    this.ws.send(JSON.stringify(m))
    return true
  }

  stop(): void {
    this.stopped = true
    this.drop()
  }

  private async check(): Promise<void> {
    if (this.timer) this.clearTimer(this.timer)
    this.timer = null
    if (this.checking) return
    this.checking = true
    let s: SessionState
    try {
      s = await this.d.session()
    } catch {
      return this.retry(true)
    } finally {
      this.checking = false
    }
    if (this.stopped) return
    if (s.state === "locked")
      return this.finish({ state: "locked", pin: s.pin, machine: s.machine, device: s.device })
    if (s.state === "none") return this.finish({ state: "no-access", machine: s.machine })
    this.open()
  }

  private open(): void {
    this.drop()
    const ws = this.d.socket()
    this.ws = ws
    ws.onopen = () =>
      ws.send(JSON.stringify({ t: "hello", v: PROTOCOL_VERSION, client: this.d.client ?? "web" }))
    ws.onmessage = (e) => {
      if (this.ws !== ws) return
      const m = parseHostMessage(e.data)
      if (!m) return
      this.lastTick = this.now()
      switch (m.t) {
        case "welcome":
          this.attempt = 0
          this.machine = m.machine
          this.d.onState({ state: "open", machine: m.machine, device: m.device })
          this.arm()
          break
        case "locked":
          this.drop()
          void this.check() // reports locked (with or without PIN), or no access
          return
        case "bye":
          if (m.reason === "revoked") return this.finish({ state: "removed" })
          if (m.reason === "version") return this.finish({ state: "version" })
          if (m.reason === "disconnected")
            return this.finish({ state: "disconnected", machine: this.machine })
          break // off / quitting: the close that follows reconnects
      }
      this.d.onMessage(m)
    }
    ws.onclose = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.disarm()
      if (!this.stopped && !this.final) this.retry(false)
    }
  }

  private retry(unreachable: boolean): void {
    if (this.stopped || this.final) return
    this.attempt++
    this.d.onState({ state: "reconnecting", attempt: this.attempt, unreachable })
    if (this.timer) this.clearTimer(this.timer)
    this.timer = this.setTimer(() => void this.check(), backoffMs(this.attempt))
  }

  private finish(s: LinkState): void {
    this.final = true
    this.drop()
    this.d.onState(s)
  }

  /** No tick for DEAD_AFTER_MS: the connection is dead even if the socket hasn't noticed. */
  private arm(): void {
    this.disarm()
    this.watchdog = this.setTimer(() => {
      this.seen(false)
      if (this.now() - this.lastTick >= DEAD_AFTER_MS) {
        const ws = this.ws
        this.ws = null
        ws?.close()
        this.retry(false)
      } else this.arm()
    }, 5000)
  }

  /** Tells minmux the page is in use (at most once a minute, or now when it comes back). */
  private seen(now: boolean): void {
    if (!this.ws || this.lastTick === 0 || !(this.d.visible?.() ?? true)) return
    if (!now && this.now() - this.lastSeen < SEEN_EVERY_MS) return
    this.lastSeen = this.now()
    this.ws.send(JSON.stringify({ t: "seen" }))
  }

  private disarm(): void {
    if (this.watchdog) this.clearTimer(this.watchdog)
    this.watchdog = null
  }

  private drop(): void {
    this.disarm()
    const ws = this.ws
    this.ws = null
    this.lastTick = 0
    if (ws) {
      ws.onclose = null
      ws.onmessage = null
      ws.close()
    }
  }
}
