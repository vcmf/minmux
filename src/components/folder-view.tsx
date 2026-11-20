import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import {
  ArrowClockwise,
  ArrowUp,
  CaretDown,
  CaretRight,
  File as FileIcon,
  Folder,
  TerminalWindow,
} from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { listings } from "../lib/listing-store"
import { folderReads, watches } from "../lib/fs-reads"
import { BIG_FOLDER, WATCH_CAP } from "../lib/dir-listing"
import { hasListing, shownOpenDirs, visibleRows, type FileTreeState } from "../lib/file-tree"
import { EMPTY_VIEW, toggleExpanded } from "../lib/folder-entries"
import { buildGitDecorations, statusColor, statusLetter } from "../lib/git-decorations"
import { isAbsoluteHostPath, revealLabel } from "../lib/file-actions"
import { isInside, samePath } from "../lib/agent-dirs"
import { shortCwd } from "../lib/session-label"
import { useFileMenu } from "./use-file-menu"

const SETTLE_MS = 2000 // one more read this long after a folder's last change event
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
  const home = useStore((s) => s.home)
  const platform = useStore((s) => s.platform)
  const git = useStore((s) => s.git)
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
  // The open folders you can see, as one key: reads and watches follow its content.
  const shown = useMemo(() => (root ? shownOpenDirs(tree) : []), [tree, root])
  const shownKey = shown.join("\0")
  const shownRef = useRef(shown)
  shownRef.current = shown

  // Git marks from the poll that already runs (the focused terminal's repo) when this folder is
  // in that repo; other repos get their own poll later (WORKDIR_OBJECTS.md, step 2b).
  const deco = useMemo(
    () =>
      git?.isRepo && !wsl && (samePath(root, git.root) || isInside(root, git.root))
        ? buildGitDecorations(git.root, git.files)
        : null,
    [git?.isRepo, git?.root, git?.files, root, wsl],
  )

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
  const seen = useRef(new Set<string>())
  useEffect(() => {
    const cur = listings.get(scope)
    for (const dir of shownRef.current) {
      if (seen.current.has(dir)) continue
      seen.current.add(dir)
      const listed = !!cur[dir] && !cur[dir]!.error
      if (!listed) load(dir, true, true)
      else if (!wsl) load(dir, false, false, 1000)
    }
  }, [shownKey, scope, wsl, load])
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
  const parent = root.replace(/[\\/][^\\/]+[\\/]?$/, "") || (root.startsWith("/") ? "/" : "")
  const terminalHere = () => {
    const s = useStore.getState()
    s.setActivePane(tabId, entryId)
    s.newSurface() // in the focused folder (store: focusedFolder)
  }
  const preview = (abs: string, name: string) => {
    if (!isAbsoluteHostPath(abs, platform) && !wsl) return
    useStore.getState().setPreview({ abs, name, wsl })
  }
  const relTo = (abs: string) =>
    abs.startsWith(root) ? abs.slice(root.length).replace(/^[\\/]/, "") : abs
  const { menu, openFileMenu } = useFileMenu({ onSetRoot: setRoot, wsl: !!wsl })

  if (!folder) return null
  return (
    // Focusable, so keyboard focus can land here when this entry is the focus (refocus-terminal).
    <div className="folder-view" data-entry={entryId} tabIndex={-1}>
      <div className="folder-view-header">
        <span className="folder-view-path" title={root}>
          {shortCwd(root, home)}
        </span>
        {parent && parent !== root && (
          <button
            className="iconbtn"
            style={{ width: 22, height: 22 }}
            title="Parent folder"
            onClick={() => setRoot(parent)}
          >
            <ArrowUp size={13} />
          </button>
        )}
        <button
          className="iconbtn"
          style={{ width: 22, height: 22 }}
          title="Refresh"
          onClick={refresh}
        >
          <ArrowClockwise size={13} />
        </button>
        {!wsl && (
          <button
            className="iconbtn"
            style={{ width: 22, height: 22 }}
            title="New terminal here"
            onClick={terminalHere}
          >
            <TerminalWindow size={13} />
          </button>
        )}
      </div>
      <div className="diff-files agents-files folder-view-rows">
        {rows.map((r) => {
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
                    onClick={() => r.dir && setView({ ...view, showAll: [...view.showAll, r.dir] })}
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
                <span className="tree-primary" style={st ? { color: statusColor(st) } : undefined}>
                  {r.name}
                </span>
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
              title="Preview file"
              onMouseDown={(e) => e.button === 0 && preview(r.path, r.name)}
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
        {rows.length === 0 && hasListing(tree, root) && (
          <div className="diff-empty status-faint">This folder is empty.</div>
        )}
      </div>
      {menu}
    </div>
  )
}
