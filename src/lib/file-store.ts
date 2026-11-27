// What each file tab shows, kept outside React (docs/design/WORKDIR_OBJECTS.md, step 3a): its
// last read, its highlighted lines, where it was scrolled and the line it last went to. A tab
// switch unmounts the view; coming back shows this at once, then re-reads with the stamp (a file
// that didn't change costs a stat in the fs worker). The store runs the reads: one in flight per
// file, and at most one more after it when a change arrived meanwhile, so a busy folder can't
// cancel every read before it lands. Highlighting runs per text (lib/highlight-client).
import { ipc } from "./ipc"
import { escapeHtml, HIGHLIGHT_MAX, languageForPath } from "./file-preview"
import { assembleDiff, changeBars, diffSides } from "./git-file"
import type { DiffLine } from "./ipc"
import { highlightLines, plainLines } from "./highlight-client"
import type { FileData, FileStamp } from "./file-tab"
import type { WslContext } from "./wsl"

export const FILES_KEPT = 16 // files remembered after their tab hides (least recent go first)
export const DIFF_MIN_MS = 3000 // a file's diff is read again at most this often (a live file)

/** A changed file's diff, as its tab shows it. */
export interface FileDiff {
  lines: DiffLine[]
  html: string[] // each line's HTML, highlighted by side once the worker answers
  bars: Map<number, "add" | "mod" | "del"> // the Source view's change bars, by line number
}

/** What a file tab shows: its text, its diff, or (markdown) the text rendered. */
export type FileView = "source" | "diff" | "preview"

/** One file tab's state. */
export interface FileShown {
  data: Exclude<FileData, { kind: "same" }> | null
  lines: string[] // highlighted (or plain while it's highlighted) HTML, one per line
  scrollTop: number
  diffTop: number // where its Diff view was scrolled (each view keeps its own)
  previewTop: number // …and its markdown Preview
  went: string // the `line:anchor:seq` it last went to (a remount doesn't jump again)
  diff: FileDiff | null
}

interface Entry extends FileShown {
  path: string
  wsl?: WslContext
  stamp?: FileStamp
  reading: boolean
  again: boolean // a change arrived while reading: read once more after
  highlighted: string | null // the text `lines` were highlighted from
  diffKey: string // what `diff` was read for (status and stamp): another key reads it again
  diffAt: number // when its diff was last read (Date.now)
  diffTimer?: ReturnType<typeof setTimeout> // a re-read waiting out DIFF_MIN_MS
  diffWant: DiffWant | null // the latest diff asked for
  diffReading: boolean // a diff read in flight: a newer key waits for it
}

type Read = (path: string, wsl?: WslContext, since?: FileStamp) => Promise<FileData>
type Highlight = (text: string, lang: string | null) => Promise<string[]>
type Diff = (root: string, rel: string, wsl?: WslContext) => Promise<DiffLine[]>
type DiffWant = { root: string; rel: string; key: string }

/** File tabs' state, by entry id, with a change signal for React (useSyncExternalStore). */
export class FileStore {
  private files = new Map<string, Entry>() // insertion order = least → most recently shown
  private snapshots = new Map<string, FileShown>()
  private listeners = new Set<() => void>()
  private showing = new Set<string>() // on screen: never evicted
  private pinned = new Set<string>() // being edited: never evicted (lib/edit-store)

  constructor(
    private readonly read: Read = (p, w, s) => ipc.readFile(p, w, s),
    private readonly highlight: Highlight = highlightLines,
    private readonly cap = FILES_KEPT,
    private readonly diffOf: Diff = (root, rel, wsl) => ipc.gitDiff(root, rel, wsl),
    private readonly now: () => number = Date.now,
  ) {}

