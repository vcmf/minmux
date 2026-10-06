import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ArrowClockwise,
  CaretRight,
  CaretDown,
  Folder,
  File as FileIcon,
  X,
} from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { useActiveRemote, useFilesRoot, getActiveWsl } from "../lib/use-active-cwd"
import { RemoteNotice } from "./remote-notice"
import { isAbsoluteHostPath, revealLabel } from "../lib/file-actions"
import {
  FileTreeCache,
  emptyTree,
  setListing,
  toggleDir,
  visibleRows,
  showAllIn,
  openDirs,
  shownOpenDirs,
  hasListing,
  type FileTreeState,
} from "../lib/file-tree"
import { BIG_FOLDER, WATCH_CAP } from "../lib/dir-listing"
import { ReadQueue } from "../lib/read-queue"
import { buildGitDecorations, statusLetter, statusColor } from "../lib/git-decorations"
import { useFileMenu } from "./use-file-menu"
import { RootBreadcrumb } from "./root-breadcrumb"

// Per-root LRU cache so re-focusing a pane (or navigating back to a folder) restores its
// tree instantly instead of re-listing. Bounded to 16 folders (each listing itself capped
// by the backend → a few-MB ceiling). Module-level so it survives the panel unmounting.
const cache = new FileTreeCache(16)
// Every folder read goes through one queue: one at a time, rate-limited, big folders backed
// off (lib/read-queue). Module-level like the cache; a closed panel drops its queued reads,
// and a running read's late result is cached (or dropped by `apply` for a root you've left).
const reads = new ReadQueue()
const SETTLE_MS = 2000 // one more read this long after a folder's last change event

/** Right-rail lazy file browser rooted at the focused pane's root (its cwd by default, or
 *  a per-pane override chosen via the breadcrumb / double-click). Reads ONE directory per
 *  expand; caches per root (restore on revisit). Tree logic is the pure `lib/file-tree`. */
