// Whose name an agent session's is (MULTI_AGENT.md F12, D3): the sessions whose name the user
// set, kept per session in the config dir, so `opencode -s`, a resume or a relaunch keeps the
// colour after the pane's ledger entry is gone. Loaded async at startup; written async.

import fs from "node:fs"
import { AtomicFile } from "./atomic-file"

const MAX = 1000 // when full, the session named longest ago goes first

/** Sessions named by the user; `file` null = in memory (tests). */
export class UserNames {
  private ids = new Set<string>() // oldest-named first
  private readonly out: AtomicFile | null
  /** Settles once the file is read (never rejects). */
  readonly loaded: Promise<void>

  constructor(file: string | null) {
    this.out = file ? new AtomicFile(file) : null
    this.loaded = file ? this.load(file) : Promise.resolve()
  }

  /** Was this session's name the user's? undefined: never recorded (or not theirs). */
  has(sessionId: string): boolean | undefined {
    return this.ids.has(sessionId) || undefined
  }

  /** Record whose name it is now; a session named again moves to the back. */
  set(sessionId: string, user: boolean): void {
    const had = this.ids.delete(sessionId)
    if (user) {
      this.ids.add(sessionId)
      if (this.ids.size > MAX) this.ids.delete(this.ids.values().next().value!)
    }
    if (had || user) this.save()
  }

  private async load(file: string): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await fs.promises.readFile(file, "utf8"))
      const list = raw && typeof raw === "object" ? (raw as { sessions?: unknown }).sessions : null
      if (!Array.isArray(list)) return
      // Before what this run already recorded (that's newer).
      const before = list.filter((s): s is string => typeof s === "string" && !this.ids.has(s))
      this.ids = new Set([...before, ...this.ids].slice(-MAX))
    } catch {
      // none yet / unreadable: no name is known to be the user's
    }
  }

  // Best-effort (worst case a name shows uncoloured).
  private save(): void {
    this.out?.write(JSON.stringify({ v: 1, sessions: [...this.ids] }))
  }

  /** Done when every pending write has landed (tests). */
  flushed(): Promise<void> {
    return this.out?.flushed() ?? Promise.resolve()
  }
}
