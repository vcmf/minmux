import { useState, type ReactNode } from "react"
import { CaretRight, DotsThree, FolderOpen, PencilSimple } from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import type { WslContext } from "../lib/wsl"
import { parseBreadcrumb, collapseBreadcrumb } from "../lib/breadcrumb"
import { PathInput } from "./path-input"
import { refocusActiveTerminal } from "./refocus-terminal"

const MAX_VISIBLE = 3 // trailing crumbs shown inline; the rest fold into the "…" menu

// A collapsible clickable breadcrumb of the current root, a "…" dropdown for folded ancestors,
// browse (native picker) + type-a-path entry (with folder completion, path-input), and the folder tab's own buttons after them.
/** A folder tab's root navigation bar. */
export function RootBreadcrumb({
  root,
  wsl,
  onSetRoot,
  actions,
}: {
  root: string
  wsl?: WslContext // a WSL folder: its paths are checked and picked in the distro
  onSetRoot: (path: string) => void
  actions?: ReactNode
}) {
  const [editing, setEditing] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)

  const setRoot = onSetRoot
  const browse = async () => {
    const picked = await ipc.pickDirectory(root, wsl)
    if (picked) setRoot(picked)
  }

  // Closed (Enter, Esc, Tab out): the keyboard goes back to the pane's view, unless a click
  // already gave it to something else.
  const close = () => {
    setEditing(false)
    refocusActiveTerminal()
  }

  if (editing) {
    return (
      <div className="rootbar">
        <PathInput root={root} wsl={wsl} onSetRoot={setRoot} onClose={close} />
      </div>
    )
  }

  const { hidden, visible } = collapseBreadcrumb(parseBreadcrumb(root), MAX_VISIBLE)

  return (
    <div className="rootbar">
      <div className="crumbs" title={root}>
        {hidden.length > 0 && (
          <span className="crumb-more">
            <button className="crumb" title="Parent folders" onClick={() => setMenuOpen(true)}>
              <DotsThree size={14} weight="bold" />
            </button>
            {menuOpen && (
              <>
                <div className="menu-backdrop" onMouseDown={() => setMenuOpen(false)} />
                <div className="shell-menu crumb-menu">
                  {hidden
                    .slice()
                    .reverse()
                    .map((c) => (
                      <button
                        key={c.path}
                        className="shell-menu-item"
                        onMouseDown={() => {
                          setMenuOpen(false)
                          setRoot(c.path)
                        }}
                      >
                        <span>{c.name}</span>
                      </button>
                    ))}
                </div>
              </>
            )}
            <CaretRight size={11} className="crumb-sep" />
          </span>
        )}
        {visible.map((c, i) => (
          <span key={c.path} className="crumb-seg">
            {i > 0 && <CaretRight size={11} className="crumb-sep" />}
            <button
              className={`crumb${i === visible.length - 1 ? " current" : ""}`}
              onClick={() => setRoot(c.path)}
            >
              {c.name}
            </button>
          </span>
        ))}
      </div>
      <div className="rootbar-actions">
        <button
          className="iconbtn"
          style={btn}
          title="Enter a path"
          onClick={() => setEditing(true)}
        >
          <PencilSimple size={13} />
        </button>
        <button
          className="iconbtn"
          style={btn}
          title="Choose a folder…"
          onClick={() => void browse()}
        >
          <FolderOpen size={13} />
        </button>
        {actions}
      </div>
    </div>
  )
}

const btn = { width: 22, height: 22 }
