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
// Re-adding lost / failed watches backs off: 1 s, 2 s, 4 s … WATCH_RETRY_MAX_MS, back to 1 s
// after a watch succeeds. Never gives up (a crash loop just slows down).
export const WATCH_RETRY_MS = 1000
export const WATCH_RETRY_MAX_MS = 60_000

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
  private rearm = new Set<string>() // wanted folders that were watched and lost their watcher
  private unwatchable = new Set<string>()
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retries = 0 // folder retries (missing, busy), backing off
  private respawns = 0 // re-adds after a lost worker, backing off on their own
  private respawnTimer: ReturnType<typeof setTimeout> | null = null
  private spawnedAt = 0
  private gen = 0 // bumped when the live worker goes: a late watch reply from it doesn't count
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
    for (const d of this.rearm) if (!this.wanted.has(d)) this.rearm.delete(d)
    this.retries = 0
    this.reconcile()
    // Nothing wanted any more and nothing in flight: the idle clock starts now.
    if (!this.wanted.size && this.live && !this.live.pending.size) this.armIdle()
  }

  /** The folders actually being watched right now (others need reading some other way). */
  watchingNow(): string[] {
    return [...this.watching]
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
      const gen = this.gen
      this.call({ op: "watch", path: d }).then(
        () => {
          if (gen !== this.gen) return // its worker is gone; the fresh one re-adds it
          this.adding.delete(d)
          this.retries = 0
          if (!this.wanted.has(d)) return void this.call({ op: "unwatch", path: d }).catch(() => {})
          this.watching.add(d)
          // A re-add (its folder was replaced, or its worker died): whatever changed while it
          // wasn't watched is read now. A first add needs nothing — the panel just read it.
          if (this.rearm.delete(d)) this.onChanged([d])
        },
        (e: { code?: string }) => {
          if (gen !== this.gen) return
          this.adding.delete(d)
          // EHUNG: checkHung already dropped it for good. Missing (it may be recreated) or no
          // worker free (EBUSY): tried again with backoff. A worker gone: the gen check above
          // returned; lostWorker re-adds. Other errors (EACCES): left until the set changes.
          const transient = ["ENOENT", "ENOTDIR", "EBUSY"].includes(e.code ?? "")
          if (transient && this.wanted.has(d)) {
            this.rearm.add(d) // unwatched for a while: read it once when the watch takes
            this.retrySoon()
          }
        },
      )
    }
  }

  /** Re-add lost / failed watches a little later (a folder deleted then recreated). */
  private retrySoon(fresh = false): void {
    if (fresh) {
      this.retries = 0
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.retryTimer) return
    const delay = Math.min(WATCH_RETRY_MAX_MS, WATCH_RETRY_MS * 2 ** this.retries)
    this.retries++
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.reconcile()
    }, delay)
    this.retryTimer.unref?.()
  }

  /** The live worker is gone: its watchers went with it. */
  private lostWorker(): void {
    this.gen++
    for (const d of this.watching) this.rearm.add(d)
    for (const d of this.adding) this.rearm.add(d) // in flight: maybe never took
    this.watching.clear()
    this.adding.clear()
    // Re-add on a fresh worker (a hung watch's folder was already dropped by checkHung), with
    // its own backoff: a worker that keeps dying is respawned 1 s, 2 s, 4 s … 60 s apart; one
    // that lived a minute starts over.
    if (!this.wanted.size || this.respawnTimer) return
    if (Date.now() - this.spawnedAt > 60_000) this.respawns = 0
    const delay = Math.min(WATCH_RETRY_MAX_MS, WATCH_RETRY_MS * 2 ** this.respawns)
    this.respawns++
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null
      this.reconcile()
    }, delay)
    this.respawnTimer.unref?.()
  }

  /** Stop every worker (app quit). */
  dispose(): void {
    this.wanted.clear()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.respawnTimer) clearTimeout(this.respawnTimer)
    if (this.live) this.end(this.live, "EWORKER")
    for (const w of [...this.retired]) this.end(w, "EWORKER")
  }

  private ensure(): Worker | null {
    if (this.live) return this.live
    if (this.retired.size >= MAX_RETIRED) return null
    const w: Worker = { proc: this.spawn(), pending: new Map(), retired: false }
    this.spawnedAt = Date.now()
    this.live = w
    w.proc.on("message", (msg) => {
      if ("event" in msg) {
        if (this.live !== w) return // a retired worker's watchers are being replaced
        if (msg.event === "changed") this.onChanged(msg.dirs)
        else {
          this.watching.delete(msg.dir)
          if (this.wanted.has(msg.dir)) {
            this.rearm.add(msg.dir)
            this.retrySoon(true) // a fresh loss: a quick retry, whatever the backoff was
          }
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
      // A stranded watch / unwatch isn't re-sent: the fresh worker starts with no watchers
      // and the watch set is re-added to it (lostWorker).
      if (p.req.op === "watch" || p.req.op === "unwatch") p.reject(fail("EWORKER"))
      else this.send(p)
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
