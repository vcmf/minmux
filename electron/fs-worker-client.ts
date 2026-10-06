// Main's side of the fs worker (fs-worker.ts). Started on first use; requests carry an id.
// A request unanswered for HUNG_MS is stuck on a dead mount: that request alone fails, the
// worker is retired (no new requests; its other reads may still finish) and a fresh one takes
// new requests. A retired worker is killed once nothing it holds can still finish. A process
// blocked in a dead mount may not die even when killed, so at most MAX_RETIRED of them may be
// waiting to exit; past that, requests fail fast instead of spawning more. A worker idle for
// IDLE_MS is shut down (unless it holds watchers). The files browser's folder reads and
// watches never touch a possibly-dead path in main.
//
// Watches: main keeps the set the renderer wants (setWatched) and reconciles the live worker
// to it — re-added on a fresh worker, retried after a watcher is lost (its folder deleted and
// maybe recreated). A folder whose watch call hung (a dead mount) is never watched again.
import type { FsCall, FsEvent, FsReply, FsRequest, FsResult } from "./fs-worker-ops"

export const HUNG_MS = 30_000
export const IDLE_MS = 5 * 60_000
export const MAX_RETIRED = 3
export const WATCH_RETRY_MS = 1000
export const WATCH_RETRIES = 30 // then a lost folder stays unwatched (Refresh / focus still read)

/** The bits of Electron's UtilityProcess we use (a fake in tests). */
export interface WorkerProc {
  postMessage(msg: FsRequest): void
  on(ev: "message", fn: (msg: FsReply | FsEvent) => void): void
  on(ev: "exit", fn: (code: number) => void): void
  kill(): boolean
}

type Pending = {
  req: FsCall // kept so a read stranded on a retired worker can be re-sent
  resolve: (v: FsResult) => void
  reject: (e: Error) => void
  at: number
  hung?: boolean // failed as hung; its late reply is ignored
}

/** One worker process and the requests it holds. */
type Worker = {
  proc: WorkerProc
  pending: Map<number, Pending>
  retired: boolean
  killed?: boolean
}

const fail = (code: string) => Object.assign(new Error(code), { code })

/** Sends fs requests to a worker process it starts, watches and replaces. */
export class FsWorkerClient {
  private live: Worker | null = null
  private retired = new Set<Worker>() // replaced, not exited yet
  private nextId = 1
  private hungTimer: ReturnType<typeof setInterval> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  // Watches: wanted by the renderer · active on the live worker · being added · never again.
  private wanted = new Set<string>()
  private watching = new Set<string>()
  private adding = new Set<string>()
  private unwatchable = new Set<string>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retries = 0
  /** Folders whose listing may have changed (from the live worker's watchers). */
  onChanged: (dirs: string[]) => void = () => {}

  constructor(
    private readonly spawn: () => WorkerProc,
    private readonly hungMs = HUNG_MS,
    private readonly idleMs = IDLE_MS,
  ) {}

  call(req: FsCall): Promise<FsResult> {
    return new Promise<FsResult>((resolve, reject) => this.send({ req, resolve, reject, at: 0 }))
  }

  /** Hand a request to the live worker (starting one if needed). */
  private send(p: Pending): void {
    const w = this.ensure()
    if (!w) return p.reject(fail("EBUSY")) // too many stuck workers: don't add another
    const id = this.nextId++
    p.at = Date.now()
    w.pending.set(id, p)
    this.clearIdle()
    this.armHungCheck()
    try {
      w.proc.postMessage({ ...p.req, id })
    } catch {
      this.end(w, "EWORKER")
    }
  }

  /** The folders to watch (the whole set; [] stops watching). */
  setWatched(dirs: string[]): void {
    this.wanted = new Set(dirs.filter((d) => !this.unwatchable.has(d)))
    this.retries = 0
    this.reconcile()
  }

  private reconcile(): void {
    if (!this.live && !this.wanted.size) return // don't start a worker just to unwatch
    for (const d of [...this.watching]) {
      if (this.wanted.has(d)) continue
      this.watching.delete(d)
      this.call({ op: "unwatch", path: d }).catch(() => {})
    }
    for (const d of this.wanted) {
      if (this.watching.has(d) || this.adding.has(d)) continue
      this.adding.add(d)
      this.call({ op: "watch", path: d }).then(
        () => {
          this.adding.delete(d)
          this.retries = 0
          if (this.wanted.has(d)) this.watching.add(d)
          else this.call({ op: "unwatch", path: d }).catch(() => {}) // unwanted meanwhile
        },
        (e: { code?: string }) => {
          this.adding.delete(d)
          // EHUNG: checkHung already dropped it for good. ENOENT etc.: stays wanted, tried
          // again shortly (it may be recreated).
          if (e.code !== "EHUNG" && this.wanted.has(d)) this.retrySoon()
        },
      )
    }
  }

