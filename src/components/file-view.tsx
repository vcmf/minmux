import {
  lazy,
  memo,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"
import {
  ArrowSquareOut,
  Browser,
  FolderOpen,
  FolderSimple,
  PencilSimple,
} from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { watches } from "../lib/fs-reads"
import { formatSize, HIGHLIGHT_MAX } from "../lib/file-preview"
import { files, type FileShown } from "../lib/file-store"
import { edits } from "../lib/edit-store"
import { FILE_READ_CAP } from "../lib/file-tab"
import { gitFileFor, hasDiffToggle } from "../lib/git-file"
import { wantGit } from "../lib/folder-git-poll"
import { repoKey, wantKey } from "../lib/folder-git"
import { samePath } from "../lib/agent-dirs"
import { isMarkdownPath, placeOf, viewOf, type FileEntry } from "../lib/folder-entries"
import { MARKDOWN_MAX } from "../lib/markdown-client"
import { MarkdownView } from "./markdown-view"
import { topBlock } from "../lib/markdown-scroll"
import type { FileView as ViewName } from "../lib/file-store"
import { isAbsoluteHostPath, isHtmlPath, revealLabel } from "../lib/file-actions"
import { findPane } from "../lib/pane-tree"
import { rowWindow } from "../lib/virtual-rows"
import { shortCwd } from "../lib/session-label"
import { restoreSelection, saveSelection, type SavedSelection } from "../lib/keep-selection"

const LINE_H = 18 // every line of a file tab (App.css .file-view-line): the window needs it
const RELOAD_MS = 200 // a live file (an agent writing it) re-reads at most this often
const BIG_RELOAD_MS = 2000 // …and one past the highlight cap (a growing log) this often
const WSL_POLL_MS = 3000 // a WSL file's stamp, checked this often while it shows
const EMPTY: FileShown = {
  data: null,
  lines: [],
  scrollTop: 0,
  diffTop: 0,
  previewTop: 0,
  went: "",
  diff: null,
}
const subscribeFiles = (fn: () => void) => files.subscribe(fn) // stable: no re-subscribe
const subscribeEdits = (fn: () => void) => edits.subscribe(fn)
// CodeMirror and the editor load the first time a file enters Edit (their own chunk).
const FileEditor = lazy(() => import("./file-editor"))

// Read through the fs worker; highlighted in a worker (lib/highlight-client); only the lines in
// view are rendered; its folder is watched while it shows, so an agent's edits appear.
/** A file entry's view in its pane: the file, highlighted, with line numbers. */
export function FileView({ entryId, tabId }: { entryId: string; tabId: string }) {
  const file = useStore((s) => s.objects[entryId]) as FileEntry | undefined
  const home = useStore((s) => s.home)
  const platform = useStore((s) => s.platform)
  const path = file?.path ?? ""
  const wsl = file?.wsl
  // Its state lives in the file store (lib/file-store): a tab switch keeps it, scroll included.
  const shown = useSyncExternalStore(subscribeFiles, () => files.get(entryId) ?? EMPTY)
  const data = shown.data
  const diff = shown.diff
  const editing = useSyncExternalStore(subscribeEdits, () => !!edits.get(entryId))
  useEffect(() => {
    if (!path) return
    files.show(entryId, path, wsl)
    return () => files.hide(entryId) // it may be evicted from now on, not while it shows
  }, [entryId, path, wsl])

  // Watched while it shows; any change in its folder (a content-only one too, on Linux) asks
  // the store to re-read: every RELOAD_MS at most, a big file every BIG_RELOAD_MS. A WSL file
  // can't be watched (its share): its stamp is checked every WSL_POLL_MS while it shows.
  const dir = file ? placeOf(file).path : ""

  // Its git status: its folder's repo (the folder tabs' own poll; the focused terminal's when
  // it's that one). A change git can diff gets its diff (read when its status or stamp moves).
  const focusedGit = useStore((s) => s.git)
  const folderRoot = useStore((s) => (dir ? s.folderRoots[wantKey({ path: dir, wsl })] : undefined))
  const polled = useStore((s) => (folderRoot ? s.folderGit[repoKey(wsl, folderRoot)] : undefined))
  useEffect(() => {
    if (!dir) return
    wantGit(`file:${entryId}`, { path: dir, wsl })
    return () => wantGit(`file:${entryId}`, null)
  }, [entryId, dir, wsl])
  const inFocused =
    !!folderRoot && !wsl && !!focusedGit?.isRepo && samePath(folderRoot, focusedGit.root)
  const repo = inFocused ? focusedGit : polled
  const gf = gitFileFor(repo ?? undefined, path)
  const stampMs = data && "stamp" in data ? (data.stamp?.mtimeMs ?? 0) : 0
  // Not for a new file (all of it is new) nor a rename (git's status has no old path to pair).
  // Asked once the file is read: its stamp is in the key, and a key without it would read twice.
  const diffWant =
    data && gf && gf.status !== "?" && gf.status !== "R" && repo
      ? { root: repo.root, rel: gf.path, key: `${gf.status}:${gf.add}:${gf.del}:${stampMs}` }
      : null
  const diffKey = diffWant ? `${diffWant.root}\0${diffWant.rel}\0${diffWant.key}` : ""
  useEffect(() => {
    files.wantDiff(entryId, diffWant)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what it reads
  }, [entryId, diffKey])
  // Deleted in git and gone (`git rm --cached` keeps the file: that one shows its Source).
  const deleted = gf?.status === "D" && data?.kind === "error"
  // Diff for a text file (an image's or a binary's diff is a "Binary files differ" line), or a
  // deleted one; a diff with no rows (it failed, or there's none to show) falls back to Source.
  const isText = data?.kind === "text"
  const canDiff = hasDiffToggle(gf?.status) && isText
  const asked = file ? viewOf(file) : "source"
  const showDiff = !!diff?.lines.length && (deleted || (canDiff && asked === "diff"))
  // A markdown file renders (Preview, its default) unless it's too big to put in the DOM.
  const markdown = isMarkdownPath(path) && data?.kind === "text"
  const canPreview = markdown && data.size <= MARKDOWN_MAX
  const tooBigToPreview = markdown && !canPreview && asked === "preview"
  // A diff with nothing to show falls back to the file's default: the Preview for markdown.
  const showPreview = !showDiff && canPreview && asked !== "source"
  const view: ViewName = showDiff ? "diff" : showPreview ? "preview" : "source"
  const lines = showDiff ? diff!.html : shown.lines
  const big = (data && "size" in data ? data.size : 0) > HIGHLIGHT_MAX
  useEffect(() => {
    if (!dir) return
    if (wsl) {
      const t = setInterval(() => files.refresh(entryId), WSL_POLL_MS)
      return () => clearInterval(t)
    }
    if (!isAbsoluteHostPath(dir, platform)) return
    const owner = `file:${entryId}`
    watches.set(owner, [dir], true) // its content changes too (an agent editing it in place)
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = ipc.onFsChanged((dirs, content) => {
      if ((!dirs.includes(dir) && !content.includes(dir)) || timer) return
      timer = setTimeout(
        () => {
          timer = undefined
          files.refresh(entryId)
        },
        big ? BIG_RELOAD_MS : RELOAD_MS,
      )
    })
    return () => {
      off()
      clearTimeout(timer)
      watches.set(owner, [])
    }
  }, [dir, wsl, platform, entryId, big])

  // The lines in view (and a margin), from the scroll position, read once a frame at most.
  const scrollRef = useRef<HTMLDivElement>(null)
  const [port, setPort] = useState({ top: 0, h: 0 })
  useEffect(() => {
    const el = scrollRef.current
    if (!el || view === "preview") return // no rows there: the Preview keeps its own scroll
    let raf = 0
    const read = () => {
      raf = 0
      setPort((p) =>
        p.top === el.scrollTop && p.h === el.clientHeight
          ? p
          : { top: el.scrollTop, h: el.clientHeight },
      )
    }
    const onChange = () => {
      if (!raf) raf = requestAnimationFrame(read)
    }
    const onScroll = () => {
      files.setScroll(entryId, el.scrollTop, view)
      onChange()
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    const ro = new ResizeObserver(onChange)
    ro.observe(el)
    read()
    return () => {
      el.removeEventListener("scroll", onScroll)
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [data?.kind, entryId, view])
  const { start, end } = rowWindow(lines.length, LINE_H, port.top, port.h, 0)

  // New lines (the highlighted ones landing, a re-read) rewrite the rows whose HTML changed
  // (LineCode leaves the rest alone), which moves a selection's ends there: it's read before the
  // commit (the DOM still has the committed rows) and put back after it. Each render that changes
  // the lines saves afresh (a discarded render's save is overwritten, never carried over).
  const committedLines = useRef(lines)
  const keptSel = useRef<SavedSelection | null>(null)
  keptSel.current = committedLines.current !== lines ? saveSelection(scrollRef.current) : null
  useLayoutEffect(() => {
    committedLines.current = lines
    const saved = keptSel.current
    keptSel.current = null
    if (saved) restoreSelection(scrollRef.current, saved)
  }, [lines])

  // Shown again (a tab switch, or Source / Diff): back where that view was scrolled, once its
  // lines are in.
  const restored = useRef<ViewName | null>(null) // the view restored, null: none yet
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (view === "preview") restored.current = view // the Preview places itself
    if (restored.current === view || !el || !lines.length) return
    restored.current = view
    el.scrollTop = files.scrollOf(entryId, view)
  }, [lines.length, entryId, view])

  // Opened at a line (a path click's `:12`): scrolled there once the text is in.
  // Asked again (the same link clicked after scrolling away): its `seq` changed, so it goes.
  const line = file?.line
  const goKey = `${line}:${file?.anchor ?? ""}:${file?.seq ?? 0}`
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !line || view !== "source" || !lines.length || files.wentOf(entryId) === goKey)
      return
    files.setWent(entryId, goKey) // the store remembers: a tab switch doesn't jump back
    el.scrollTop = Math.max(0, (line - 1) * LINE_H - el.clientHeight / 3)
  }, [line, goKey, lines.length, entryId, view])

  // Switching between Preview and Source keeps the same lines in view.
  const startLine = useRef<number | null>(null) // for the Preview, from the Source's top line
  // Handed to the Preview once (its first placement): a remount later uses its saved scroll.
  useLayoutEffect(() => {
    if (showPreview) startLine.current = null
  })
  const switchTo = (to: ViewName) => {
    const el = scrollRef.current
    startLine.current = null
    if (el && view === "source" && to === "preview") {
      startLine.current = Math.floor(el.scrollTop / LINE_H) + 1
    }
    const body = el?.firstElementChild as HTMLElement | null
    if (el && body && view === "preview" && to === "source") {
      const top = topBlock(el, body)
      files.setScroll(entryId, (top.line - 1) * LINE_H, "source")
    }
    useStore.getState().setFileView(entryId, to)
  }
  const choices: ViewName[] = [
    ...(canPreview ? (["preview"] as const) : []),
    "source",
    ...(canDiff && diff?.lines.length ? (["diff"] as const) : []),
  ]

  // Wide enough for its biggest line number (the diff's are the file's, not its rows').
  const gutter = useMemo(() => {
    if (!showDiff || !diff) return String(lines.length).length
    let max = 0
    for (const d of diff.lines) max = Math.max(max, d.oldNo ?? 0, d.newNo ?? 0)
    return String(max).length
  }, [showDiff, diff, lines.length])
  const openInEditor = () => ipc.openFile("", path, line)
  const openFolder = () => {
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === tabId)
    const pane = tab && findPane(tab.root, entryId)
    if (pane) s.openFolder(dir, { tabId, paneId: pane.id, wsl })
  }
  // Edit: text that's valid UTF-8 (a save writes back the same bytes) and within the read cap.
  const canEdit =
    data?.kind === "text" && data.editable !== false && !!data.hash && data.size <= FILE_READ_CAP
  const startEdit = () => {
    if (data?.kind !== "text" || !data.hash) return
    const el = scrollRef.current
    let at = line ?? 1
    if (el && view === "source") at = Math.floor(el.scrollTop / LINE_H) + 1
    const body = el?.firstElementChild as HTMLElement | null
    if (el && body && view === "preview") at = topBlock(el, body).line
    editLine.current = at
    useStore.getState().keepEntry(entryId) // a peek being edited is a kept tab: never replaced
    edits.start(entryId, path, wsl, data.text, data.hash)
  }
  const editLine = useRef(1)
  // Done: back to the view it came from, at the editor's top line.
  const doneEditing = (topLine: number) => {
    files.setScroll(entryId, (topLine - 1) * LINE_H, "source")
    restored.current = null
  }
  const canReveal = !wsl && isAbsoluteHostPath(path, platform)
  // A WSL file too: main opens it through the distro's share.
  const canBrowse = isHtmlPath(path) && (!!wsl || isAbsoluteHostPath(path, platform))

  if (!file) return null
  if (editing)
    return (
      <div className="file-view">
        <Suspense fallback={<div className="file-view-note">Loading the editor…</div>}>
          <FileEditor
            entryId={entryId}
            path={path}
            startLine={editLine.current}
            onDone={doneEditing}
          />
        </Suspense>
      </div>
    )
  return (
    // Keyboard focus goes to what scrolls (arrows, PageDown, Space): the lines when it's text.
    <div
      className="file-view"
      data-entry={isText || showDiff ? undefined : entryId}
      tabIndex={isText || showDiff ? undefined : -1}
    >
      <div className="rootbar">
        <span className="file-view-path" title={path}>
          {shortCwd(path, home)}
        </span>
        <div className="rootbar-actions">
          {choices.length > 1 && (
            <span className="seg" role="group" aria-label="View">
              {choices.map((c) => (
                <button
                  key={c}
                  className={`seg-btn${view === c ? " on" : ""}`}
                  onClick={() => view !== c && switchTo(c)}
                >
                  {VIEW_LABEL[c]}
                </button>
              ))}
            </span>
          )}
          {canEdit && (
            <button className="iconbtn" style={btn} title="Edit" onClick={startEdit}>
              <PencilSimple size={13} />
            </button>
          )}
          <button className="iconbtn" style={btn} title="Open its folder" onClick={openFolder}>
            <FolderSimple size={13} />
          </button>
          {canReveal && (
            <button
              className="iconbtn"
              style={btn}
              title={revealLabel(platform)}
              onClick={() => ipc.revealPath(path)}
            >
              <FolderOpen size={13} />
            </button>
          )}
          {canBrowse && (
            <button
              className="iconbtn"
              style={btn}
              title="Open in browser"
              onClick={() => ipc.openInBrowser(path, wsl)}
            >
              <Browser size={13} />
            </button>
          )}
          {!wsl && (
            <button className="iconbtn" style={btn} title="Open in editor" onClick={openInEditor}>
              <ArrowSquareOut size={13} />
            </button>
          )}
        </div>
      </div>
      {showDiff && (
        <div className="file-view-lines" ref={scrollRef} data-entry={entryId} tabIndex={-1}>
          <div style={{ height: lines.length * LINE_H, position: "relative" }}>
            {lines.slice(start, end).map((html, k) => {
              const i = start + k
              const d = diff!.lines[i]!
              return (
                <div
                  key={i}
                  data-row={`d${i}`}
                  className={`file-view-line diff-line ${d.type}`}
                  style={{ top: i * LINE_H }}
                >
                  <span className="file-view-no" style={{ width: `${gutter}ch` }}>
                    {d.type === "hunk" ? "" : (d.oldNo ?? "")}
                  </span>
                  <span className="file-view-no" style={{ width: `${gutter}ch` }}>
                    {d.type === "hunk" ? "" : (d.newNo ?? "")}
                  </span>
                  <span className="diff-sign">
                    {d.type === "add" ? "+" : d.type === "del" ? "−" : ""}
                  </span>
                  {/* highlighted by side in the worker (escaped text in spans) */}
                  <LineCode html={html} />
                </div>
              )
            })}
          </div>
        </div>
      )}
      {tooBigToPreview && (
        <div className="file-view-banner">
          Too large to preview ({formatSize(data.size)}): showing its source.
        </div>
      )}
      {showPreview && (
        <MarkdownView
          entryId={entryId}
          tabId={tabId}
          path={path}
          text={data.text}
          dir={dir}
          root={repo?.root}
          wsl={wsl}
          line={line}
          anchor={file.anchor}
          goKey={goKey}
          startLine={startLine.current}
          scrollRef={scrollRef}
        />
      )}
      {!showDiff && !showPreview && data?.kind === "text" && (
        <div className="file-view-lines" ref={scrollRef} data-entry={entryId} tabIndex={-1}>
          <div style={{ height: lines.length * LINE_H, position: "relative" }}>
            {lines.slice(start, end).map((html, k) => {
              const n = start + k + 1
              const bar = diff?.bars.get(n)
              return (
                <div
                  key={n}
                  data-row={`s${n}`}
                  className={`file-view-line${n === line ? " target" : ""}`}
                  style={{ top: (n - 1) * LINE_H }}
                >
                  <span className={`file-view-bar${bar ? ` ${bar}` : ""}`} />
                  <span className="file-view-no" style={{ width: `${gutter}ch` }}>
                    {n}
                  </span>
                  {/* highlight.js output: escaped text in spans (or plain escaped text) */}
                  <LineCode html={html} />
                </div>
              )
            })}
          </div>
        </div>
      )}
      {!showDiff && data?.kind === "image" && (
        <div className="file-view-image">
          <img src={data.dataUrl} alt={path} />
        </div>
      )}
      {!showDiff && data && data.kind !== "text" && data.kind !== "image" && (
        <div className="file-view-note">
          <span>
            {data.kind === "binary"
              ? `A binary file (${formatSize(data.size)}): minmux doesn't show it.`
              : data.kind === "too-large"
                ? `Too large to show here (${formatSize(data.size)}).`
                : deleted
                  ? "Deleted: git has no diff to show for it."
                  : data.message}
          </span>
          {data.kind !== "error" && !wsl && (
            <button className="link-btn" onClick={openInEditor}>
              Open it outside minmux
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const btn = { width: 22, height: 22 }
const VIEW_LABEL: Record<ViewName, string> = { preview: "Preview", source: "Source", diff: "Diff" }

// React 19 writes innerHTML again whenever `dangerouslySetInnerHTML` is a new object, so each
// render of the view (a scroll frame, a git poll) would rewrite every line in view: the browser
// then moves a selection's ends to the line's edges. Memoized, a line's DOM changes only with it.
/** A line's code: its HTML, written only when it changes. */
const LineCode = memo(function LineCode({ html }: { html: string }) {
  return <span className="file-view-code" dangerouslySetInnerHTML={{ __html: html }} />
})
