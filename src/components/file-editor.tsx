// A file entry in Edit (docs/design/FILE_EDITING.md): CodeMirror on the file's text. Loaded as
// its own chunk the first time a file tab enters Edit. Its state (text, selection, undo) lives in
// lib/edit-store, so a surface switch unmounts this and coming back finds it as it was.
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import {
  Compartment,
  EditorState,
  Text,
  type Extension,
  type StateEffect,
  type TransactionSpec,
} from "@codemirror/state"
import type { SaveResult } from "../lib/file-tab"
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view"
import { history } from "@codemirror/commands"
import { bracketMatching, indentOnInput, LanguageDescription } from "@codemirror/language"
import { search } from "@codemirror/search"
import { languages } from "@codemirror/language-data"
import { useStore } from "../store"
import { edits, type EditShown } from "../lib/edit-store"
import { detectIndent, keepsTrailingSpace, saveCleanup } from "../lib/editor-text"
import { editorKeymap, highlighting, indentFor } from "../lib/editor-cm"
import { shortCwd } from "../lib/session-label"
import { files } from "../lib/file-store"
import { goKeyOf, viewOf, type FileEntry } from "../lib/folder-entries"
import { isFocusedEntry } from "./refocus-terminal"

const indentSlot = new Compartment()
const languageSlot = new Compartment()
const DIRTY_MS = 150 // a same-length text is compared with its base after typing pauses this long

// The editor on screen for each entry: something that lands later (a language, a reload) goes to
// it, or into the kept state when it's unmounted.
const mounted = new Map<string, EditorView>()
function apply(id: string, spec: (state: EditorState) => TransactionSpec): void {
  const view = mounted.get(id)
  if (view) return view.dispatch(spec(view.state))
  const kept = edits.state(id) as EditorState | null
  if (kept) edits.keep(id, kept.update(spec(kept)).state)
}
const current = (id: string) => (mounted.get(id)?.state ?? edits.state(id)) as EditorState | null

// The base as a CodeMirror text, by entry, made again when the base moves (a save, a reload).
const baseDocs = new Map<string, { hash: string; doc: Text }>()
function baseDoc(id: string): Text | null {
  const base = edits.base(id)
  if (!base) return null
  const had = baseDocs.get(id)
  if (had?.hash === base.hash && had.doc.length === base.text.length) return had.doc
  const doc = Text.of(base.text.split("\n"))
  baseDocs.set(id, { hash: base.hash, doc })
  return doc
}

// Unsaved: a length that differs is decided at once; the same length means comparing the whole
// text (up to 2 MB), which waits for a pause in typing, off the keystroke.
const dirtyTimers = new Map<string, ReturnType<typeof setTimeout>>()
function refreshDirty(id: string, state: EditorState, now = false): void {
  const doc = baseDoc(id)
  clearTimeout(dirtyTimers.get(id))
  dirtyTimers.delete(id)
  if (!doc) return
  if (state.doc.length !== doc.length) return edits.setDirty(id, true)
  const compare = () => {
    dirtyTimers.delete(id)
    const latest = current(id)
    if (latest && baseDoc(id) === doc) edits.setDirty(id, !latest.doc.eq(doc))
  }
  if (now) compare()
  else dirtyTimers.set(id, setTimeout(compare, DIRTY_MS))
}

/** Settle a pending unsaved check now (before Done reads it). */
function flushDirty(id: string): void {
  const st = current(id)
  if (dirtyTimers.has(id) && st) refreshDirty(id, st, true)
}

// An edit that ends any other way (its tab closed: store `dropObjects`) drops its caches too.
edits.subscribe(() => {
  for (const id of [...baseDocs.keys()]) if (!edits.get(id)) baseDocs.delete(id)
  for (const [id, t] of [...dirtyTimers]) {
    if (edits.get(id)) continue
    clearTimeout(t)
    dirtyTimers.delete(id)
  }
})

/** Load the file's language (a chunk per language) unless its state already has it. */
function loadLanguage(id: string, path: string, state: EditorState): void {
  const has = languageSlot.get(state)
  if (has && !(Array.isArray(has) && has.length === 0)) return
  const name = path.split(/[\\/]/).pop() ?? path
  const lang = LanguageDescription.matchFilename(languages, name)
  if (lang)
    void lang
      .load()
      .then((support) => {
        if (edits.get(id)) apply(id, () => ({ effects: languageSlot.reconfigure(support) }))
      })
      .catch(() => {}) // a language that won't load: plain text
}

