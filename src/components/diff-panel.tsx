import { useEffect, useMemo, useState } from "react"
import { CaretDown, CaretRight, FileText, FilePlus, FileX, Folder, X } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { useActiveRemote, useActiveWorkCwd, getActiveWsl } from "../lib/use-active-cwd"
import { RemoteNotice } from "./remote-notice"
import { useFileMenu } from "./use-file-menu"
import type { ChangeStatus, DiffLine } from "../lib/ipc"
import { previewEntries, type DirListing } from "../lib/dir-listing"
import { isAbsoluteHostPath, revealLabel } from "../lib/file-actions"

const fileIcon = (status: ChangeStatus) => {
  if (status === "?" || status === "A")
    return <FilePlus size={14} weight="fill" color="var(--accent)" />
  if (status === "D") return <FileX size={14} weight="fill" color="var(--red)" />
  return <FileText size={14} weight="fill" color="var(--blue)" />
}

/** Right-side git changes panel: changed files + selected-file unified diff. */
export function DiffPanel() {
  const git = useStore((s) => s.git)
  const cwd = useActiveWorkCwd() // the diff of where Claude works (its worktree), if it runs
  const remote = useActiveRemote()
  const [selected, setSelected] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffLine[]>([])

  const files = useMemo(() => git?.files ?? [], [git])

  // Keep a valid selection as the file list changes: a listed file, or one inside an
  // untracked folder (picked from its expanded listing). A folder row has no diff of its own.
  useEffect(() => {
    const valid = (p: string) =>
      files.some((f) => (f.isDir ? p.startsWith(`${f.path}/`) : f.path === p))
    if (selected && valid(selected)) return
    setSelected(files.find((f) => !f.isDir)?.path ?? null)
  }, [files, selected])

  // Load the unified diff for the selected file (refresh when totals change).
  useEffect(() => {
    if (!cwd || !selected) {
      setDiff([])
      return
    }
    let cancelled = false
    // Porcelain paths (and those picked inside an untracked folder) are relative to the repo
    // root, not to the terminal's cwd, which may be a subfolder.
    void ipc.gitDiff(git?.root || cwd, selected, getActiveWsl()).then((d) => {
      if (!cancelled) setDiff(d)
    })
    return () => {
      cancelled = true
    }
  }, [cwd, git?.root, selected, git?.add, git?.del])

  const close = () => useStore.getState().setRightView(null)

  const { menu, openFileMenu } = useFileMenu()
  const root = git?.root ?? ""

  return (
    <div className="diffpanel">
      <div className="diffpanel-header">
        <span className="section-label">Changes</span>
        <span className="diff-summary">
          {remote ? null : git?.isRepo ? (
            <>
              <span className="add">+{git.add}</span> <span className="del">−{git.del}</span>{" "}
              <span className="status-faint">
                · {(git.total ?? files.length).toLocaleString("en-US")}{" "}
                {(git.total ?? files.length) === 1 ? "file" : "files"}
              </span>
            </>
          ) : (
            <span className="status-faint">not a repo</span>
          )}
        </span>
        <button className="iconbtn" style={{ width: 22, height: 22 }} title="Close" onClick={close}>
          <X size={13} />
        </button>
      </div>

      {remote && <RemoteNotice remote={remote} what="changes" />}
      <div className="diff-files">
        {!remote &&
          files.map((f) =>
            f.isDir ? (
              <UntrackedFolder
                key={f.path}
                root={root}
                cwd={cwd ?? root}
                rel={f.path}
                depth={0}
                selected={selected}
                onSelect={setSelected}
                onMenu={openFileMenu}
                refresh={git}
              />
            ) : (
              <div
                key={f.path}
                className={`diff-file${f.path === selected ? " selected" : ""}`}
                onMouseDown={(e) => e.button === 0 && setSelected(f.path)}
                onContextMenu={(e) =>
                  openFileMenu(e, {
                    abs: root ? `${root}/${f.path}` : f.path,
                    rel: f.path,
                    isDir: false,
                  })
                }
              >
                <span className="tree-icon">{fileIcon(f.status)}</span>
                <div className="tree-labels">
                  <span className="tree-primary">{f.name}</span>
                  <span className="tree-sub">{f.dir === "." ? "" : f.dir}</span>
                </div>
                <span className="add">+{f.add}</span>
                <span className="del">−{f.del}</span>
              </div>
            ),
          )}
        {!remote && git?.total && (
          <div className="diff-empty status-faint">
            {(git.total - files.length).toLocaleString("en-US")} more changes not shown
          </div>
        )}
        {!remote && git?.isRepo && files.length === 0 && (
          <div className="diff-empty status-faint">Working tree clean</div>
        )}
      </div>

      {!remote && selected && (
        <div className="diff-body">
          {diff.map((l, i) => (
            <div key={i} className={`diff-line ${l.type}`}>
              <span className="diff-gutter">{l.type === "hunk" ? "" : (l.oldNo ?? "")}</span>
              <span className="diff-gutter">{l.type === "hunk" ? "" : (l.newNo ?? "")}</span>
              <span className="diff-sign">
                {l.type === "add" ? "+" : l.type === "del" ? "−" : ""}
              </span>
              <span className="diff-code">{l.text}</span>
            </div>
          ))}
        </div>
      )}
      {menu}
    </div>
  )
}

