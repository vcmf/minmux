import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react"
import { FolderSimple } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import type { WslContext } from "../lib/wsl"
import { folderReads } from "../lib/fs-reads"
import { listings } from "../lib/listing-store"
import { BIG_FOLDER } from "../lib/dir-listing"
import { isAbsoluteHostPath } from "../lib/file-actions"
import {
  commonPrefix,
  expandTilde,
  matchDirs,
  sepOf,
  splitPathInput,
  trimTrailingSep,
} from "../lib/path-complete"

const MAX_SHOWN = 200 // suggestions rendered at once; keep typing to narrow
const KEY = "complete\0" // this input's read keys (the queue is shared with folder views)
const subscribe = (fn: () => void) => listings.subscribe(fn)

// Typing inside a name filters a listing already read; only a new folder (a `/` typed or
// deleted) is read, once, through the shared read queue and listings cache.
/** The folder tab's type-a-path box, with folder completion (↑/↓, Tab, Enter, Esc). */
export function PathInput({
  root,
  wsl,
  onSetRoot,
  onClose,
}: {
  root: string
  wsl?: WslContext
  onSetRoot: (path: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(root)
  const [invalid, setInvalid] = useState(false)
  const [open, setOpen] = useState(false) // suggestions shown: after a keystroke, not on entry
  const [sel, setSel] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const platform = useStore((s) => s.platform)
  const hostHome = useStore((s) => s.home)
  const home = wsl ? "" : hostHome // a WSL folder's ~ is the distro's, which we don't know
  const win = platform === "win32" && !wsl
  const ci = !wsl && (platform === "darwin" || platform === "win32")
  const scope = wsl ? `wsl:${wsl.distro ?? ""}` : ""
  const wslRef = useRef(wsl)
  wslRef.current = wsl

  useEffect(() => inputRef.current?.select(), [])

  const q = useMemo(() => splitPathInput(value, home, win), [value, home, win])
  const dir = open ? q?.dir : undefined
  const all = useSyncExternalStore(subscribe, () => listings.get(scope))
  const listing = dir ? all[dir] : undefined
  const matches = useMemo(
    () => (q && listing && !listing.error ? matchDirs(listing.entries, q.prefix, ci) : []),
    [q, listing, ci],
  )
  const cur = sel < matches.length ? sel : -1

  // Read the folder being typed into: now when it has no listing, else a background refresh.
  useEffect(() => {
    if (!dir) return
    const key = `${KEY}${scope}\0${dir}`
    folderReads.drop((k) => k.startsWith(KEY) && k !== key)
    const had = listings.get(scope)[dir]
    folderReads.request({
      key,
      urgent: !had,
      front: !had,
      big: (had?.total ?? 0) > BIG_FOLDER,
      skipIfReadWithin: had ? 5000 : 0,
      run: () =>
        ipc
          .readdir(dir, wslRef.current)
          .then((l) => void listings.set(scope, dir, l))
          .catch(() => {}),
    })
  }, [dir, scope])
  useEffect(() => () => folderReads.drop((k) => k.startsWith(KEY)), [])

  useEffect(() => {
    if (cur >= 0) listRef.current?.children[cur]?.scrollIntoView?.({ block: "nearest" })
  }, [cur])

  const edit = (v: string) => {
    setValue(v)
    setInvalid(false)
    setSel(-1)
    setOpen(true)
  }
  const complete = (name: string) => q && edit(q.base + name + sepOf(q.base))

  const go = async (typed: string) => {
    const p = trimTrailingSep(expandTilde(typed.trim(), home))
    if (p === root) return onClose()
    // Must be an absolute host path AND an existing dir —
    // checked via the pane's WSL context so a Linux path validates through the UNC share.
    if (isAbsoluteHostPath(p) && (await ipc.pathIsDir(p, wsl))) {
      onSetRoot(p)
      onClose()
    } else setInvalid(true)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = matches.length
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!n) return
      e.preventDefault()
      setSel(e.key === "ArrowDown" ? (cur + 1) % n : cur <= 0 ? n - 1 : cur - 1)
    } else if (e.key === "Tab") {
      e.preventDefault()
      if (!open) return setOpen(true)
      if (!q) return
      if (cur >= 0) complete(matches[cur]!)
      else if (n === 1) complete(matches[0]!)
      else {
        const p = commonPrefix(matches, ci)
        if (p.length > q.prefix.length) edit(q.base + p)
      }
    } else if (e.key === "Enter") {
      if (cur >= 0 && q) void go(q.base + matches[cur]!)
      else void go(value)
    } else if (e.key === "Escape") {
      if (open && n) {
        setOpen(false)
        setSel(-1)
      } else onClose()
    }
  }

  const more = matches.length - MAX_SHOWN + (listing?.truncated ? 1 : 0)
  return (
    <div className="root-input-wrap">
      <input
        ref={inputRef}
        className={`root-input${invalid ? " invalid" : ""}`}
        value={value}
        spellCheck={false}
        placeholder="Absolute folder path… (Tab completes)"
        role="combobox"
        aria-expanded={open && matches.length > 0}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={onClose}
      />
      {open && q && matches.length > 0 && (
        <div className="path-suggest" role="listbox" ref={listRef}>
          {matches.slice(0, MAX_SHOWN).map((name, i) => (
            <div
              key={name}
              role="option"
              aria-selected={i === cur}
              className={`path-suggest-item${i === cur ? " sel" : ""}`}
              // mousedown, not click: the input keeps focus (its blur closes the box)
              onMouseDown={(e) => {
                e.preventDefault()
                complete(name)
              }}
            >
              <FolderSimple size={13} className="path-suggest-icon" />
              <span>
                <b>{name.slice(0, q.prefix.length)}</b>
                {name.slice(q.prefix.length)}
              </span>
            </div>
          ))}
          {more > 0 && <div className="path-suggest-more">… more — keep typing to narrow</div>}
        </div>
      )}
    </div>
  )
}
