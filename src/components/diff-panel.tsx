import { useEffect, useMemo, useState } from "react"
import { CaretRight, FileText, FilePlus, FileX, Folder, X } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { useActiveRemote, useActiveWorkCwd, getActiveWsl } from "../lib/use-active-cwd"
import { RemoteNotice } from "./remote-notice"
import { useFileMenu } from "./use-file-menu"
import { joinPath } from "../lib/file-tree"
import type { ChangeStatus, DiffLine } from "../lib/ipc"

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

  // Keep a valid selection as the file list changes (a folder row has no diff of its own).
  useEffect(() => {
    if (selected && files.some((f) => !f.isDir && f.path === selected)) return
    setSelected(files.find((f) => !f.isDir)?.path ?? null)
  }, [files, selected])

  // Load the unified diff for the selected file (refresh when totals change). Porcelain paths
  // are relative to the repo root, not to the terminal's cwd (which may be a subfolder).
  useEffect(() => {
    if (!cwd || !selected) {
      setDiff([])
      return
    }
    let cancelled = false
    void ipc.gitDiff(git?.root || cwd, selected, getActiveWsl()).then((d) => {
      if (!cancelled) setDiff(d)
    })
    return () => {
      cancelled = true
    }
  }, [cwd, git?.root, selected, git?.add, git?.del])

  // An untracked folder isn't browsed here: it opens in the Files panel, which lists one level
  // at a time and previews big folders.
  const openFolder = (rel: string) => {
    const s = useStore.getState()
    const sid = s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId
    if (!sid || !root) return
    s.setPaneRoot(sid, joinPath(root, rel))
    s.setRightView("files")
  }

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
              <div
                key={f.path}
                className="diff-file"
                title="Untracked folder — open it in Files"
                onMouseDown={(e) => e.button === 0 && openFolder(f.path)}
                onContextMenu={(e) =>
                  openFileMenu(e, {
                    abs: root ? joinPath(root, f.path) : f.path,
                    rel: f.path,
                    isDir: true,
                  })
                }
              >
                <span className="tree-icon">
                  <Folder size={14} weight="fill" color="var(--accent)" />
                </span>
                <div className="tree-labels">
                  <span className="tree-primary">{f.name}/</span>
                  <span className="tree-sub">
                    {f.dir === "." ? "untracked folder" : `${f.dir} · untracked folder`}
                  </span>
                </div>
                <CaretRight size={12} color="var(--dim)" />
              </div>
            ) : (
              <div
                key={f.path}
                className={`diff-file${f.path === selected ? " selected" : ""}`}
                onMouseDown={(e) => e.button === 0 && setSelected(f.path)}
                onContextMenu={(e) =>
                  openFileMenu(e, {
                    abs: root ? joinPath(root, f.path) : f.path,
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
