import { useEffect, useRef, useState, type ReactNode } from "react"
import { CaretRight, DotsThree, FolderOpen, PencilSimple } from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import type { WslContext } from "../lib/wsl"
import { parseBreadcrumb, collapseBreadcrumb } from "../lib/breadcrumb"
import { isAbsoluteHostPath } from "../lib/file-actions"

const MAX_VISIBLE = 3 // trailing crumbs shown inline; the rest fold into the "…" menu

// A collapsible clickable breadcrumb of the current root, a "…" dropdown for folded ancestors,
// browse (native picker) + type-a-path entry, and the folder tab's own buttons after them.
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
  const [value, setValue] = useState("")
  const [invalid, setInvalid] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const setRoot = onSetRoot

  const beginEdit = () => {
    setValue(root)
    setInvalid(false)
    setEditing(true)
  }
  useEffect(() => {
    if (editing) inputRef.current?.select()
  }, [editing])

  const applyTyped = async () => {
    const p = value.trim()
    if (p === root) return setEditing(false)
    // Must be an absolute host path AND an existing dir —
    // checked via the pane's WSL context so a Linux path validates through the UNC share.
    if (isAbsoluteHostPath(p) && (await ipc.pathIsDir(p, wsl))) {
      setRoot(p)
      setEditing(false)
    } else {
      setInvalid(true)
    }
  }
  const browse = async () => {
    const picked = await ipc.pickDirectory(root, wsl)
    if (picked) setRoot(picked)
  }

  if (editing) {
    return (
      <div className="rootbar">
        <input
          ref={inputRef}
          className={`root-input${invalid ? " invalid" : ""}`}
          value={value}
          spellCheck={false}
          placeholder="Absolute folder path…"
          onChange={(e) => {
            setValue(e.target.value)
            setInvalid(false)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void applyTyped()
            else if (e.key === "Escape") setEditing(false)
          }}
          onBlur={() => setEditing(false)}
        />
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
        <button className="iconbtn" style={btn} title="Enter a path" onClick={beginEdit}>
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