  /** What entry `id` shows now (the same object until it changes). */
  get(id: string): FileShown | undefined {
    return this.snapshots.get(id)
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Its tab is showing `path`: keep it, and read it (only what changed since the last read). */
  show(id: string, path: string, wsl?: WslContext): void {
    let e = this.files.get(id)
    if (e && (e.path !== path || e.wsl?.distro !== wsl?.distro || !e.wsl !== !wsl)) {
      this.forget(id) // another file now: start over
      e = undefined
    }
    if (!e) {
      e = {
        path,
        ...(wsl ? { wsl } : {}),
        data: null,
        lines: [],
        scrollTop: 0,
        diffTop: 0,
        previewTop: 0,
        went: "",
        diff: null,
        diffKey: "",
        diffAt: 0,
        diffWant: null,
        diffReading: false,
        reading: false,
        again: false,
        highlighted: null,
      }
    }
    this.files.delete(id)
    this.files.set(id, e) // most recent
    this.showing.add(id)
    // Past the cap, the least recent hidden ones go (a visible one never: it'd go blank).
    for (const old of [...this.files.keys()]) {
      if (this.files.size <= this.cap) break
      if (!this.showing.has(old) && !this.pinned.has(old)) this.forget(old)
    }
    this.publish(id)
    this.refresh(id)
  }

  /** Its tab hid (a tab switch, a close): it may be evicted from now on. */
  hide(id: string): void {
    this.showing.delete(id)
  }

  /** Something in its folder changed: read it again (skipped in the worker if it didn't). */
  refresh(id: string): void {
    const e = this.files.get(id)
    if (!e) return
    if (e.reading) e.again = true
    else void this.readNow(id, e)
  }

  // Kept for when it shows again; nothing re-renders.
  /** Where one of its views (Source, Diff, Preview) is scrolled. */
  setScroll(id: string, top: number, view: FileView = "source"): void {
    const e = this.files.get(id)
    if (!e) return
    if (view === "diff") e.diffTop = top
    else if (view === "preview") e.previewTop = top
    else e.scrollTop = top
  }

  // `key` says what the diff is of (the file's git status and its stamp): the same key keeps the
  // diff it has; none (an unchanged file) drops it. Read in main (bounded `git diff`) at most
  // every DIFF_MIN_MS (an agent writing the file moves its stamp every few hundred ms: each read
  // is a git spawn), the last key always read. Each side is highlighted whole in the worker, so
  // a multi-line comment or string keeps its colours; a big diff is escaped there too.
  /** The file changed in git: have its diff (read only when the key changes). */
  wantDiff(id: string, want: DiffWant | null): void {
    const e = this.files.get(id)
    if (!e) return
    const key = want?.key ?? ""
    if (key === e.diffKey) return
    e.diffKey = key
    e.diffWant = want
    clearTimeout(e.diffTimer)
    e.diffTimer = undefined
    if (!want) {
      e.diff = null
      return this.publish(id)
    }
    if (!e.diffReading) this.scheduleDiff(id, e) // else: when the one in flight lands
  }

  // Now, or once DIFF_MIN_MS has passed since the last read (the first one never waits).
  private scheduleDiff(id: string, e: Entry): void {
    const wait = e.diffAt + DIFF_MIN_MS - this.now()
    if (!e.diff || wait <= 0) return this.readDiff(id, e)
    e.diffTimer = setTimeout(() => {
      e.diffTimer = undefined
      if (this.files.get(id) !== e || !e.diffWant) return
      if (this.showing.has(id)) this.readDiff(id, e)
      else e.diffKey = "" // hidden meanwhile: read when it shows again
    }, wait)
  }

  private readDiff(id: string, e: Entry): void {
    const want = e.diffWant
    if (!want) return
    const key = want.key
    e.diffAt = this.now()
    e.diffReading = true
    const current = () => this.files.get(id) === e && e.diffKey === key
    void this.diffOf(want.root, want.rel, e.wsl)
      .catch((): DiffLine[] => [])
      .then(async (lines) => {
        if (!current()) return
        const bars = changeBars(lines)
        const sides = diffSides(lines)
        const size = sides.old.length + sides.new.length
        const escaped = () => lines.map((l) => escapeHtml(l.text))
        // Plain first; a big one is escaped in the worker (megabytes here would hold up xterm).
        const plain =
          size <= HIGHLIGHT_MAX
            ? escaped()
            : await this.highlight(lines.map((l) => l.text).join("\n"), null).catch(escaped)
        if (!current()) return
        e.diff = { lines, html: plain, bars }
        this.publish(id)
        if (size > HIGHLIGHT_MAX) return // too big to highlight: plain it stays
        const lang = languageForPath(e.path)
        const [o, n] = await Promise.all([
          this.highlight(sides.old, lang),
          this.highlight(sides.new, lang),
        ])
        if (!current() || !e.diff) return
        e.diff = { ...e.diff, html: assembleDiff(sides.at, o, n, (k) => plain[k]!) }
        this.publish(id)
      })
      .catch(() => {}) // a highlight that failed: the plain diff stays
      .finally(() => {
        e.diffReading = false
        // A newer key arrived meanwhile: its turn (throttled).
        if (this.files.get(id) === e && e.diffWant && e.diffKey !== key) this.scheduleDiff(id, e)
      })
  }

  /** Where its view was last scrolled (live: not the snapshot, which only changes on a read). */
  scrollOf(id: string, view: FileView = "source"): number {
    const e = this.files.get(id)
    return (view === "diff" ? e?.diffTop : view === "preview" ? e?.previewTop : e?.scrollTop) ?? 0
  }

  /** The `line:seq` it last scrolled to. */
  wentOf(id: string): string {
    return this.files.get(id)?.went ?? ""
  }

  /** It scrolled to `went` (`line:seq`): a remount won't jump there again. */
  setWent(id: string, went: string): void {
    const e = this.files.get(id)
    if (e) e.went = went
  }

  /** It's being edited (or not any more): kept however many files are open. */
  pin(id: string, on: boolean): void {
    if (on) this.pinned.add(id)
    else this.pinned.delete(id)
  }

  /** It was just saved as `text`: that's its latest read, so the next one is `same`. */
  saved(id: string, text: string, stamp: FileStamp, hash: string): void {
    const e = this.files.get(id)
    if (!e) return
    e.stamp = stamp
    e.data = { kind: "text", text, truncated: false, size: stamp.size, stamp, hash, editable: true }
    if (text !== e.highlighted) void this.highlightNow(id, e, text)
    this.publish(id)
  }

  /** Its entry closed (or another took its place): its text and lines go now. */
  forget(id: string): void {
    clearTimeout(this.files.get(id)?.diffTimer)
    this.files.delete(id)
    this.snapshots.delete(id)
    this.showing.delete(id)
    this.pinned.delete(id)
  }

  private async readNow(id: string, e: Entry): Promise<void> {
    e.reading = true
    try {
      const d = await this.read(e.path, e.wsl, e.data ? e.stamp : undefined).catch(
        (err): FileData => ({ kind: "error", message: String(err) }),
      )
      if (this.files.get(id) !== e) return // closed or reused meanwhile
      if (d.kind !== "same") {
        e.stamp = d.stamp
        e.data = d
        if (d.kind !== "text") {
          e.lines = []
          e.highlighted = null
        } else if (d.text !== e.highlighted) {
          // A first read: plain lines while it's highlighted (a big one waits for the worker:
          // escaping 2 MB here would hold up the thread xterm draws on).
          if (!e.lines.length && d.text.length <= HIGHLIGHT_MAX) e.lines = plainLines(d.text)
          void this.highlightNow(id, e, d.text)
        }
        this.publish(id)
      }
    } finally {
      e.reading = false
      if (e.again && this.files.get(id) === e) {
        e.again = false
        void this.readNow(id, e)
      }
    }
  }

  private async highlightNow(id: string, e: Entry, text: string): Promise<void> {
    const lines = await this.highlight(text, languageForPath(e.path))
    // Still that file, and that text (a newer read's highlight lands after this one's).
    if (this.files.get(id) !== e || e.data?.kind !== "text" || e.data.text !== text) return
    e.lines = lines
    e.highlighted = text
    this.publish(id)
  }

  private publish(id: string): void {
    const e = this.files.get(id)
    if (!e) return
    this.snapshots.set(id, {
      data: e.data,
      lines: e.lines,
      scrollTop: e.scrollTop,
      diffTop: e.diffTop,
      previewTop: e.previewTop,
      went: e.went,
      diff: e.diff,
    })
    this.listeners.forEach((fn) => fn())
  }
}

/** The app's file tabs (one per renderer). */
export const files = new FileStore()
