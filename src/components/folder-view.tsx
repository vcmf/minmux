import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  File as FileIcon,
  Folder,
  GitBranch,
  TerminalWindow,
} from "@phosphor-icons/react"
import { canOpenTerminalIn, useStore } from "../store"
import { ipc } from "../lib/ipc"
import { listings } from "../lib/listing-store"
import { folderReads, watches } from "../lib/fs-reads"
import { BIG_FOLDER, WATCH_CAP } from "../lib/dir-listing"
import { hasListing, shownOpenDirs, visibleRows, type FileTreeState } from "../lib/file-tree"
import { EMPTY_VIEW, toggleExpanded } from "../lib/folder-entries"
import { buildGitDecorations, statusColor, statusLetter } from "../lib/git-decorations"
import { isAbsoluteHostPath, revealLabel } from "../lib/file-actions"
import { samePath } from "../lib/agent-dirs"
import { useFileMenu } from "./use-file-menu"
import { opensInTab } from "../lib/file-tab"
import { findPane } from "../lib/pane-tree"
import { rowWindow } from "../lib/virtual-rows"
import { RootBreadcrumb } from "./root-breadcrumb"
import { wantGit } from "../lib/folder-git-poll"
import { repoKey, wantKey } from "../lib/folder-git"
import { changesUnder, opensOnDiff } from "../lib/git-file"
import { joinPath } from "../lib/file-tree"

const SETTLE_MS = 2000 // one more read this long after a folder's last change event
const ROW_H = 28 // every row of a folder tab (App.css .folder-view-rows): virtualization needs it
const subscribe = (fn: () => void) => listings.subscribe(fn) // stable: React re-subscribes on change

// The read keys each mounted view needs: a view going away (hidden, closed, re-rooted) drops its
// queued reads that no other view still needs, so they don't hold up the next ones.
const mounted = new Map<string, Set<string>>()
function release(entryId: string, keep: Set<string>): void {
  const mine = mounted.get(entryId)
  if (keep.size) mounted.set(entryId, keep)
  else mounted.delete(entryId)
  if (!mine) return
  const needed = new Set([...mounted.values()].flatMap((s) => [...s]))
  folderReads.drop((k) => mine.has(k) && !keep.has(k) && !needed.has(k))
}
const readKey = (scope: string, dir: string) => `view\0${scope}\0${dir}`

