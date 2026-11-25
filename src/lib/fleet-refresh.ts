// The fleet's data beyond the store (docs/design/FLEET_GRAPH.md, "Data"): each repo's GitHub
// name, worktrees and default branch (prs:local) and my open PRs (the lists' `mine`).
// One serialized refresher: at most one refresh runs at a time; anything asked meanwhile (the
// roots changed, the window showed, the cadence came due) marks it to run again, and each run
// reads the current roots when it starts, so an older answer can never land after a newer ask.
// It runs only while subscribed (the Fleet tab mounted) and the window is visible.
import { nextRefreshMs, type PrLists, type PrRow } from "./pr-dashboard"
import type { LocalRepo, PrLocalRequest, PrLocalResult } from "./pr-local"
import type { PrListsRequest, PrListsResult } from "./pr-dashboard"

export interface FleetData {
  local: LocalRepo[]
  mine: PrRow[]
}

export interface RefreshDeps {
  prLocal: (req: PrLocalRequest) => Promise<PrLocalResult>
  prLists: (req: PrListsRequest) => Promise<PrListsResult>
  roots: () => string[] // the panes' host checkout roots, now
  hidden: () => boolean // the window is hidden
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
}

const ROOTS_DEBOUNCE_MS = 500

export class FleetRefresh {
  private data: FleetData = { local: [], mine: [] }
  private lists: PrLists | null = null
  private asked = 0 // when GitHub was last asked (0: never)
  private failures = 0
  private running = false
  private want = { local: false, mine: false } // asked for while a run is going, or hidden
  private listeners = new Set<() => void>()
  private timer: unknown
  private soon: unknown

  constructor(private readonly deps: RefreshDeps) {}

  get = (): FleetData => this.data

  /** Subscribe (useSyncExternalStore): the first subscriber starts it, the last one stops it. */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    // The repos at once (checkouts may have changed while nobody watched; git is local and
    // cheap); GitHub only when the cadence says so.
    if (this.listeners.size === 1) this.request({ local: true, mine: this.due() <= 0 })
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.stop()
    }
  }

  /** The panes' roots changed: the repos again, shortly (several changes in a row: once). */
  rootsChanged(): void {
    if (!this.listeners.size) return
    this.deps.clearTimer(this.soon)
    this.soon = this.deps.setTimer(() => this.request({ local: true }), ROOTS_DEBOUNCE_MS)
  }

  /** The window showed again: whatever came due or was asked meanwhile, now. */
  shown(): void {
    if (this.listeners.size) this.schedule(true)
  }

  private due(): number {
    return this.asked + nextRefreshMs(this.lists, this.failures) - this.deps.now()
  }

  // The cadence: both lists when it comes due (and at once on start when it already is).
  private schedule(start = false): void {
    this.deps.clearTimer(this.timer)
    if (!this.listeners.size) return
    if (start && (this.due() <= 0 || this.want.local || this.want.mine)) {
      this.request({ local: true, mine: this.due() <= 0 })
      return
    }
    this.timer = this.deps.setTimer(
      () => this.request({ local: true, mine: true }),
      Math.max(0, this.due()),
    )
  }

  private stop(): void {
    this.deps.clearTimer(this.timer)
    this.deps.clearTimer(this.soon)
  }

  private request(what: { local?: boolean; mine?: boolean }): void {
    this.want.local ||= !!what.local
    this.want.mine ||= !!what.mine
    if (this.running || !this.listeners.size) return
    if (this.deps.hidden()) return // kept in `want`: `shown()` runs it
    void this.run()
  }

  private async run(): Promise<void> {
    this.running = true
    const { local, mine } = this.want
    this.want = { local: false, mine: false }
    if (mine) this.asked = this.deps.now()
    const roots = local ? this.deps.roots() : []
    const [loc, lists] = await Promise.all([
      roots.length ? this.deps.prLocal({ roots }).catch(() => null) : null,
      mine ? this.deps.prLists({ closed: false, part: "mine" }).catch(() => null) : null,
    ])
    let changed = false
    if (loc?.ok) {
      this.data = { ...this.data, local: loc.repos }
      changed = true
    } else if (local && !roots.length && this.data.local.length) {
      this.data = { ...this.data, local: [] } // no pane in a repo any more: nothing to keep
      changed = true
    }
    if (mine) {
      if (lists?.ok) {
        this.failures = 0
        this.lists = lists.lists
        this.data = { ...this.data, mine: lists.lists.mine }
        changed = true
      } else this.failures++
    }
    this.running = false
    if (changed) for (const fn of this.listeners) fn()
    if (this.want.local || this.want.mine) this.request({})
    else this.schedule()
  }
}