  /** Re-add lost / failed watches a little later (a folder deleted then recreated). */
  private retrySoon(): void {
    if (this.retryTimer || this.retries >= WATCH_RETRIES) return
    this.retries++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.reconcile()
    }, WATCH_RETRY_MS)
    this.retryTimer.unref?.()
  }

  /** The live worker is gone: its watchers went with it. */
  private lostWorker(): void {
    this.watching.clear()
    this.adding.clear()
    // Re-add on a fresh worker (a hung watch's folder was already dropped by checkHung).
    if (this.wanted.size) setTimeout(() => this.reconcile(), 0)
  }

  /** Stop every worker (app quit). */
  dispose(): void {
    this.wanted.clear()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.live) this.end(this.live, "EWORKER")
    for (const w of [...this.retired]) this.end(w, "EWORKER")
  }

  private ensure(): Worker | null {
    if (this.live) return this.live
    if (this.retired.size >= MAX_RETIRED) return null
    const w: Worker = { proc: this.spawn(), pending: new Map(), retired: false }
    this.live = w
    w.proc.on("message", (msg) => {
      if ("event" in msg) {
        if (this.live !== w) return // a retired worker's watchers are being replaced
        if (msg.event === "changed") this.onChanged(msg.dirs)
        else {
          this.watching.delete(msg.dir)
          if (this.wanted.has(msg.dir)) this.retrySoon()
        }
        return
      }
      const reply = msg
      const p = w.pending.get(reply.id)
      if (!p) return
      w.pending.delete(reply.id)
      if (!p.hung) {
        if (reply.ok) p.resolve(reply.value)
        else p.reject(fail(reply.code))
      }
      this.settle(w)
    })
    w.proc.on("exit", () => {
      this.retired.delete(w) // a retired one finally exited: room for another
      if (this.live === w)
        this.end(w, "EWORKER") // crashed: fail what it held
      else for (const p of w.pending.values()) if (!p.hung) p.reject(fail("EWORKER"))
      w.pending.clear()
    })
    return w
  }

  /** A retired worker holding nothing that can still finish. */
  private canKill(w: Worker): boolean {
    return w.retired && !w.killed && [...w.pending.values()].every((p) => p.hung)
  }

  /** After a reply: kill a retired worker with nothing left that can finish; idle-arm. */
  private settle(w: Worker): void {
    if (this.canKill(w)) this.kill(w)
    if (w === this.live && !w.pending.size) this.armIdle()
    this.armHungCheck()
  }

  private checkHung(): void {
    const now = Date.now()
    for (const w of [this.live, ...this.retired]) {
      if (!w) continue
      let stuck = false
      for (const p of w.pending.values()) {
        if (p.hung || now - p.at < this.hungMs) continue
        p.hung = true // fail just this one; healthy reads beside it may still finish
        if (p.req.op === "watch") {
          this.unwatchable.add(p.req.path) // watching it hung the worker: never again
          this.wanted.delete(p.req.path)
        }
        p.reject(fail("EHUNG"))
        stuck = true
      }
      if (stuck && !w.retired) this.retire(w)
      if (this.canKill(w)) this.kill(w)
    }
    this.armHungCheck()
  }

  /** Stop sending to `w`; the next call starts a fresh worker. Its other reads may be queued
   *  behind the hung ones on its threads: re-send them to the fresh worker (a read is
   *  idempotent; the old worker's late reply is ignored). */
  private retire(w: Worker): void {
    w.retired = true
    this.retired.add(w)
    if (this.live === w) {
      this.live = null
      this.lostWorker()
    }
    for (const [id, p] of [...w.pending]) {
      if (p.hung) continue
      w.pending.delete(id)
      this.send(p)
    }
  }

  /** Kill a retired worker (it stays counted until it actually exits). */
  private kill(w: Worker): void {
    w.killed = true
    try {
      w.proc.kill()
    } catch {
      this.retired.delete(w) // already gone
    }
  }

  /** Fail everything `w` holds with `code` and kill it. */
  private end(w: Worker, code: string): void {
    if (this.live === w) {
      this.live = null
      this.lostWorker()
    }
    this.retired.delete(w)
    for (const p of w.pending.values()) if (!p.hung) p.reject(fail(code))
    w.pending.clear()
    try {
      w.proc.kill()
    } catch {
      // already gone
    }
    this.clearIdle()
    this.armHungCheck()
  }

  // The hung check runs only while some request can still hang.
  private armHungCheck(): void {
    const waiting = [this.live, ...this.retired].some(
      (w) => w && [...w.pending.values()].some((p) => !p.hung),
    )
    if (waiting && !this.hungTimer) {
      this.hungTimer = setInterval(() => this.checkHung(), Math.max(10, this.hungMs / 4))
      this.hungTimer.unref?.()
    } else if (!waiting && this.hungTimer) {
      clearInterval(this.hungTimer)
      this.hungTimer = null
    }
  }

  private armIdle(): void {
    this.clearIdle()
    this.idleTimer = setTimeout(() => {
      const w = this.live
      if (w && !w.pending.size && !this.wanted.size) this.end(w, "EWORKER") // not if watching
    }, this.idleMs)
    this.idleTimer.unref?.()
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}
