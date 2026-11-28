// Main's side of remote control: starts the remote-host worker when Remote control is on, kills
// it when off, and answers its questions from the device table (main holds the authority).
// Off means no worker and no remote code on any path.

import type { AnswerRefusal, RemotePanes, SendRefusal } from "../../src/lib/remote-protocol"
import type { ChatLead } from "../agents/chat-lead"
import type { TermSnapshot } from "./term-mirror"
import type { Decision, DeviceTable } from "./devices"
import type {
  ClientInfo,
  FromHost,
  HostConfig,
  HostStatus,
  RpcCall,
  RpcResult,
  ToHost,
} from "./host-messages"

/** The bits of Electron's UtilityProcess we use (a fake in tests). */
export interface HostProc {
  postMessage(msg: ToHost): void
  on(ev: "message", fn: (msg: FromHost) => void): void
  on(ev: "exit", fn: (code: number) => void): void
  kill(): boolean
}

export type { Decision }

export interface RemoteHostDeps {
  fork: () => HostProc
  devices: () => Promise<DeviceTable>
  /** Shows the approval prompt (a native dialog); resolves the user's choice. */
  ask: (name: string, code: string, machine: boolean) => Promise<Decision>
  /** Status or clients changed (for the renderer). */
  onChange: () => void
  /** The terminal view: a pane's output so far (the tap starts), raw keys, the tap stopped. */
  snapshot?: (pane: string) => TermSnapshot | null | "failed"
  keys?: (deviceId: string, pane: string, data: string) => Promise<boolean>
  untap?: (pane: string) => void
  /** Another minmux sets a pane's size while you work there; release ends it (all its panes). */
  drive?: (deviceId: string, name: string, pane: string, cols: number, rows: number) => void
  release?: (deviceId: string, pane?: string) => void
  answerable?: (pane: string) => boolean
  answer?: (
    call: Extract<RpcCall, { op: "answer" }>,
  ) => Promise<{ ok: boolean; reason?: AnswerRefusal }>
  workerGone?: () => void // the worker exited or was replaced: its taps are gone with it
  /** A device's message for a pane (main checks and types it). */
  send?: (
    deviceId: string,
    pane: string,
    text: string,
    id: string,
  ) => Promise<{ ok: boolean; reason?: SendRefusal }>
}

export type RemoteState = { status: HostStatus | { state: "off" }; clients: ClientInfo[] }

const RESTART_MS = 2000

/** What a question gets when answering it failed: the safe "no". */
export const FAILED: { [K in RpcCall["op"]]: Extract<RpcResult, { op: K }> } = {
  auth: { op: "auth", result: { state: "none" } },
  approve: { op: "approve", result: { error: "limited" } },
  pending: { op: "pending", result: { state: "expired" } },
  unlock: { op: "unlock", result: "unknown" },
  send: { op: "send", result: { ok: false, reason: "error" } },
  snapshot: { op: "snapshot", result: "failed" },
  keys: { op: "keys", result: false },
  answerable: { op: "answerable", result: false },
  answer: { op: "answer", result: { ok: false, reason: "error" } },
}

