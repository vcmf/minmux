// A file entry in Edit (docs/design/FILE_EDITING.md): CodeMirror on the file's text. Loaded as
// its own chunk the first time a file tab enters Edit. Its state (text, selection, undo) lives in
// lib/edit-store, so a surface switch unmounts this and coming back finds it as it was.
import { useEffect, useRef, useState, useSyncExternalStore } from "react"
import { Compartment, EditorState, Text, type Extension } from "@codemirror/state"
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

const indentSlot = new Compartment()
const languageSlot = new Compartment()

// The base as a CodeMirror text, by entry, made again when the base moves (a save, a reload):
// "unsaved" is the document against it (Text.eq: a length check first, then the text).
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
const refreshDirty = (id: string, state: EditorState) => {
  const doc = baseDoc(id)
  edits.setDirty(id, !!doc && !state.doc.eq(doc))
}

/** Save the editor's text: the cleanup on save first (one undoable change), then the write. */
async function saveView(
  id: string,
  path: string,
  view: EditorView,
  opts?: { overwrite?: boolean; create?: boolean },
): Promise<void> {
  const st = view.state
  const keep = new Set(st.selection.ranges.map((r) => st.doc.lineAt(r.head).number - 1))
  const changes = saveCleanup(st.doc.toString(), keep, keepsTrailingSpace(path))
  if (changes.length) view.dispatch({ changes, userEvent: "input.cleanup" })
  const r = await edits.save(id, view.state.doc.toString(), opts)
  if (r === "saved") {
    const now = (edits.state(id) as EditorState | null) ?? view.state // typed on, or unmounted
    refreshDirty(id, now)
  }
}

const subscribe = (fn: () => void) => edits.subscribe(fn)
const NOT_EDITING: EditShown = { dirty: false, saving: false, notice: null, mixed: false }

/** The editor for entry `entryId` (its edit already started: lib/edit-store `start`). */
export default function FileEditor({
  entryId,
  path,
  startLine,
  onDone,
}: {
  entryId: string
  path: string
  startLine: number // the line to open at (top of the view, or the line a path click named)
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
      const save = (v: EditorView) => (void saveView(entryId, path, v), true)
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
      const line = Math.min(
        Math.max(1, startLine),
        Math.max(1, base.text.split("\n", startLine).length),
      )
      const doc = Text.of(base.text.split("\n"))
      state = EditorState.create({ doc, extensions, selection: { anchor: doc.line(line).from } })
    }
    const view: EditorView = new EditorView({
      state,
      parent: host.current,
      dispatch: (tr) => {
        view.update([tr])
        edits.keep(entryId, view.state)
        if (tr.docChanged) refreshDirty(entryId, view.state)
      },
    })
    viewRef.current = view
    edits.keep(entryId, view.state)
    if (fresh) {
      view.dispatch({
        effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: "start" }),
      })
      // Its language, loaded on first use (a chunk per language).
      const name = path.split(/[\\/]/).pop() ?? path
      const lang = LanguageDescription.matchFilename(languages, name)
      if (lang)
        void lang.load().then((support) => {
          if (viewRef.current === view)
            view.dispatch({ effects: languageSlot.reconfigure(support) })
          else {
            const kept = edits.state(entryId) as EditorState | null
            if (kept)
              edits.keep(entryId, kept.update({ effects: languageSlot.reconfigure(support) }).state)
          }
        })
    } else {
      const top = view.state.selection.main.head
      view.dispatch({ effects: EditorView.scrollIntoView(top, { y: "center" }) })
    }
    view.focus()
    return () => {
      viewRef.current = null
      view.destroy()
    }
    // Built once per mount; the indent setting is applied below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId])

  // The setting is the width for files that show none of their own.
  useEffect(() => {
    const view = viewRef.current
    const base = edits.base(entryId)
    if (!view || !base) return
    view.dispatch({
      effects: indentSlot.reconfigure(indentFor(detectIndent(base.text, path, indentSetting))),
    })
  }, [indentSetting, entryId, path])

  const topLine = () => {
    const view = viewRef.current
    if (!view) return startLine
    return view.state.doc.lineAt(view.lineBlockAtHeight(view.scrollDOM.scrollTop).from).number
  }
  const save = (opts?: { overwrite?: boolean; create?: boolean }) => {
    const view = viewRef.current
    if (view) void saveView(entryId, path, view, opts)
  }
  const reload = async () => {
    const base = await edits.reload(entryId)
    const view = viewRef.current
    if (!base || !view) return
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: base.text } })
    refreshDirty(entryId, view.state)
  }
  const leave = () => {
    const line = topLine()
    edits.stop(entryId)
    baseDocs.delete(entryId)
    onDone(line)
  }
  const done = () => (shown.dirty || shown.saving ? setAsking(true) : leave())
  const saveAndLeave = async () => {
    const view = viewRef.current
    if (!view) return
    await saveView(entryId, path, view)
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
          <button className="seg-btn" onClick={done}>
            Done
          </button>
        </div>
      </div>
      {asking && (
        <div className="file-view-banner file-editor-bar">
          <span>Save your changes before leaving Edit?</span>
          <button className="link-btn" onClick={() => void saveAndLeave()}>
            Save
          </button>
          <button className="link-btn" onClick={leave}>
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
