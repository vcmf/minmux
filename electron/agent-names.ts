// Whose name an agent session's is (MULTI_AGENT.md F12, D3): the sessions whose name the user
// set, kept per session in the config dir, so `opencode -s`, a resume or a relaunch keeps the
// colour after the pane's ledger entry is gone. Loaded async at startup; written async.

import fs from "node:fs"
import path from "node:path"
import { AtomicFile } from "./atomic-file"

const MAX = 1000 // when full, the session named longest ago goes first

/** Sessions named by the user; `file` null = in memory (tests). */
export class UserNames {
  private ids = new Set<string>() // oldest-named first
  // Un-named before the file was read: the read mustn't bring them back.
  private cleared = new Set<string>()
  private ready = false // the file was read (or there is none)
  // False after a read that failed for another reason than "no file yet" (too many open
  // files, permissions): the file may hold earlier runs' names, so it's never overwritten.
  private writable = true
  private dirty = false
  private pending: Promise<void> = Promise.resolve() // saves waiting for the read, in order
  private readonly out: AtomicFile | null
  /** Settles once the file is read (never rejects). */
  readonly loaded: Promise<void>

  constructor(private readonly file: string | null) {
    this.out = file ? new AtomicFile(file) : null
    this.loaded = file ? this.load(file) : Promise.resolve()
    if (!file) this.ready = true
  }

  /** Was this session's name the user's? undefined: never recorded (or not theirs). */
  has(sessionId: string): boolean | undefined {
    return this.ids.has(sessionId) || undefined
  }

  /** Record whose name it is now; a session named again moves to the back. */
  set(sessionId: string, user: boolean): void {
    const had = this.ids.delete(sessionId)
    if (user) {
      this.cleared.delete(sessionId)
      this.ids.add(sessionId)
      if (this.ids.size > MAX) this.ids.delete(this.ids.values().next().value!)
    } else if (!this.ready) {
      this.cleared.add(sessionId) // it may be in the file: saved without it once it's read
    }
    if (had || user || !this.ready) this.save()
  }

  private async load(file: string): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await fs.promises.readFile(file, "utf8"))
      const list = raw && typeof raw === "object" ? (raw as { sessions?: unknown }).sessions : null
      if (!Array.isArray(list)) return
      // Before what this run already recorded (that's newer), less what it un-named.
      const before = list.filter(
        (s): s is string => typeof s === "string" && !this.ids.has(s) && !this.cleared.has(s),
      )
      this.ids = new Set([...before, ...this.ids].slice(-MAX))
    } catch (e) {
      // No file yet, or not JSON (rewritten whole): no name is known to be the user's. Any
      // other failure: its names may be there, so this run never writes over it.
      const code = (e as NodeJS.ErrnoException | undefined)?.code
      if (code && code !== "ENOENT") this.writable = false
    } finally {
      this.ready = true
      this.cleared.clear()
    }
  }

  // Best-effort (worst case a name shows uncoloured). Never before the file is read: a write
  // landing first would replace the names recorded on earlier runs with this run's alone.
  private save(): void {
    this.dirty = true
    this.pending = this.pending
      .then(() => this.loaded)
      .then(() => {
        if (!this.dirty || !this.writable || !this.out) return
        this.dirty = false
        this.out.write(this.body())
      })
  }

  private body(): string {
    return JSON.stringify({ v: 1, sessions: [...this.ids] })
  }

  /** At quit: write what's unsaved now, synchronously (an async write may never land). */
  saveSync(): void {
    if (!this.dirty || !this.ready || !this.writable || !this.file) return
    try {
      const tmp = `${this.file}.${process.pid}.quit.tmp`
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, this.body())
      fs.renameSync(tmp, this.file)
      this.dirty = false
    } catch {
      // best-effort
    }
  }

  /** Done when every save asked for so far has landed (tests). */
  async flushed(): Promise<void> {
    // A save asked for while waiting extends the chain: wait for that one too.
    for (let p = this.pending; ; p = this.pending) {
      await p
      if (p === this.pending) break
    }
    await this.out?.flushed()
  }
}
