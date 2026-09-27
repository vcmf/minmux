// Sessions whose PTY is still being prepared (a remote spawn awaits its ssh probe). One
// spawn per id at a time: a second pty:spawn for it (a reloaded renderer) JOINS the pending
// one — it takes over as the output target and size — rather than waiting and spawning
// again. A resize or a close that arrives meanwhile is recorded and honoured; keystrokes are
// swallowed (replayed into a fresh ssh they'd echo before its password prompt disables echo).

/** What happened while a spawn was pending: who to stream to, the size, a close. */
export interface PendingOutcome<S> {
  sender: S // the renderer to stream to once it starts (the newest one that asked)
  cols: number
  rows: number
  killed: boolean
}

interface Pending<S> extends PendingOutcome<S> {
  job?: Promise<unknown>
}

export class PendingSpawns<S> {
  private map = new Map<string, Pending<S>>()

  /** Spawns still preparing and still wanted (not closed): the quit guard counts these. */
  get live(): number {
    let n = 0
    for (const p of this.map.values()) if (!p.killed) n++
    return n
  }

  /** Start preparing `id`. `run` gets THIS spawn's outcome() — never a later one's for the
   *  same id (a closed-then-reopened pane starts a new entry while the old one winds down). */
  start<T>(
    id: string,
    sender: S,
    cols: number,
    rows: number,
    run: (outcome: () => PendingOutcome<S>) => Promise<T>,
  ): Promise<T> {
    const p: Pending<S> = { sender, cols, rows, killed: false }
    this.map.set(id, p)
    const outcome = (): PendingOutcome<S> => ({
      sender: p.sender,
      cols: p.cols,
      rows: p.rows,
      killed: p.killed || this.map.get(id) !== p, // replaced by a newer spawn: this one lost
    })
    const job = run(outcome).finally(() => {
      if (this.map.get(id) === p) this.map.delete(id)
    })
    p.job = job
    return job
  }

  /** A later request for a pending id: it becomes the output target and size; same result.
   *  A closed one isn't joined (null): that request is a new pane and spawns afresh. */
  join(id: string, sender: S, cols: number, rows: number): Promise<unknown> | null {
    const p = this.map.get(id)
    if (!p || p.killed) return null
    p.sender = sender
    if (cols > 0 && rows > 0) {
      p.cols = cols
      p.rows = rows
    }
    return p.job ?? null
  }

  /** Record a resize for a pending id; false if the id isn't pending. */
  resize(id: string, cols: number, rows: number): boolean {
    const p = this.live_(id)
    if (!p) return false
    if (cols > 0 && rows > 0) {
      p.cols = cols
      p.rows = rows
    }
    return true
  }

  /** Is `id` still preparing? (Its keystrokes are then swallowed, not written anywhere.) */
  pending(id: string): boolean {
    return this.live_(id) !== undefined
  }

  // A closed entry still winding down no longer owns the id: a new PTY under it (a reopened
  // pane) gets its own keystrokes and resizes.
  private live_(id: string): Pending<S> | undefined {
    const p = this.map.get(id)
    return p && !p.killed ? p : undefined
  }

  /** The pane closed before its process existed; false if the id isn't pending. */
  kill(id: string): boolean {
    const p = this.map.get(id)
    if (!p) return false
    p.killed = true
    return true
  }

  /** Close every spawn still preparing (the app is quitting). */
  killAll(): void {
    for (const p of this.map.values()) p.killed = true
  }
}