/** An untracked folder (git reports it once): expands on click into its direct contents,
 *  listed lazily — a big one previews its first 10 (lib/dir-listing). Files open their diff. */
function UntrackedFolder({
  root,
  cwd,
  rel,
  depth,
  selected,
  onSelect,
  onMenu,
  refresh,
}: {
  root: string
  cwd: string
  rel: string // repo-relative path
  depth: number
  selected: string | null
  onSelect: (rel: string) => void
  onMenu: (e: React.MouseEvent, t: { abs: string; rel: string; isDir: boolean }) => void
  refresh: unknown // the latest git status: an open folder re-lists on each poll
}) {
  const [open, setOpen] = useState(false)
  const [listing, setListing] = useState<DirListing | null>(null)
  const [showAll, setShowAll] = useState(false)
  const platform = useStore((s) => s.platform)
  const abs = root ? `${root}/${rel}` : rel
  const name = rel.split("/").pop() ?? rel

  // Through git, not readdir: what's inside an untracked folder that git ignores (an `.env`,
  // a nested node_modules) must never show as a change — nor its contents as a diff.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    void ipc
      .gitUntrackedList(cwd, rel, getActiveWsl())
      .then((l) => !cancelled && setListing(l))
      .catch(() => !cancelled && setListing({ entries: [], truncated: false, total: 0 }))
    return () => {
      cancelled = true
    }
  }, [open, cwd, rel, refresh])
  const toggle = () => setOpen((o) => !o)
  const menu = (e: React.MouseEvent, relPath: string, isDir: boolean) =>
    onMenu(e, { abs: root ? `${root}/${relPath}` : relPath, rel: relPath, isDir })

  const total = listing ? (listing.total ?? listing.entries.length) : 0
  const { shown, hidden } = listing
    ? previewEntries(listing.entries, total, showAll)
    : { shown: [], hidden: 0 }
  const canReveal = !getActiveWsl() && isAbsoluteHostPath(abs, platform)
  const pad = { paddingLeft: 12 + depth * 14 }

  return (
    <>
      <div
        className="diff-file"
        style={pad}
        title="Untracked folder"
        onMouseDown={(e) => e.button === 0 && toggle()}
        onContextMenu={(e) => menu(e, rel, true)}
      >
        <span className="tree-icon">
          {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
        </span>
        <Folder size={14} weight="fill" color="var(--accent)" />
        <div className="tree-labels">
          <span className="tree-primary">{name}/</span>
          <span className="tree-sub">untracked folder</span>
        </div>
      </div>
      {open &&
        shown.map((e) =>
          e.isDir ? (
            <UntrackedFolder
              key={e.name}
              root={root}
              cwd={cwd}
              rel={`${rel}/${e.name}`}
              depth={depth + 1}
              selected={selected}
              onSelect={onSelect}
              onMenu={onMenu}
              refresh={refresh}
            />
          ) : (
            <div
              key={e.name}
              className={`diff-file${selected === `${rel}/${e.name}` ? " selected" : ""}`}
              style={{ paddingLeft: 12 + (depth + 1) * 14 }}
              onMouseDown={(ev) => ev.button === 0 && onSelect(`${rel}/${e.name}`)}
              onContextMenu={(ev) => menu(ev, `${rel}/${e.name}`, false)}
            >
              <span className="tree-icon">{fileIcon("?")}</span>
              <div className="tree-labels">
                <span className="tree-primary">{e.name}</span>
              </div>
            </div>
          ),
        )}
      {open && listing && hidden > 0 && (
        <div className="status-faint more-row" style={{ paddingLeft: 12 + (depth + 1) * 14 }}>
          <span>{hidden.toLocaleString("en-US")} more</span>
          {shown.length < listing.entries.length && (
            <button className="link-btn" onClick={() => setShowAll(true)}>
              Show all
            </button>
          )}
          {canReveal && (
            <button className="link-btn" onClick={() => ipc.revealPath(abs)}>
              {revealLabel(platform)}
            </button>
          )}
        </div>
      )}
    </>
  )
}