// Works on the editor on screen or, hidden, on its kept state (a close's Save).
/** Save an edit: the cleanup on save first (one undoable change), then the write. */
async function saveEntry(
  id: string,
  opts?: { overwrite?: boolean; create?: boolean },
): Promise<SaveResult["kind"] | "busy"> {
  const path = edits.path(id)
  const st = current(id)
  if (!path || !st) return "error"
  if (edits.get(id)?.saving) return "busy" // one at a time: no cleanup for a save that won't happen
  flushDirty(id)
  const keep = new Set(st.selection.ranges.map((r) => st.doc.lineAt(r.head).number - 1))
  const changes = saveCleanup(st.doc.toString(), keep, keepsTrailingSpace(path))
  // ⌘S on a clean file writes nothing (a write would wake every watcher on it).
  if (!opts && !changes.length && !edits.get(id)?.dirty) return "saved"
  if (changes.length) apply(id, () => ({ changes, userEvent: "input.cleanup" }))
  const r = await edits.save(id, current(id)!.doc.toString(), opts)
  const now = current(id)
  if (r === "saved" && now) refreshDirty(id, now, true) // typed on during the save, or not
  return r
}
// Tracked whole (write + unsaved check): a close's Save and a quit wait for it.
const trackedSave = (id: string, opts?: { overwrite?: boolean; create?: boolean }) => {
  // One already running stays the one tracked (this call would only answer "busy").
  if (edits.get(id)?.saving) return Promise.resolve("busy" as const)
  const p = saveEntry(id, opts)
  edits.track(id, p)
  return p
}
edits.setSaver((id) => trackedSave(id))
edits.setFlusher(() => [...dirtyTimers.keys()].forEach(flushDirty))

/** Stop editing `id`: its state and the editor's own caches go. */
function stopEditing(id: string): void {
  clearTimeout(dirtyTimers.get(id))
  dirtyTimers.delete(id)
  baseDocs.delete(id)
  edits.stop(id)
}

const subscribe = (fn: () => void) => edits.subscribe(fn)
const NOT_EDITING: EditShown = { dirty: false, saving: false, notice: null, mixed: false }

