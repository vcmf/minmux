// The folders main watches (fs worker), merged from every owner that wants some: the Files
// panel and each visible folder view. Main takes the whole set at once, so one owner must not
// replace another's: each owner sets its own list, and the union (first owners first, capped)
// is sent once per tick when it changed.
import { WATCH_CAP } from "./dir-listing"

export class WatchSet {
  private owners = new Map<string, string[]>()
  private content = new Set<string>() // owners that want content-only changes too (file tabs)
  private last = ""
  private pending = false
  constructor(
    private readonly send: (dirs: string[], content: string[]) => void,
    // Owners whose folders come first in the capped union, whenever they joined (the Files
    // panel, which had the whole cap to itself before folder views shared it).
    private readonly first: string[] = [],
    private readonly cap = WATCH_CAP,
    // Wrapped: a bare `queueMicrotask` called as this object's method throws in Chromium.
    private readonly schedule: (fn: () => void) => void = (fn) => queueMicrotask(fn),
  ) {}

  /** `owner` now wants `dirs` watched ([] = none); `content`: their content changes too. */
  set(owner: string, dirs: string[], content = false): void {
    const cur = this.owners.get(owner)
    const same = cur ? cur.join("\0") === dirs.join("\0") : dirs.length === 0
    if (same && this.content.has(owner) === (content && dirs.length > 0)) return
    if (dirs.length) this.owners.set(owner, dirs)
    else this.owners.delete(owner)
    if (content && dirs.length) this.content.add(owner)
    else this.content.delete(owner)
    if (this.pending) return
    this.pending = true
    this.schedule(() => this.flush())
  }

  /** The folders sent now (the union, capped). */
  current(): string[] {
    const out = new Set<string>()
    const order = [
      ...this.first.filter((o) => this.owners.has(o)),
      ...[...this.owners.keys()].filter((o) => !this.first.includes(o)),
    ]
    for (const o of order) for (const d of this.owners.get(o)!) out.add(d)
    return [...out].slice(0, this.cap)
  }

  private flush(): void {
    this.pending = false
    const dirs = this.current()
    const on = new Set(dirs)
    const content = [...new Set([...this.content].flatMap((o) => this.owners.get(o) ?? []))].filter(
      (d) => on.has(d),
    )
    const key = `${dirs.join("\0")}\n${content.join("\0")}`
    if (key === this.last) return
    this.last = key
    this.send(dirs, content)
  }
}
