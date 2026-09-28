import { useEffect, useLayoutEffect, useRef, useState } from "react"
import { clampMenuPosition, type MenuItemSpec } from "../lib/file-actions"

interface Props<Id extends string> {
  x: number
  y: number
  items: MenuItemSpec<Id>[]
  onSelect: (id: Id) => void
  onClose: () => void
}

/** A styled right-click menu anchored at (x, y). Closes on outside click, Escape,
 *  or after a selection; clamps itself into the viewport once measured. Reuses the
 *  `.shell-menu` chrome from the new-tab dropdown. */
export function ContextMenu<Id extends string = MenuItemSpec["id"]>({
  x,
  y,
  items,
  onSelect,
  onClose,
}: Props<Id>) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // Measure, then clamp into the viewport (avoids a first-frame flash off-screen).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos(clampMenuPosition(x, y, r.width, r.height, window.innerWidth, window.innerHeight))
  }, [x, y])

  useEffect(() => {
    // Capture phase + swallow: Escape closes the menu and never reaches a focused terminal
    // (it would send ESC to the PTY — interrupting a running Claude).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [onClose])

  return (
    <>
      <div
        className="menu-backdrop"
        onMouseDown={onClose}
        onContextMenu={(e) => e.preventDefault()}
      />
      <div
        ref={ref}
        className="shell-menu ctx-menu"
        style={{ top: pos.y, left: pos.x }}
        onContextMenu={(e) => e.preventDefault()}
      >
        {items.map((it) => (
          <div key={it.id}>
            {it.separatorBefore && <div className="ctx-sep" />}
            <button
              className="shell-menu-item"
              disabled={it.disabled}
              onMouseDown={(e) => {
                e.preventDefault()
                if (it.disabled) return
                onSelect(it.id)
                onClose()
              }}
            >
              <span>{it.label}</span>
              {it.hint && <span className="shell-menu-def">{it.hint}</span>}
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
