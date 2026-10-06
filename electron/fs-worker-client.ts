// Main's side of the fs worker (fs-worker.ts). Started on first use; requests carry an id.
// A request unanswered for HUNG_MS means the worker's threads are stuck on a dead mount: every
// waiting request fails, the worker is killed, and the next request starts a fresh one. A
// worker idle for IDLE_MS is shut down (it costs a process while alive). Main never touches a
// possibly-dead path itself.
import type { FsReply, FsRequest, FsResult } from "./fs-worker-ops"

export const HUNG_MS = 30_000
export const IDLE_MS = 5 * 60_000

/** The bits of Electron's UtilityProcess we use (a fake in tests). */
export interface WorkerProc {
  postMessage(msg: FsRequest): void
  on(ev: "message", fn: (msg: FsReply) => void): void
  on(ev: "exit", fn: (code: number) => void): void
  kill(): boolean
}

type Pending = { resolve: (v: FsResult) => void; reject: (e: Error) => void; at: number }

const fail = (code: string) => Object.assign(new Error(code), { code })

type DistOp<T> = T extends { op: infer O } ? Omit<T, "id"> & { op: O } : never
export type FsCall = DistOp<FsRequest>

/** Sends fs requests to a worker process it starts, watches and replaces. */
export class FsWorkerClient {
  private proc: WorkerProc | null = null
  private nextId = 1
  private pending = new Map<number, Pending>()
  private hungTimer: ReturnType<typeof setInterval> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly spawn: () => WorkerProc,
    private readonly hungMs = HUNG_MS,
    private readonly idleMs = IDLE_MS,
  ) {}

  call(req: FsCall): Promise<FsResult> {
    const proc = this.ensure()
    const id = this.nextId++
    return new Promise<FsResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, at: Date.now() })
      this.clearIdle()
      try {
        proc.postMessage({ ...req, id } as FsRequest)
      } catch {
        this.restart("EWORKER")
      }
    })
  }

  /** Stop the worker (app quit). */
  dispose(): void {
    this.restart("EWORKER")
  }

  private ensure(): WorkerProc {
    if (this.proc) return this.proc
    const proc = this.spawn()
    this.proc = proc
    proc.on("message", (reply) => {
      if (this.proc !== proc) return // a reply from a worker we already replaced
      const p = this.pending.get(reply.id)
      if (!p) return
      this.pending.delete(reply.id)
      if (reply.ok) p.resolve(reply.value)
      else p.reject(fail(reply.code))
      if (!this.pending.size) this.armIdle()
    })
    proc.on("exit", () => {
      if (this.proc === proc) this.restart("EWORKER") // crashed: fail what it held
    })
    // Check for a hung request a few times per HUNG_MS (no timer per request).
    this.hungTimer = setInterval(() => this.checkHung(), Math.max(10, this.hungMs / 4))
    this.hungTimer.unref?.()
    return proc
  }

  private checkHung(): void {
    const now = Date.now()
    for (const p of this.pending.values()) {
      if (now - p.at >= this.hungMs) return this.restart("EHUNG")
    }
  }

  /** Fail every waiting request with `code`, kill the worker; the next call starts a new one. */
  private restart(code: string): void {
    const proc = this.proc
    this.proc = null
    if (this.hungTimer) clearInterval(this.hungTimer)
    this.hungTimer = null
    this.clearIdle()
    const waiting = [...this.pending.values()]
    this.pending.clear()
    for (const p of waiting) p.reject(fail(code))
    try {
      proc?.kill()
    } catch {
      // already gone
    }
  }

  private armIdle(): void {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      if (!this.pending.size) this.restart("EWORKER")
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