export function FilesPanel() {
  const { root, cwd, sessionId, diverged } = useFilesRoot()
  const remote = useActiveRemote()
  const git = useStore((s) => s.git)
  const [tree, setTree] = useState<FileTreeState | null>(null)
  const rootRef = useRef<string | undefined>(undefined)
  const close = () => useStore.getState().setRightView(null)

  // Git decorations for the current repo (reuses the already-polled store.git; no
  // extra git calls). Files get a status letter + colour, folders get a tinted name.
  const deco = useMemo(
    () => (git?.isRepo ? buildGitDecorations(git.root, git.files) : null),
    // Key on the actual inputs, not the whole git object (setGit replaces it every poll).
    [git?.isRepo, git?.root, git?.files],
  )

  // Apply a state update to a specific root's cache entry; mirror to the UI only if that
  // root is still active — so a late background readdir for a root you've since left
  // updates its cache but never flashes into the current view. useCallback keeps a stable
  // identity (it only closes over the module cache + refs) so the load effect can list it
  // as a dep without re-running on every render.
  const apply = useCallback((key: string, fn: (s: FileTreeState) => FileTreeState) => {
    // Drop a late read for a root that's neither active nor still cached — otherwise it
    // would rebuild a one-listing tree, re-insert it as MRU, and evict a live entry.
    if (rootRef.current !== key && !cache.has(key)) return
    const cur = cache.peek(key) // a background result mustn't reorder the LRU…
    const next = fn(cur ?? emptyTree(key))
    if (next === cur) return // …and an unchanged re-read doesn't re-render
    cache.replace(key, next)
    if (rootRef.current === key) setTree(next)
  }, [])
  // `urgent` = the user is waiting on it (first visit, a folder with no listing yet, Refresh).
  const load = useCallback(
    (key: string, dir: string, urgent = false, front = false, skipIfReadWithin = 0) => {
      // Pass the focused pane's WSL context so a distro's Linux path is read via its
      // \\wsl.localhost\ share (a stale read for a pane you've left is dropped by `apply`).
      const wsl = getActiveWsl()
      // Same test as the tree's preview (lib/dir-listing previewEntries): over BIG_FOLDER.
      const big = (cache.peek(key)?.listings[dir]?.total ?? 0) > BIG_FOLDER
      reads.request({
        key: `${key}\0${dir}`,
        urgent,
        front,
        big,
        skipIfReadWithin,
        run: () =>
          ipc.readdir(dir, wsl).then((listing) => apply(key, (s) => setListing(s, dir, listing))),
      })
    },
    [apply],
  )

  useEffect(() => {
    rootRef.current = root
    // Queued reads for roots no longer shown would hold up this one's.
    reads.drop((k) => !root || !k.startsWith(`${root}\0`))
    if (!root) {
      setTree(null)
      return
    }
    const cached = cache.get(root)
    if (cached) {
      setTree(cached) // instant restore…
      // …then refresh the open dirs you can see in the background — but NOT for a WSL pane:
      // each read goes over the slow \\wsl.localhost\ (9p) share; Refresh re-reads there.
      // A folder without a good listing (its read was dropped, or failed) is read either way.
      const wsl = !!getActiveWsl()
      const shown = new Set(shownOpenDirs(cached))
      for (const dir of openDirs(cached)) {
        if (!hasListing(cached, dir)) load(root, dir, true)
        else if (!wsl && shown.has(dir)) load(root, dir)
      }
    } else {
      const t = emptyTree(root)
      cache.set(root, t)
      setTree(t)
      load(root, root, true) // first visit: read the root
    }
  }, [root, load])

  // A closed panel shows nothing: its queued reads would only hold up the next one.
  useEffect(() => () => reads.drop(() => true), [])

  // ── Live refresh (watchers in main's fs worker) ──
  // Watched: the open folders you can see, on a local pane (a WSL 9p share can't be watched
  // reliably — it refreshes on git changes and focus instead). Capped like main's cap.
  const wslPane = !!getActiveWsl()
  const platform = useStore((s) => s.platform)
  const watched = useMemo(
    () =>
      tree && root && !remote && !wslPane
        ? shownOpenDirs(tree)
            .filter((d) => isAbsoluteHostPath(d, platform))
            .slice(0, WATCH_CAP)
        : [],
    [tree, root, remote, wslPane, platform],
  )
  const watchKey = watched.join("\0")
  useEffect(() => {
    void ipc.fsWatch(watched).catch(() => {})
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the set's content
  }, [watchKey])
  useEffect(() => () => void ipc.fsWatch([]).catch(() => {}), []) // panel closed: stop

  // The open folders you can see now (for the fallbacks below), from the cache's latest.
  const shownNow = useCallback(() => {
    const r = rootRef.current
    const t = r ? cache.peek(r) : undefined
    return r && t ? { r, dirs: shownOpenDirs(t) } : null
  }, [])

  // A watched folder changed: re-read it now, and once more SETTLE_MS after its last event
  // (in case the OS dropped events mid-burst). Both go through the read queue.
  useEffect(() => {
    const settle = new Map<string, ReturnType<typeof setTimeout>>()
    const off = ipc.onFsChanged((dirs) => {
      const now = shownNow()
      if (!now) return
      const shown = new Set(now.dirs)
      for (const d of dirs) {
        if (!shown.has(d)) continue
        load(now.r, d)
        clearTimeout(settle.get(d))
        settle.set(
          d,
          setTimeout(() => {
            settle.delete(d)
            if (rootRef.current === now.r) load(now.r, d)
          }, SETTLE_MS),
        )
      }
    })
    return () => {
      off()
      settle.forEach((t) => clearTimeout(t))
    }
  }, [load, shownNow])

  // Back to the window: re-read the open folders no watcher covers (a WSL pane, past the cap,
  // a folder main couldn't watch) — asked of main, which knows what it really watches.
  useEffect(() => {
    const onFocus = () => {
      void ipc
        .fsWatching()
        .catch(() => [] as string[])
        .then((list) => {
          const now = shownNow()
          const on = new Set(list)
          if (now) now.dirs.filter((d) => !on.has(d)).forEach((d) => load(now.r, d))
        })
    }
    window.addEventListener("focus", onFocus)
    return () => window.removeEventListener("focus", onFocus)
  }, [load, shownNow])

  // A WSL pane: re-read its open folders when the polled git status really changes in the
  // same repo (an agent writing files shows up there) — not on every poll, nor when switching
  // panes or repos (the cached tree is shown as-is then, like the restore above).
  const gitRoot = wslPane ? (git?.root ?? "") : ""
  const gitKey = wslPane ? (git?.files ?? []).map((f) => `${f.status}${f.path}`).join("\n") : ""
  const lastGit = useRef({ root, gitRoot, gitKey })
  useEffect(() => {
    if (wslPane && !gitRoot) {
      // No status (a poll with none yet, or not a repo): keep comparing to the last one — but
      // a different pane starts over, so coming back isn't taken for a change.
      if (lastGit.current.root !== root) lastGit.current = { root, gitRoot: "", gitKey: "" }
      return
    }
    const prev = lastGit.current
    lastGit.current = { root, gitRoot, gitKey }
    const sameRepo = !!gitRoot && prev.root === root && prev.gitRoot === gitRoot
    if (!wslPane || !sameRepo || prev.gitKey === gitKey) return
    const now = shownNow()
    if (now) now.dirs.forEach((d) => load(now.r, d))
  }, [gitKey, gitRoot, root, wslPane, load, shownNow])

  const toggle = (dir: string) => {
    if (!root) return
    const cur = cache.get(root) ?? tree // cache is the source of truth (has the latest listings)
    if (!cur) return
    const { state, needsLoad } = toggleDir(cur, dir)
    cache.set(root, state)
    setTree(state)
    // A folder with no listing yet is awaited; a cached one shows at once and re-reads.
    // A click on a folder not listed yet goes ahead even of a Refresh batch.
    // On a WSL pane a cached folder isn't re-read on expand (each read is a slow 9p trip;
    // Refresh re-reads). A folder read under a second ago isn't read again (rapid toggling).
    if (needsLoad) {
      const waiting = !hasListing(cur, needsLoad)
      if (waiting) load(root, needsLoad, true, true)
      else if (!getActiveWsl()) load(root, needsLoad, false, false, 1000)
    }
  }

  // Re-read every open folder (root + expanded), e.g. after files changed outside the app.
  const refresh = () => {
    const cur = root ? (cache.get(root) ?? tree) : null
    if (root && cur) shownOpenDirs(cur).forEach((d) => load(root, d, true))
  }

  // "Show all" on a big folder's "N more" row (past the first-10 preview).
  const showAll = (dir: string) => {
    if (!root) return
    const cur = cache.get(root) ?? tree
    if (!cur) return
    const state = showAllIn(cur, dir)
    cache.set(root, state)
    setTree(state)
  }
  const rows = useMemo(() => (tree ? visibleRows(tree) : []), [tree])

  const { menu, openFileMenu } = useFileMenu()
  // Path relative to the panel root, for "Copy relative path".
  const relTo = (abs: string) =>
    root && abs.startsWith(root) ? abs.slice(root.length).replace(/^\//, "") : abs
  // Open the preview. A WSL pane's path is an absolute Linux path (/home/…) → allowed;
  // we carry the pane's WSL context so main reads it via the distro's UNC share.
  const preview = (abs: string, name: string) => {
    if (!isAbsoluteHostPath(abs)) return
    useStore.getState().setPreview({ abs, name, wsl: getActiveWsl() })
  }
  // Double-click a folder → make it the panel root. setPaneRoot centralises the
  // host-path / WSL guard, so no need to repeat it here.
  const setRootTo = (p: string) => sessionId && useStore.getState().setPaneRoot(sessionId, p)

  return (
    <div className="diffpanel">
      <div className="diffpanel-header">
        <span className="section-label">Files</span>
        <span style={{ flex: 1 }} />
        {root && (
          <button
            className="iconbtn"
            style={{ width: 22, height: 22 }}
            title="Refresh"
            onClick={refresh}
          >
            <ArrowClockwise size={13} />
          </button>
        )}
        <button className="iconbtn" style={{ width: 22, height: 22 }} title="Close" onClick={close}>
          <X size={13} />
        </button>
      </div>
      {root && <RootBreadcrumb root={root} cwd={cwd} sessionId={sessionId} diverged={diverged} />}
      <div className="diff-files agents-files">
        {remote && <RemoteNotice remote={remote} what="files" />}
        {!root && !remote && (
          <div className="diff-empty status-faint">
            No folder — the focused pane has no cwd yet.
          </div>
        )}
        {rows.map((r) => {
          const pad = { paddingLeft: 8 + r.depth * 14 }
          if (r.kind === "note" || r.kind === "more") {
            // "N more" for a big folder: Show all (up to the listing cap) · Open in Finder.
            const canReveal = !!r.dir && !getActiveWsl() && isAbsoluteHostPath(r.dir, platform)
            return (
              <div
                key={r.path}
                className="status-faint more-row"
                style={{ ...pad, paddingTop: 2, paddingBottom: 2, paddingRight: 10 }}
              >
                <span>{r.name}</span>
                {r.kind === "more" && (
                  <button className="link-btn" onClick={() => r.dir && showAll(r.dir)}>
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
                title="Click to expand · double-click to set as root"
                onMouseDown={(e) => e.button === 0 && toggle(r.path)}
                onDoubleClick={() => setRootTo(r.path)}
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
              <span style={{ flex: "0 0 12px" }} /> {/* lines the icon up with folders' caret */}
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
      </div>
      {menu}
    </div>
  )
}