// Listings are shared by path (lib/listing-store); reads and watches go through the renderer's
// one queue and watch set (lib/fs-reads). Mounted only while it's its pane's visible tab, so a
// hidden one costs nothing but its cached listings.
/** A folder entry's view in its pane: a lazy tree on a fixed path. */
export function FolderView({ entryId, tabId }: { entryId: string; tabId: string }) {
  const folder = useStore((s) => s.objects[entryId])
  const view = useStore((s) => s.folderViews[entryId]) ?? EMPTY_VIEW
  const platform = useStore((s) => s.platform)
  const focusedGit = useStore((s) => s.git)
  // A WSL folder with no shell listed for its distro can't host a terminal: no button then.
  const canTerminal = useStore((s) => canOpenTerminalIn(s, entryId))
  const root = folder?.path ?? ""
  const wsl = folder?.wsl
  const scope = wsl ? `wsl:${wsl.distro ?? ""}` : ""

  const all = useSyncExternalStore(subscribe, () => listings.get(scope))
  const tree: FileTreeState = useMemo(
    () => ({
      root,
      listings: all,
      expanded: new Set(view.expanded),
      showAll: new Set(view.showAll),
    }),
    [root, all, view],
  )
  const rows = useMemo(() => (root ? visibleRows(tree) : []), [tree, root])
  // The rows' scroll position and height, read at most once a frame (virtualization).
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
    el.addEventListener("scroll", onChange, { passive: true })
    const ro = new ResizeObserver(onChange)
    ro.observe(el)
    read()
    return () => {
      el.removeEventListener("scroll", onChange)
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])
  // The open folders you can see, as one key: reads and watches follow its content.
  const shown = useMemo(() => (root ? shownOpenDirs(tree) : []), [tree, root])
  const shownKey = shown.join("\0")
  const shownRef = useRef(shown)
  shownRef.current = shown

  // Git marks: from the poll that already runs when this folder is in the focused terminal's
  // repo, else from the folder entries' own poll (lib/folder-git-poll), which this view joins
  // while it's shown.
  useEffect(() => {
    if (!root) return
    wantGit(entryId, { path: root, wsl })
    return () => wantGit(entryId, null)
  }, [entryId, root, wsl])
  // Its repo, from its own `.git` search (lib/folder-git): the focused terminal's repo uses that
  // fresher status; another one, the folder tabs' own poll. Selected by this folder's own keys,
  // so a status change in another repo doesn't re-render this view.
  const folderRoot = useStore((s) => s.folderRoots[wantKey({ path: root, wsl })])
  const polled = useStore((s) => (folderRoot ? s.folderGit[repoKey(wsl, folderRoot)] : undefined))
  const inFocused =
    !!folderRoot && !wsl && !!focusedGit?.isRepo && samePath(folderRoot, focusedGit.root)
  const git = inFocused ? focusedGit : polled
  const deco = useMemo(
    () => (git?.isRepo ? buildGitDecorations(git.root, git.files) : null),
    [git?.isRepo, git?.root, git?.files],
  )
  // Changes only: the changed files under this folder, flat (the Changes panel's list), and
  // their +/− in the bar. Off (the tree) when it isn't in a repo.
  const changes = useMemo(() => changesUnder(git ?? undefined, root), [git, root])
  const sum = useMemo(
    () =>
      changes.reduce((a, f) => ({ add: a.add + f.add, del: a.del + f.del }), { add: 0, del: 0 }),
    [changes],
  )
  const changesOnly = !!view.changesOnly && !!git?.isRepo
  const count = changesOnly ? changes.length : rows.length
  const { start, end } = rowWindow(count, ROW_H, port.top, port.h)

  // `urgent`: the user waits on it (no listing yet, Refresh). One key per folder for every
  // view, so two views on one folder read it once.
  const load = useCallback(
    (dir: string, urgent = false, front = false, skipIfReadWithin = 0) => {
      const big = (listings.get(scope)[dir]?.total ?? 0) > BIG_FOLDER
      folderReads.request({
        key: readKey(scope, dir),
        urgent,
        front,
        big,
        skipIfReadWithin,
        run: () => ipc.readdir(dir, wsl).then((l) => void listings.set(scope, dir, l)),
      })
    },
    [scope, wsl],
  )

  // Shown (mount, re-root, a folder opened): read what has no listing now; refresh the rest
  // in the background (not on WSL: each read is a slow 9p trip; Refresh re-reads there).
  // A shown folder with no listing at all (never read, or evicted from the shared cache) is read
  // whenever it's found missing; the queue keeps it to one read in flight.
  const seen = useRef(new Set<string>())
  useEffect(() => {
    for (const dir of shownRef.current) {
      const l = all[dir]
      if (!l) load(dir, true, true)
      else if (!seen.current.has(dir) && !l.error && !wsl) load(dir, false, false, 1000)
      seen.current.add(dir)
    }
  }, [shownKey, all, scope, wsl, load])
  useEffect(() => () => seen.current.clear(), [root])
  useEffect(() => {
    release(entryId, new Set(shownRef.current.map((d) => readKey(scope, d))))
  }, [shownKey, scope, entryId])
  useEffect(() => () => release(entryId, new Set()), [entryId])

  // Watched while visible: its open folders on this machine (a WSL share can't be watched
  // reliably). Released when it hides or closes.
  const watched = useMemo(
    () => (wsl ? [] : shown.filter((d) => isAbsoluteHostPath(d, platform)).slice(0, WATCH_CAP)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the set's content
    [shownKey, wsl, platform],
  )
  const watchKey = watched.join("\0")
  useEffect(() => {
    watches.set(`view:${entryId}`, watched)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the set's content
  }, [watchKey, entryId])
  useEffect(() => () => watches.set(`view:${entryId}`, []), [entryId])

  // A watched folder changed: re-read it now and once more SETTLE_MS after its last event.
  useEffect(() => {
    if (wsl) return
    const settle = new Map<string, ReturnType<typeof setTimeout>>()
    const off = ipc.onFsChanged((dirs) => {
      const mine = new Set(shownRef.current)
      for (const d of dirs) {
        if (!mine.has(d)) continue
        load(d)
        clearTimeout(settle.get(d))
        settle.set(
          d,
          setTimeout(() => {
            settle.delete(d)
            if (shownRef.current.includes(d)) load(d)
          }, SETTLE_MS),
        )
      }
    })
    return () => {
      off()
      settle.forEach((t) => clearTimeout(t))
    }
  }, [load, wsl])

  // Back to the window: re-read the open folders no watcher covers (past the cap, WSL).
  useEffect(() => {
    const onFocus = () => {
      void ipc
        .fsWatching()
        .catch(() => [] as string[])
        .then((list) => {
          const on = new Set(list)
          shownRef.current.filter((d) => !on.has(d)).forEach((d) => load(d))
        })
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [load])

  const setView = (next: typeof view) => useStore.getState().setFolderView(entryId, next)
  const toggle = (dir: string, expanded: boolean) => {
    setView(toggleExpanded(view, dir, !expanded))
    // Opening a folder seen before in this view: its cached listing shows, and re-reads. (One
    // shown for the first time is read by the "shown" effect above.)
    if (!expanded && seen.current.has(dir) && !wsl) load(dir, false, false, 1000)
  }
  const refresh = () => shownRef.current.forEach((d) => load(d, true))
  const setRoot = (p: string) => useStore.getState().setFolderRoot(entryId, p)
  const terminalHere = () => {
    const s = useStore.getState()
    s.setActivePane(tabId, entryId)
    s.newSurface() // in the focused folder (store: focusedFolder)
  }
  // A file: a tab of this pane (a peek until kept: the next file opened replaces it); one this
  // machine opens in its own app (a PDF, a video) goes there instead.
  const openFile = (abs: string, keep: boolean, diff = false) => {
    if (!isAbsoluteHostPath(abs, platform) && !wsl) return
    const s = useStore.getState()
    // Its own app (main: never one that runs it); one opened on its diff (a deleted PDF) is a tab.
    if (!diff && !opensInTab(abs)) return ipc.openPath(abs, wsl)
    const tab = s.tabs.find((t) => t.id === tabId)
    const pane = tab && findPane(tab.root, entryId)
    if (!pane) return
    s.openFile(abs, { tabId, paneId: pane.id, wsl, peek: !keep, ...(diff ? { diff } : {}) })
    if (keep) {
      const id = useStore.getState().tabs.find((t) => t.id === tabId)?.activeEntryId
      if (id) useStore.getState().keepEntry(id)
    }
  }
  // A new folder in the changes list (git reports it once): a folder tab beside this one.
  const openDir = (abs: string) => {
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === tabId)
    const pane = tab && findPane(tab.root, entryId)
    if (pane) s.openFolder(abs, { tabId, paneId: pane.id, wsl })
  }
  const keepKey = (e: { metaKey: boolean; ctrlKey: boolean }) =>
    platform === "darwin" ? e.metaKey : e.ctrlKey
  const toggleChanges = () => {
    const next = { ...view }
    if (view.changesOnly) delete next.changesOnly
    else next.changesOnly = true
    setView(next)
  }
  const relTo = (abs: string) =>
    abs.startsWith(root) ? abs.slice(root.length).replace(/^[\\/]/, "") : abs
  const { menu, openFileMenu } = useFileMenu({ onSetRoot: setRoot, wsl: !!wsl })

  if (!folder) return null
  return (
    // Focusable, so keyboard focus can land here when this entry is the focus (refocus-terminal).
    <div className="folder-view" data-entry={entryId} tabIndex={-1}>
      <div className="folder-view-header">
        <RootBreadcrumb
          root={root}
          wsl={wsl}
          onSetRoot={setRoot}
          actions={
            <>
              {git?.isRepo && (
                <span className="folder-repo" title={git.root}>
                  {git.branch && (
                    <span className="folder-repo-branch">
                      <GitBranch size={12} />
                      <span className="folder-repo-name">{git.branch}</span>
                    </span>
                  )}
                  {git.ahead > 0 && <span title="Ahead of its upstream">↑{git.ahead}</span>}
                  {git.behind > 0 && <span title="Behind its upstream">↓{git.behind}</span>}
                  {changes.length > 0 || changesOnly ? (
                    <button
                      className={`folder-repo-pill${changesOnly ? " on" : ""}`}
                      title={
                        changesOnly
                          ? "Show the folder"
                          : `Show only the ${changes.length} changed file${changes.length === 1 ? "" : "s"}`
                      }
                      aria-pressed={changesOnly}
                      onClick={toggleChanges}
                    >
                      <span className="add">+{sum.add}</span>
                      <span className="del">−{sum.del}</span>
                    </button>
                  ) : null}
                </span>
              )}
              <button
                className="iconbtn"
                style={{ width: 22, height: 22 }}
                title="Refresh"
                onClick={refresh}
              >
                <ArrowClockwise size={13} />
              </button>
              {canTerminal && (
                <button
                  className="iconbtn"
                  style={{ width: 22, height: 22 }}
                  title="New terminal here"
                  onClick={terminalHere}
                >
                  <TerminalWindow size={13} />
                </button>
              )}
            </>
          }
        />
      </div>
      <div className="diff-files agents-files folder-view-rows" ref={scrollRef}>
        {/* Long trees render only the rows in view (lib/virtual-rows): spacers stand for the rest. */}
        {start > 0 && <div style={{ height: start * ROW_H }} />}
        {changesOnly &&
          changes.slice(start, end).map((f) => {
            const abs = joinPath(git!.root, f.path)
            const color = statusColor(f.status)
            const rel = relTo(abs)
            const slash = rel.replace(/[\\/]+$/, "").search(/[^\\/]*[\\/]?$/)
            return (
              <div
                key={f.path}
                className="diff-file file-row"
                style={{ paddingLeft: 8 }}
                title={
                  f.isDir
                    ? "A new folder: click to open it"
                    : `Click to preview · ${platform === "darwin" ? "⌘" : "Ctrl"}-click to keep it open`
                }
                onClick={(e) => {
                  if (e.button !== 0 || (platform === "darwin" && e.ctrlKey)) return
                  if (f.isDir) return openDir(abs)
                  openFile(abs, keepKey(e), opensOnDiff(f.status, true))
                }}
                onContextMenu={(e) => openFileMenu(e, { abs, rel, isDir: !!f.isDir })}
              >
                {f.isDir ? (
                  <Folder size={14} weight="fill" color="var(--blue)" />
                ) : (
                  <FileIcon size={14} color={color} />
                )}
                <span className="tree-primary" style={{ color }}>
                  {rel.slice(slash)}
                </span>
                {slash > 0 && <span className="folder-change-dir">{rel.slice(0, slash)}</span>}
                <span className="git-badge folder-change-stat">
                  {f.add > 0 && <span className="add">+{f.add}</span>}
                  {f.del > 0 && <span className="del">−{f.del}</span>}
                  <span style={{ color }}>{statusLetter(f.status)}</span>
                </span>
              </div>
            )
          })}
        {!changesOnly &&
          rows.slice(start, end).map((r) => {
            const pad = { paddingLeft: 8 + r.depth * 14 }
            if (r.kind === "note" || r.kind === "more") {
              const canReveal = !!r.dir && !wsl && isAbsoluteHostPath(r.dir, platform)
              return (
                <div
                  key={r.path}
                  className="status-faint more-row"
                  style={{ ...pad, paddingTop: 2, paddingBottom: 2, paddingRight: 10 }}
                >
                  <span>{r.name}</span>
                  {r.kind === "more" && (
                    <button
                      className="link-btn"
                      onClick={() =>
                        r.dir && setView({ ...view, showAll: [...view.showAll, r.dir] })
                      }
                    >
                      Show all
                    </button>
                  )}
                  {canReveal && (
                    <button className="link-btn" onClick={() => r.dir && ipc.revealPath(r.dir)}>
                      {revealLabel(platform)}
                    </button>
                  )}
                </div>
              )
            }
            if (r.kind === "dir") {
              const st = deco?.dir.get(r.path)
              const n = deco?.count.get(r.path)
              return (
                <div
                  key={r.path}
                  className="diff-file file-row"
                  style={pad}
                  title="Click to expand · double-click to make it this tab's folder"
                  onMouseDown={(e) => e.button === 0 && toggle(r.path, r.expanded)}
                  onDoubleClick={() => setRoot(r.path)}
                  onContextMenu={(e) =>
                    openFileMenu(e, { abs: r.path, rel: relTo(r.path), isDir: true })
                  }
                >
                  {r.expanded ? <CaretDown size={12} /> : <CaretRight size={12} />}
                  <Folder size={14} weight="fill" color="var(--blue)" />
                  <span
                    className="tree-primary"
                    style={st ? { color: statusColor(st) } : undefined}
                  >
                    {r.name}
                  </span>
                  {n ? (
                    <span
                      className="git-badge folder-count"
                      title={`${n} changed file${n === 1 ? "" : "s"} inside`}
                    >
                      {n}
                    </span>
                  ) : null}
                </div>
              )
            }
            const st = deco?.file.get(r.path)
            const color = st ? statusColor(st) : undefined
            return (
              <div
                key={r.path}
                className="diff-file file-row"
                style={pad}
                title={`Click to preview · ${platform === "darwin" ? "⌘" : "Ctrl"}-click to keep it open`}
                onClick={(e) => {
                  if (e.button !== 0) return
                  // On a Mac, Ctrl-click is a right-click: its menu, not a kept tab.
                  if (platform === "darwin" && e.ctrlKey) return
                  openFile(r.path, keepKey(e))
                }}
                onContextMenu={(e) =>
                  openFileMenu(e, { abs: r.path, rel: relTo(r.path), isDir: false })
                }
              >
                <span style={{ flex: "0 0 12px" }} />
                <FileIcon size={14} color={color ?? "var(--dim)"} />
                <span className="tree-primary" style={color ? { color } : undefined}>
                  {r.name}
                </span>
                {st && (
                  <span className="git-badge" style={{ color }}>
                    {statusLetter(st)}
                  </span>
                )}
              </div>
            )
          })}
        {end < count && <div style={{ height: (count - end) * ROW_H }} />}
        {changesOnly && changes.length === 0 && (
          <div className="diff-empty status-faint">Nothing changed under this folder.</div>
        )}
        {!changesOnly && rows.length === 0 && hasListing(tree, root) && (
          <div className="diff-empty status-faint">This folder is empty.</div>
        )}
      </div>
      {menu}
    </div>
  )
}