export class RemoteHost {
  private proc: HostProc | null = null
  private config: HostConfig | null = null
  private status: HostStatus | { state: "off" } = { state: "off" }
  private clients: ClientInfo[] = []
  private panes: RemotePanes | null = null
  private restartTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: RemoteHostDeps) {}

  get state(): RemoteState {
    return { status: this.status, clients: this.clients }
  }

  /** Anyone connected: the renderer pushes its pane list only then. */
  get wanted(): boolean {
    return this.clients.length > 0
  }

  /** Turns it on with this config (restarts on a change), or off with null. */
  apply(config: HostConfig | null): void {
    const same = JSON.stringify(config) === JSON.stringify(this.config)
    if (same && (config === null || this.proc)) return
    this.config = config
    this.stop("off")
    if (config) this.start()
  }

  setPanes(panes: RemotePanes): void {
    this.panes = panes
    this.proc?.postMessage({ t: "panes", panes })
  }

  private leads: Record<string, ChatLead> = {}

  /** Each pane's lead agent session (sent on change; a new worker gets the latest). */
  setLeads(leads: Record<string, ChatLead>): void {
    this.leads = leads
    this.proc?.postMessage({ t: "leads", leads })
  }

  /** A tapped pane's batch, reset or new size (the terminal view). */
  tap(m: Extract<ToHost, { t: "tout" | "treset" | "tsize" }>): void {
    this.proc?.postMessage(m)
  }

  /** These panes' agents did something: the worker reads their transcripts if watched. */
  nudge(panes: string[]): void {
    if (panes.length) this.proc?.postMessage({ t: "nudge", panes })
  }

  /** Closes a device's sockets (revoked) or everyone's (no id). */
  drop(
    deviceId: string | undefined,
    reason: "revoked" | "off" | "quitting" | "locked" | "disconnected",
  ): void {
    this.proc?.postMessage({ t: "drop", deviceId, reason })
  }

  dispose(): void {
    this.config = null
    this.stop("quitting")
  }

  private start(): void {
    const proc = this.deps.fork()
    this.proc = proc
    this.status = { state: "starting" }
    proc.on("message", (m) => this.proc === proc && this.onMessage(proc, m))
    proc.on("exit", () => {
      if (this.proc !== proc) return
      this.deps.workerGone?.()
      this.proc = null
      this.clients = []
      this.status = { state: "error", reason: "error", detail: "the remote worker stopped" }
      this.deps.onChange()
      // Crashed while on: start again after a pause.
      if (this.config)
        this.restartTimer = setTimeout(() => this.config && !this.proc && this.start(), RESTART_MS)
    })
    proc.postMessage({ t: "config", config: this.config! })
    if (this.panes) proc.postMessage({ t: "panes", panes: this.panes })
    proc.postMessage({ t: "leads", leads: this.leads })
    this.deps.onChange()
  }

  private stop(reason: "off" | "quitting"): void {
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    const proc = this.proc
    if (!proc) {
      if (this.status.state !== "off") {
        this.status = { state: "off" }
        this.deps.onChange()
      }
      return
    }
    this.proc = null
    this.deps.workerGone?.()
    proc.postMessage({ t: "drop", reason })
    // Let the goodbyes go out, then end it.
    setTimeout(() => proc.kill(), 200)
    this.status = { state: "off" }
    this.clients = []
    this.deps.onChange()
  }

  private onMessage(proc: HostProc, m: FromHost): void {
    switch (m.t) {
      case "status":
        this.status = m.status
        this.deps.onChange()
        break
      case "clients": {
        const before = this.wanted
        this.clients = m.clients
        this.deps.onChange()
        if (!before && this.wanted && this.panes)
          this.proc?.postMessage({ t: "panes", panes: this.panes })
        break
      }
      case "touch":
        void this.deps.devices().then((t) => t.touch(m.deviceId))
        break
      case "untap":
        this.deps.untap?.(m.pane)
        break
      case "drive":
        this.deps.drive?.(m.deviceId, m.name, m.pane, m.cols, m.rows)
        break
      case "release":
        this.deps.release?.(m.deviceId, m.pane)
        break
      case "rpc":
        // Only to the worker that asked: a replacement numbers its requests from 1 again.
        void this.answer(m.call)
          .catch((): RpcResult => FAILED[m.call.op])
          .then((result) => this.proc === proc && proc.postMessage({ t: "rpc", id: m.id, result }))
        break
    }
  }

  private async answer(call: RpcCall): Promise<RpcResult> {
    const devices = await this.deps.devices()
    switch (call.op) {
      case "auth":
        return { op: "auth", result: devices.auth(call.token, call.nodeId) }
      case "approve": {
        const p = devices.createPending(call.nodeId, call.name, call.machine === true)
        if (typeof p === "string") return { op: "approve", result: { error: p } }
        if (!p.existing) {
          // Not awaited: the page polls while the dialog is up.
          void this.deps
            .ask(call.name, p.code, call.machine === true)
            .then((d) => devices.decide(p.id, d))
            .catch(() => devices.decide(p.id, "deny"))
            .finally(() => this.deps.onChange())
        }
        return { op: "approve", result: { id: p.id } }
      }
      case "pending":
        return { op: "pending", result: devices.pendingState(call.id, call.nodeId) }
      case "unlock": {
        const result = await devices.unlock(call.token, call.nodeId, call.pin)
        this.deps.onChange()
        return { op: "unlock", result }
      }
      case "snapshot":
        return { op: "snapshot", result: this.deps.snapshot?.(call.pane) ?? null }
      case "answerable":
        return { op: "answerable", result: this.deps.answerable?.(call.pane) ?? false }
      case "answer":
        return {
          op: "answer",
          result: (await this.deps.answer?.(call)) ?? { ok: false, reason: "error" },
        }
      case "keys":
        return {
          op: "keys",
          result: (await this.deps.keys?.(call.deviceId, call.pane, call.data)) ?? false,
        }
      case "send": {
        const result = this.deps.send
          ? await this.deps.send(call.deviceId, call.pane, call.text, call.id)
          : ({ ok: false, reason: "error" } as const)
        return { op: "send", result }
      }
    }
  }
}
