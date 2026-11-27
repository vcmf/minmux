// Files being edited (docs/design/FILE_EDITING.md): each entry's editor state, the text it was
// loaded from or last saved as (its base, which a save writes over), and how its last save went.
// Kept outside React and Zustand: a surface switch unmounts the editor, and coming back finds its
// text, selection and undo history here. Only an entry's dirty / saving / notice changes publish
// (never a keystroke). The editor state is opaque here: CodeMirror loads with the editor's chunk.
import { ipc } from "./ipc"
import { files } from "./file-store"
import { fromDisk, toDisk, type EditorText } from "./editor-text"
import type { FileData, SaveResult } from "./file-tab"
import type { WslContext } from "./wsl"

/** Why the editor shows a bar: a save that didn't go through, or the file's line endings. */
export type EditNotice =
  | { kind: "changed" } // the file changed since its base: overwrite, or reload theirs
  | { kind: "missing" } // deleted: save it back, or close
  | { kind: "unknown" } // the save may or may not have landed (it hung, or failed part way)
  | { kind: "error"; message: string }

/** What an edited entry's chrome shows. */
export interface EditShown {
  dirty: boolean
  saving: boolean
  notice: EditNotice | null
  mixed: boolean // its line endings were mixed: a save writes them all one way
}

/** The text an edit started from (or last saved), as the editor holds it, with its bytes' hash. */
export type EditBase = EditorText & { hash: string }

interface Edit extends EditShown {
  startLine: number // the line it opened at
  asked: string // the view its entry was asked for, last seen by the editor (a Diff request)
  path: string
  wsl?: WslContext
  base: EditBase
  state: unknown // the editor's own state (CodeMirror's EditorState)
  scroll: unknown // where the editor was scrolled (CodeMirror's scroll snapshot), or null
}

type Write = (
  path: string,
  text: string,
  base: string | null,
  wsl?: WslContext,
  create?: boolean,
) => Promise<SaveResult>
type Read = (path: string, wsl?: WslContext) => Promise<FileData>

/** Edited entries, by entry id, with a change signal for React (useSyncExternalStore). */
export class EditStore {
  private edits = new Map<string, Edit>()
  private snapshots = new Map<string, EditShown>()
  private listeners = new Set<() => void>()

  constructor(
    private readonly write: Write = (p, t, b, w, c) => ipc.writeFile(p, t, b, w, c),
    private readonly read: Read = (p, w) => ipc.readFile(p, w),
    private readonly fileStore: Pick<typeof files, "pin" | "saved"> = files,
  ) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** What entry `id`'s editor shows (the same object until it changes); none: not editing. */
  get(id: string): EditShown | undefined {
    return this.snapshots.get(id)
  }

  /** Entries with unsaved changes (or a save in flight). */
  unsaved(): string[] {
    return [...this.edits].filter(([, e]) => e.dirty || e.saving).map(([id]) => id)
  }

  /** Start editing entry `id` from its read (`raw`: the file's text as read, `hash` its bytes'). */
  start(
    id: string,
    path: string,
    wsl: WslContext | undefined,
    raw: string,
    hash: string,
    startLine = 1,
    asked = "source",
  ): void {
    if (this.edits.has(id)) return
    const text = fromDisk(raw)
    this.edits.set(id, {
      startLine,
      asked,
      path,
      ...(wsl ? { wsl } : {}),
      base: { ...text, hash },
      state: null,
      scroll: null,
      dirty: false,
      saving: false,
      notice: null,
      mixed: text.mixed,
    })
    this.fileStore.pin(id, true)
    this.publish(id)
  }

  /** The line its editor opened at. */
  startLine(id: string): number {
    return this.edits.get(id)?.startLine ?? 1
  }

  /** Its base: what a save writes over, and what "unsaved" compares with. */
  base(id: string): EditBase | undefined {
    return this.edits.get(id)?.base
  }

  /** The editor's state, kept while it's unmounted. */
  state(id: string): unknown {
    return this.edits.get(id)?.state ?? null
  }

  /** Keep the editor's state (every change: no publish). */
  keep(id: string, state: unknown): void {
    const e = this.edits.get(id)
    if (e) e.state = state
  }

  /** The view its entry was last asked for, as the editor saw it (and that it now has). */
  asked(id: string): string | undefined {
    return this.edits.get(id)?.asked
  }

  setAsked(id: string, view: string): void {
    const e = this.edits.get(id)
    if (e) e.asked = view
  }

