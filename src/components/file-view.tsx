import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { ArrowSquareOut, FolderOpen, FolderSimple } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { watches } from "../lib/fs-reads"
import { formatSize, HIGHLIGHT_MAX } from "../lib/file-preview"
import { files, type FileShown } from "../lib/file-store"
import { placeOf, type FileEntry } from "../lib/folder-entries"
import { isAbsoluteHostPath, revealLabel } from "../lib/file-actions"
import { findPane } from "../lib/pane-tree"
import { rowWindow } from "../lib/virtual-rows"
import { shortCwd } from "../lib/session-label"

const LINE_H = 18 // every line of a file tab (App.css .file-view-line): the window needs it
const RELOAD_MS = 200 // a live file (an agent writing it) re-reads at most this often
const BIG_RELOAD_MS = 2000 // …and one past the highlight cap (a growing log) this often
const WSL_POLL_MS = 3000 // a WSL file's stamp, checked this often while it shows
const EMPTY: FileShown = { data: null, lines: [], scrollTop: 0, went: "" }
const subscribeFiles = (fn: () => void) => files.subscribe(fn) // stable: no re-subscribe

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
  const lines = shown.lines
  useEffect(() => {
    if (!path) return
    files.show(entryId, path, wsl)
    return () => files.hide(entryId) // it may be evicted from now on, not while it shows
  }, [entryId, path, wsl])

  // Watched while it shows; any change in its folder (a content-only one too, on Linux) asks
  // the store to re-read: every RELOAD_MS at most, a big file every BIG_RELOAD_MS. A WSL file
  // can't be watched (its share): its stamp is checked every WSL_POLL_MS while it shows.
  const dir = file ? placeOf(file).path : ""
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
    if (!el) return
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
      files.setScroll(entryId, el.scrollTop)
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
  }, [data?.kind, entryId])
  const { start, end } = rowWindow(lines.length, LINE_H, port.top, port.h, 0)

  // Shown again (a tab switch): back where it was scrolled, once its lines are in.
  const restored = useRef(false)
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (restored.current || !el || !lines.length) return
    restored.current = true
    el.scrollTop = files.scrollOf(entryId)
  }, [lines.length, entryId])

  // Opened at a line (a path click's `:12`): scrolled there once the text is in.
  // Asked again (the same link clicked after scrolling away): its `seq` changed, so it goes.
  const line = file?.line
  const goKey = `${line}:${file?.seq ?? 0}`
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !line || !lines.length || files.wentOf(entryId) === goKey) return
    files.setWent(entryId, goKey) // the store remembers: a tab switch doesn't jump back
    el.scrollTop = Math.max(0, (line - 1) * LINE_H - el.clientHeight / 3)
  }, [line, goKey, lines.length, entryId])

  const gutter = useMemo(() => String(lines.length).length, [lines.length])
  const openInEditor = () => ipc.openFile("", path, line)
  const openFolder = () => {
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === tabId)
    const pane = tab && findPane(tab.root, entryId)
    if (pane) s.openFolder(dir, { tabId, paneId: pane.id, wsl })
  }
  const canReveal = !wsl && isAbsoluteHostPath(path, platform)

  if (!file) return null
  return (
    // Keyboard focus goes to what scrolls (arrows, PageDown, Space): the lines when it's text.
    <div
      className="file-view"
      data-entry={data?.kind === "text" ? undefined : entryId}
      tabIndex={data?.kind === "text" ? undefined : -1}
    >
      <div className="rootbar">
        <span className="file-view-path" title={path}>
          {shortCwd(path, home)}
        </span>
        <div className="rootbar-actions">
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
          {!wsl && (
            <button className="iconbtn" style={btn} title="Open in editor" onClick={openInEditor}>
              <ArrowSquareOut size={13} />
            </button>
          )}
        </div>
      </div>
      {data?.kind === "text" && (
        <div className="file-view-lines" ref={scrollRef} data-entry={entryId} tabIndex={-1}>
          <div style={{ height: lines.length * LINE_H, position: "relative" }}>
            {lines.slice(start, end).map((html, k) => {
              const n = start + k + 1
              return (
                <div
                  key={n}
                  className={`file-view-line${n === line ? " target" : ""}`}
                  style={{ top: (n - 1) * LINE_H }}
                >
                  <span className="file-view-no" style={{ width: `${gutter}ch` }}>
                    {n}
                  </span>
                  {/* highlight.js output: escaped text in spans (or plain escaped text) */}
                  <span className="file-view-code" dangerouslySetInnerHTML={{ __html: html }} />
                </div>
              )
            })}
          </div>
        </div>
      )}
      {data?.kind === "image" && (
        <div className="file-view-image">
          <img src={data.dataUrl} alt={path} />
        </div>
      )}
      {data && data.kind !== "text" && data.kind !== "image" && (
        <div className="file-view-note">
          <span>
            {data.kind === "binary"
              ? `A binary file (${formatSize(data.size)}): minmux doesn't show it.`
              : data.kind === "too-large"
                ? `Too large to show here (${formatSize(data.size)}).`
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
