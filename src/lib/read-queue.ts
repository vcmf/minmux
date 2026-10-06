// One queue for every Files-panel folder read (first visit, expand, restore, Refresh, and the
// coming watcher), so reads can't pile up however many folders are open or changing. Rules:
//  - one read at a time, at most one start per GAP_MS (every read, urgent ones too);
//  - a big folder at most once per BIG_GAP_MS (URGENT_BIG_GAP_MS when the user asks);
//  - a folder is never queued twice; asked again while it's being read, it's read once more;
//  - `urgent` (the user is waiting) goes ahead of background reads, in the order asked;
//    `front` (a click on a folder not yet listed) goes ahead of everything;
//  - a read slower than READ_TIMEOUT_MS stops holding the queue; that folder isn't read again
//    until it settles. Every read does settle: main's fs worker fails a hung one by ~30 s
//    (fs-worker-client), so a dead mount can't stall the panel or pile up reads.
// Timers and clock are injectable.

export const GAP_MS = 250 // ≤ 4 reads per second
export const BIG_GAP_MS = 5000 // a big folder re-read at most this often
export const URGENT_BIG_GAP_MS = 1000 // …and at most this often even when the user asks
export const READ_TIMEOUT_MS = 10_000

export interface ReadTask {
  key: string // what's read (root + dir): the dedupe key
  run: () => Promise<unknown>
  urgent?: boolean // the user is waiting: ahead of background reads
  front?: boolean // …and ahead of other urgent ones (a click on a folder not yet listed)
  big?: boolean // its last listing was big: backed off
}

interface Clock {
  now: () => number
  setTimeout: (fn: () => void, ms: number) => () => void // returns a cancel
}

const realClock: Clock = {
  now: () => performance.now(), // monotonic: a wall-clock jump mustn't stall the queue
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms)
    return () => clearTimeout(h)
  },
}

const merge = (a: ReadTask, b: ReadTask): ReadTask => ({
  ...b, // the latest request knows the latest context (e.g. the pane's WSL distro)
  urgent: a.urgent || b.urgent || b.front,
  front: a.front || b.front,
  big: b.big ?? a.big,
})

/** Serialises and rate-limits folder reads. */
export class ReadQueue {
  private queue: ReadTask[] = []
  private running: string | null = null
  private again: ReadTask | null = null // re-asked while running: read once more after
  private lastStart = -Infinity
  private lastByKey = new Map<string, number>()
  private wakeAt = Infinity // when the pending timer fires (Infinity = none)
  private wakeId = 0
  private stuck = new Set<string>() // keys with a read past its timeout, still in flight

  constructor(
    private readonly clock: Clock = realClock,
    private readonly gap = GAP_MS,
    private readonly bigGap = BIG_GAP_MS,
    private readonly urgentBigGap = URGENT_BIG_GAP_MS,
    private readonly readTimeout = READ_TIMEOUT_MS,
  ) {}

  /** Drop queued (not running) reads matching `pred`, e.g. for a root no longer shown. */
  drop(pred: (key: string) => boolean): void {
    this.queue = this.queue.filter((t) => !pred(t.key))
    if (this.again && pred(this.again.key)) this.again = null
  }

  request(t: ReadTask): void {
    if (this.running === t.key) {
      this.again = this.again ? merge(this.again, t) : t
      return
    }
    const i = this.queue.findIndex((q) => q.key === t.key)
    if (i >= 0) {
      const task = merge(this.queue[i]!, t)
      // Already where it belongs (urgent, or still background): keep its place.
      const prev = this.queue[i]!
      if (task.urgent === prev.urgent && task.front === prev.front) this.queue[i] = task
      else {
        this.queue.splice(i, 1)
        this.insertUrgent(task)
      }
    } else if (t.urgent || t.front) this.insertUrgent(t)
    else this.queue.push(t)
    this.pump()
  }

  /** How many reads are waiting or running (tests, diagnostics). */
  get size(): number {
    return this.queue.length + (this.running ? 1 : 0) + this.stuck.size
  }

  // After the urgent reads already waiting: a batch (Refresh) keeps its order, parents first.
  private insertUrgent(t: ReadTask): void {
    if (t.front) return void this.queue.unshift({ ...t, urgent: true })
    const firstBackground = this.queue.findIndex((q) => !q.urgent)
    this.queue.splice(firstBackground < 0 ? this.queue.length : firstBackground, 0, t)
  }

  private readyAt(t: ReadTask): number {
    const last = this.lastByKey.get(t.key) ?? -Infinity
    const backoff = t.big ? last + (t.urgent ? this.urgentBigGap : this.bigGap) : -Infinity
    return Math.max(this.lastStart + this.gap, backoff)
  }

  private pump(): void {
    if (this.running || !this.queue.length) return
    // The first task (in queue order) that may start now; else wait for the soonest one.
    const now = this.clock.now()
    let best = -1
    let bestAt = Infinity
    for (let i = 0; i < this.queue.length; i++) {
      const t = this.queue[i]!
      if (this.stuck.has(t.key)) continue // its stuck read settling will pump again
      const at = this.readyAt(t)
      if (at <= now) {
        best = i
        break
      }
      bestAt = Math.min(bestAt, at)
    }
    if (best < 0) {
      if (bestAt !== Infinity && bestAt < this.wakeAt) {
        // A pending timer that fires later than needed is left to fire (pump is idempotent).
        this.wakeAt = bestAt
        const id = ++this.wakeId
        // Fired a hair early on our clock? wakeAt is cleared, so pump re-arms.
        this.clock.setTimeout(() => {
          if (id === this.wakeId) this.wakeAt = Infinity // the latest timer fired
          this.pump()
        }, bestAt - now)
      }
      return
    }
    const [t] = this.queue.splice(best, 1)
    void this.start(t!, now)
  }

  private async start(t: ReadTask, now: number): Promise<void> {
    this.running = t.key
    this.lastStart = now
    this.lastByKey.delete(t.key) // re-insert: the map stays in start order for pruning
    this.lastByKey.set(t.key, now)
    if (this.lastByKey.size > 512) this.lastByKey.delete(this.lastByKey.keys().next().value!)
    // Settles true either way (a failed read shows nothing new); a sync throw is caught too.
    const read = Promise.resolve()
      .then(() => t.run())
      .then(
        () => true,
        () => true,
      )
    let cancel = () => {}
    const settled = await Promise.race([
      read,
      new Promise<boolean>(
        (r) => (cancel = this.clock.setTimeout(() => r(false), this.readTimeout)),
      ),
    ])
    cancel()
    if (!settled) {
      this.stuck.add(t.key)
      void read.then(() => {
        this.stuck.delete(t.key)
        this.pump()
      })
    }
    this.running = null
    const again = this.again
    this.again = null
    if (again) this.request(again) // a user's request keeps its urgency
    this.pump()
  }
}
