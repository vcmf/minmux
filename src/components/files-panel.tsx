import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CaretRight, CaretDown, Folder, File as FileIcon, X } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { useActiveRemote, useFilesRoot, getActiveWsl } from "../lib/use-active-cwd"
import { RemoteNotice } from "./remote-notice"
import { isAbsoluteHostPath } from "../lib/file-actions"
import {
  FileTreeCache,
  emptyTree,
  setListing,
  toggleDir,
  visibleRows,
  openDirs,
  type FileTreeState,
} from "../lib/file-tree"
import { buildGitDecorations, statusLetter, statusColor } from "../lib/git-decorations"
import { useFileMenu } from "./use-file-menu"
import { RootBreadcrumb } from "./root-breadcrumb"

// Per-root LRU cache so re-focusing a pane (or navigating back to a folder) restores its
// tree instantly instead of re-listing. Bounded to 16 folders (each listing itself capped
// by the backend → a few-MB ceiling). Module-level so it survives the panel unmounting.
const cache = new FileTreeCache(16)

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
    const next = fn(cache.get(key) ?? emptyTree(key))
    cache.set(key, next)
    if (rootRef.current === key) setTree(next)
  }, [])
  const load = useCallback(
    (key: string, dir: string) => {
      // Pass the focused pane's WSL context so a distro's Linux path is read via its
      // \\wsl.localhost\ share (a stale read for a pane you've left is dropped by `apply`).
      void ipc
        .readdir(dir, getActiveWsl())
        .then((listing) => apply(key, (s) => setListing(s, dir, listing)))
    },
    [apply],
  )

  useEffect(() => {
    rootRef.current = root
    if (!root) {
      setTree(null)
      return
    }
    const cached = cache.get(root)
    if (cached) {
      setTree(cached) // instant restore…
      // …then refresh open dirs in the background — but NOT for a WSL pane: each read
      // goes over the slow \\wsl.localhost\ (9p) share, so N at once would stall the
      // refocus. The cached tree is shown as-is; expanding a dir re-reads it fresh.
      if (!getActiveWsl()) openDirs(cached).forEach((dir) => load(root, dir))
    } else {
      const t = emptyTree(root)
      cache.set(root, t)
      setTree(t)
      load(root, root) // first visit: read the root
    }
  }, [root, load])

  const toggle = (dir: string) => {
    if (!root) return
    const cur = cache.get(root) ?? tree // cache is the source of truth (has the latest listings)
    if (!cur) return
    const { state, needsLoad } = toggleDir(cur, dir)
    cache.set(root, state)
    setTree(state)
    if (needsLoad) load(root, needsLoad)
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
          if (r.kind === "note") {
            return (
              <div key={r.path} className="status-faint" style={{ ...pad, padding: "2px 10px" }}>
                {r.name}
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