/** The editor for entry `entryId` (its edit already started: lib/edit-store `start`). */
export default function FileEditor({
  entryId,
  tabId,
  path,
  onDone,
}: {
  entryId: string
  tabId: string
  path: string
  onDone: (topLine: number) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const shown = useSyncExternalStore(subscribe, () => edits.get(entryId) ?? NOT_EDITING)
  const home = useStore((s) => s.home)
  const isMac = useStore((s) => s.platform) === "darwin"
  const indentSetting = useStore((s) => s.settings.editorIndent)
  const [asking, setAsking] = useState(false) // Done with unsaved changes: save them?

  useEffect(() => {
    const base = edits.base(entryId)
    if (!host.current || !base) return
    let state = edits.state(entryId) as EditorState | null
    const fresh = !state
    if (!state) {
      const save = () => (void trackedSave(entryId), true)
      const extensions: Extension[] = [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        search({ top: true }),
        highlighting,
        indentSlot.of(indentFor(detectIndent(base.text, path, indentSetting))),
        languageSlot.of([]),
        keymap.of(editorKeymap(save, isMac)),
        // The pane focuses an entry by `data-entry` (refocus-terminal): the text is the entry.
        EditorView.contentAttributes.of({ "data-entry": entryId }),
      ]
      const doc = Text.of(base.text.split("\n"))
      const line = Math.min(Math.max(1, edits.startLine(entryId)), doc.lines)
      state = EditorState.create({ doc, extensions, selection: { anchor: doc.line(line).from } })
    }
    // Back where it was scrolled (a surface switch), as CodeMirror's own snapshot: a scrollTop
    // set before the new view has measured its text would be clamped to 0.
    const snapshot = fresh ? null : (edits.scrollOf(entryId) as StateEffect<unknown> | null)
    const view: EditorView = new EditorView({
      state,
      parent: host.current,
      ...(snapshot ? { scrollTo: snapshot } : {}),
      dispatch: (tr) => {
        view.update([tr])
        edits.keep(entryId, view.state)
        if (tr.docChanged) refreshDirty(entryId, view.state)
      },
    })
    viewRef.current = view
    mounted.set(entryId, view)
    // A fresh edit's document is its base: no second copy made on the first keystroke.
    if (fresh) baseDocs.set(entryId, { hash: base.hash, doc: view.state.doc })
    // Where it's scrolled, kept as it moves (an unmount reads a detached element).
    const onScroll = () => edits.setScroll(entryId, view.scrollSnapshot())
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true })
    edits.keep(entryId, view.state)
    loadLanguage(entryId, path, view.state) // (again after a remount that beat the first load)
    // A fresh one at its start line; a remount never scrolled: at its cursor.
    if (!snapshot) {
      const head = view.state.selection.main.head
      view.dispatch({ effects: EditorView.scrollIntoView(head, { y: fresh ? "start" : "center" }) })
    }
    // The keyboard follows the store, never "whatever just mounted" (the chunk loads late).
    if (isFocusedEntry(tabId, entryId)) view.focus()
    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll)
      if (mounted.get(entryId) === view) mounted.delete(entryId)
      viewRef.current = null
      view.destroy()
    }
    // Built once per mount; the indent setting is applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId])

  // A path click on the file while it's in Edit (`foo.ts:42`): the cursor goes to that line, and
  // it counts as gone there (Done won't jump to it). Asking for its Diff leaves Edit when nothing
  // is unsaved.
  const file = useStore((s) => s.objects[entryId] as FileEntry | undefined)
  const goKey = goKeyOf(file)
  const line = file?.line
  useEffect(() => {
    if (files.wentOf(entryId) === goKey) return
    files.setWent(entryId, goKey)
    if (!line) return
    apply(entryId, (st) => {
      const at = st.doc.line(Math.min(Math.max(1, line), st.doc.lines)).from
      return { selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) }
    })
  }, [entryId, goKey, line])
  const asked = file ? viewOf(file) : "source"
  useEffect(() => {
    // Against what the edit last saw (in the store): a request made while it was hidden counts.
    if (asked === edits.asked(entryId)) return
    edits.setAsked(entryId, asked)
    flushDirty(entryId)
    const now = edits.get(entryId)
    if (asked === "diff" && now && !now.dirty && !now.saving) leaveRef.current()
  }, [asked, entryId])
  const leaveRef = useRef(() => {})

  // The setting is the width for files that show none of their own.
  useEffect(() => {
    const base = edits.base(entryId)
    if (!base) return
    const indent = indentFor(detectIndent(base.text, path, indentSetting))
    apply(entryId, () => ({ effects: indentSlot.reconfigure(indent) }))
  }, [indentSetting, entryId, path])

  const topLine = () => {
    const view = viewRef.current
    if (!view) return edits.startLine(entryId)
    return view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number
  }
  const save = (opts?: { overwrite?: boolean; create?: boolean }) => {
    void trackedSave(entryId, opts)
  }
  const reload = async () => {
    const base = await edits.reload(entryId)
    if (!base) return
    const indent = indentFor(detectIndent(base.text, path, indentSetting))
    apply(entryId, (st) => ({
      changes: { from: 0, to: st.doc.length, insert: base.text },
      effects: indentSlot.reconfigure(indent),
    }))
    const now = current(entryId)
    if (now) refreshDirty(entryId, now, true)
  }
  const leave = () => {
    const line = topLine()
    stopEditing(entryId)
    onDone(line)
  }
  leaveRef.current = leave
  const done = () => {
    flushDirty(entryId) // a same-length edit typed just now
    if (edits.get(entryId)?.dirty) setAsking(true)
    else leave()
  }
  const saveAndLeave = async () => {
    await trackedSave(entryId)
    setAsking(false)
    const now = edits.get(entryId)
    if (now && !now.dirty && !now.notice) leave()
  }

  const n = shown.notice
  return (
    <div className="file-editor">
      <div className="rootbar">
        <span className="file-view-path" title={path}>
          {shown.dirty && <span className="file-editor-dot" title="Unsaved changes" />}
          {shortCwd(path, home)}
        </span>
        <div className="rootbar-actions">
          <button
            className="seg-btn"
            disabled={shown.saving || !shown.dirty}
            title={isMac ? "Save (⌘S)" : "Save (Ctrl+S)"}
            onClick={() => save()}
          >
            {shown.saving ? "Saving…" : "Save"}
          </button>
          {/* Not while a save runs: its answer (a conflict, an error) must have somewhere to show. */}
          <button className="seg-btn" disabled={shown.saving} onClick={done}>
            Done
          </button>
        </div>
      </div>
      {asking && (
        <div className="file-view-banner file-editor-bar">
          <span>Save your changes before leaving Edit?</span>
          <button className="link-btn" disabled={shown.saving} onClick={() => void saveAndLeave()}>
            Save
          </button>
          <button className="link-btn" disabled={shown.saving} onClick={leave}>
            Discard
          </button>
          <button className="link-btn" onClick={() => setAsking(false)}>
            Cancel
          </button>
        </div>
      )}
      {n && (
        <div className="file-view-banner file-editor-bar warn">
          {n.kind === "changed" && (
            <>
              <span>The file changed on disk since you opened it.</span>
              <button className="link-btn" onClick={() => save({ overwrite: true })}>
                Overwrite with mine
              </button>
              <button className="link-btn" onClick={() => void reload()}>
                Reload theirs (drop mine)
              </button>
            </>
          )}
          {n.kind === "missing" && (
            <>
              <span>The file was deleted.</span>
              <button className="link-btn" onClick={() => save({ create: true })}>
                Save it back
              </button>
            </>
          )}
          {n.kind === "unknown" && (
            <>
              <span>The save may not have finished: the file doesn&apos;t hold your text.</span>
              <button className="link-btn" onClick={() => save({ overwrite: true })}>
                Save again
              </button>
              <button className="link-btn" onClick={() => void reload()}>
                Reload theirs (drop mine)
              </button>
            </>
          )}
          {n.kind === "error" && <span>Couldn&apos;t save: {n.message}</span>}
          <button className="link-btn" onClick={() => edits.dismiss(entryId)} title="Dismiss">
            ×
          </button>
        </div>
      )}
      {shown.mixed && !n && (
        <div className="file-view-banner">
          Mixed line endings: saving writes them all the most common way.
        </div>
      )}
      {/* data-keep-focus: the pane's mouseup leaves the keyboard here (the text, its search). */}
      <div className="file-editor-host" ref={host} data-keep-focus />
    </div>
  )
}
