import { useEffect, useMemo, useState } from "react"
import { FileText, FilePlus, FileX, X } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { useActiveRemote, useActiveWorkCwd, getActiveWsl } from "../lib/use-active-cwd"
import { RemoteNotice } from "./remote-notice"
import { useFileMenu } from "./use-file-menu"
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

  // Keep a valid selection as the file list changes.
  useEffect(() => {
    if (files.length === 0) setSelected(null)
    else if (!selected || !files.some((f) => f.path === selected)) setSelected(files[0]!.path)
  }, [files, selected])

  // Load the unified diff for the selected file (refresh when totals change).
  useEffect(() => {
    if (!cwd || !selected) {
      setDiff([])
      return
    }
    let cancelled = false
    void ipc.gitDiff(cwd, selected, getActiveWsl()).then((d) => {
      if (!cancelled) setDiff(d)
    })
    return () => {
      cancelled = true
    }
  }, [cwd, selected, git?.add, git?.del])

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
                · {files.length} {files.length === 1 ? "file" : "files"}
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
          files.map((f) => (
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
          ))}
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