  /** Where its editor was scrolled (kept while it's unmounted). */
  setScroll(id: string, snapshot: unknown): void {
    const e = this.edits.get(id)
    if (e) e.scroll = snapshot
  }

  scrollOf(id: string): unknown {
    return this.edits.get(id)?.scroll ?? null
  }

  /** Its text differs from its base, or no longer does. */
  setDirty(id: string, dirty: boolean): void {
    const e = this.edits.get(id)
    if (!e || e.dirty === dirty) return
    e.dirty = dirty
    this.publish(id)
  }

  /** Drop a notice (the bar's ×). */
  dismiss(id: string): void {
    const e = this.edits.get(id)
    if (!e?.notice) return
    e.notice = null
    this.publish(id)
  }

  /** Start over from the file as it is now (Reload): the new base, unsaved changes dropped. */
  async reload(id: string): Promise<EditBase | null> {
    const e = this.edits.get(id)
    if (!e) return null
    const r = await this.read(e.path, e.wsl).catch(() => null)
    if (this.edits.get(id) !== e) return null
    if (r?.kind !== "text" || !r.hash || r.editable === false) {
      e.notice = { kind: "error", message: "It can't be read as text now" }
      this.publish(id)
      return null
    }
    const text = fromDisk(r.text)
    e.base = { ...text, hash: r.hash }
    e.mixed = text.mixed
    e.notice = null
    e.dirty = false
    this.publish(id)
    return e.base
  }

  // `overwrite`: over whatever is there now (after `changed` or `unknown`); `create`: write back a
  // file deleted while edited. An `unknown` is settled by reading the file back.
  /** Save `text` (the editor's, already cleaned up); resolves with how it went. */
  async save(
    id: string,
    text: string,
    opts: { overwrite?: boolean; create?: boolean } = {},
  ): Promise<SaveResult["kind"] | "busy"> {
    const e = this.edits.get(id)
    if (!e) return "error"
    if (e.saving) return "busy" // one at a time (⌘S held down)
    e.saving = true
    e.notice = null
    this.publish(id)
    const disk = toDisk(text, e.base)
    let r: SaveResult
    try {
      let base: string | null = e.base.hash
      let create = !!opts.create
      if (opts.overwrite) {
        const now = await this.read(e.path, e.wsl).catch(() => null)
        if (now?.kind === "text" && now.hash) base = now.hash
        else if (now?.kind === "error" && now.gone) {
          create = true // deleted: written back
          base = null
        } else base = null // unreadable, or not text now (a binary, too large): refused below
      }
      r =
        base === null && !create
          ? { kind: "error", message: "It can't be read as text now" }
          : await this.write(e.path, disk, base, e.wsl, create)
      if (r.kind === "unknown") r = await this.settle(e, disk)
    } catch (err) {
      r = { kind: "error", message: String(err) }
    }
    if (this.edits.get(id) !== e) return r.kind // closed meanwhile
    e.saving = false
    if (r.kind === "saved") {
      e.base = { text, bom: e.base.bom, eol: e.base.eol, mixed: false, hash: r.hash }
      e.mixed = false
      this.fileStore.saved(id, disk, r.stamp, r.hash)
    } else {
      e.notice = r.kind === "error" ? { kind: "error", message: r.message } : { kind: r.kind }
    }
    this.publish(id)
    return r.kind
  }

  // Read the file back: it holds what was sent (the save landed), or it doesn't (yet).
  private async settle(e: Edit, disk: string): Promise<SaveResult> {
    const now = await this.read(e.path, e.wsl).catch(() => null)
    if (now?.kind === "text" && now.text === disk && now.hash && now.stamp)
      return { kind: "saved", stamp: now.stamp, hash: now.hash }
    return { kind: "unknown" }
  }

  /** Stop editing (Done, Discard, its entry closed): its state and base go. */
  stop(id: string): void {
    if (!this.edits.delete(id)) return
    this.fileStore.pin(id, false)
    this.snapshots.delete(id)
    this.listeners.forEach((fn) => fn())
  }

  private publish(id: string): void {
    const e = this.edits.get(id)
    if (!e) return
    this.snapshots.set(id, { dirty: e.dirty, saving: e.saving, notice: e.notice, mixed: e.mixed })
    this.listeners.forEach((fn) => fn())
  }
}

/** The app's edited files (one per renderer). */
export const edits = new EditStore()
