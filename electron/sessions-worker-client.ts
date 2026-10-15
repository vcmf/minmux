// Main's side of the sessions worker (sessions-worker.ts). Started on first use, shut down when
// idle (its caches go with it: the next list reads the files again, in the worker). A request
// unanswered for `callMs` means the worker is stuck: it's killed, everything it held fails, and
// the next request starts a fresh one.

import type { AgentKind } from "../src/lib/agent-graph"
import type { SessionHit } from "../src/lib/past-sessions"
import type { ListedSession } from "./agents/types"
import {
  SEARCH_MS,
  type SearchDone,
  type SessionsReply,
  type SessionsRequest,
} from "./sessions-ops"

/** The bits of Electron's UtilityProcess used here (a fake in tests). */
export interface SessionsProc {
  pid?: number
  postMessage(msg: SessionsRequest): void
  on(ev: "message", fn: (msg: SessionsReply) => void): void
  on(ev: "exit", fn: (code: number) => void): void
  kill(): boolean
}

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  onHit?: (hit: SessionHit) => void
  timer: ReturnType<typeof setTimeout>
}

type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never

// A cold listing of thousands of transcripts on a slow disk can take a while: it isn't stuck.
const LIST_MS = 120_000
const KILL_GRACE_MS = 2000
const TOUCHED_MS = 5000

const fail = (code: string) => Object.assign(new Error(code), { code })

export class SessionsWorkerClient {
  private proc: SessionsProc | null = null
  private pending = new Map<number, Pending>()
  private nextId = 1
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private exited = new WeakSet<SessionsProc>()

  constructor(
    private readonly fork: () => SessionsProc,
    private readonly opts: { callMs?: number; listMs?: number; idleMs?: number } = {},
  ) {}

  /** One agent's past sessions, newest first. */
  list(agent: AgentKind): Promise<ListedSession[]> {
    return this.call({ op: "list", agent }, undefined, this.opts.listMs ?? LIST_MS) as Promise<
      ListedSession[]
    >
  }

  /** When a session was last written, from its agent's own store (null: it can't say). */
  touched(agent: AgentKind, sessionId: string): Promise<number | null> {
    // Short, and only this call fails when late: a worker busy listing isn't stuck.
    return this.call({ op: "touched", agent, sessionId }, undefined, TOUCHED_MS, true) as Promise<
      number | null
    >
  }

  /** Search conversations; hits arrive through `onHit` until `done` settles. */
  search(
    query: string,
    agents: AgentKind[],
    rg: string | null,
    under: string | undefined, // only sessions in this folder or below
    onHit: (hit: SessionHit) => void,
  ): { done: Promise<SearchDone>; cancel: () => void } {
    const id = this.nextId
    const done = this.call(
      { op: "search", query, agents, rg, under },
      onHit,
      (this.opts.listMs ?? LIST_MS) + SEARCH_MS + 10_000, // its listing, then its own time
    ) as Promise<SearchDone>
    return { done, cancel: () => this.proc?.postMessage({ id, op: "cancel" }) }
  }

  /** Stop the worker (app quit). */
  dispose(): void {
    this.stop(fail("EGONE"))
  }

  private call(
    req: WithoutId<SessionsRequest>,
    onHit?: (hit: SessionHit) => void,
    ms?: number,
    soft = false, // late: reject this call only, keep the worker
  ) {
    const id = this.nextId++
    const proc = this.start()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null // re-armed when the worker goes idle again
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          if (!soft) return this.stop(fail("EHUNG"))
          this.pending.delete(id)
          reject(fail("ELATE"))
          this.idleSoon()
        },
        ms ?? this.opts.callMs ?? 30_000,
      )
      this.pending.set(id, { resolve, reject, onHit, timer })
      proc.postMessage({ ...req, id } as SessionsRequest)
    })
  }

  private start(): SessionsProc {
    if (this.proc) return this.proc
    const proc = this.fork()
    this.proc = proc
    proc.on("message", (m) => {
      if (this.proc !== proc) return
      const p = this.pending.get(m.id)
      if (!p) return
      if ("hit" in m) return p.onHit?.(m.hit)
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      if (m.ok) p.resolve(m.value)
      else p.reject(fail(m.code))
      this.idleSoon()
    })
    proc.on("exit", () => {
      this.exited.add(proc)
      if (this.proc === proc) this.stop(fail("EGONE"))
    })
    return proc
  }

  private idleSoon(): void {
    if (this.pending.size || this.idleTimer) return
    this.idleTimer = setTimeout(
      () => {
        this.idleTimer = null
        if (!this.pending.size) this.stop(fail("EGONE"))
      },
      this.opts.idleMs ?? 10 * 60_000,
    )
    this.idleTimer.unref?.()
  }

  /** Kill the worker; what it held fails with `err`. */
  private stop(err: Error): void {
    const proc = this.proc
    this.proc = null
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    this.pending.clear()
    if (!proc) return
    try {
      proc.kill()
    } catch {
      // gone already
    }
    // A worker stuck in a long synchronous step can't run its SIGTERM handler: force it.
    const pid = proc.pid
    if (pid)
      setTimeout(() => {
        if (this.exited.has(proc)) return
        try {
          process.kill(pid, "SIGKILL")
        } catch {
          // gone meanwhile
        }
      }, KILL_GRACE_MS).unref?.()
  }
}
