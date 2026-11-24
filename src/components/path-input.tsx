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
  const [sel, setSel] = useState<string | null>(null) // by name: a re-read may reorder the list
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
  const cur = sel === null ? -1 : matches.indexOf(sel)

  // Read the folder being typed into: now when it has no listing, else a background refresh.
  useEffect(() => {
    if (!dir) return
    const key = `${KEY}${scope}\0${dir}`
    folderReads.drop((k) => k.startsWith(KEY) && k !== key)
    const had = listings.get(scope)[dir]
    // No background refresh on WSL: each read is a slow 9p trip (as in folder views).
    if (had && wslRef.current) return
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
  const gone = useRef(false) // unmounted: a pending check mustn't re-root after a cancel
  useEffect(
    () => () => {
      gone.current = true
      folderReads.drop((k) => k.startsWith(KEY))
    },
    [],
  )

  useEffect(() => {
    if (cur >= 0) listRef.current?.children[cur]?.scrollIntoView?.({ block: "nearest" })
  }, [cur])

  const edit = (v: string) => {
    setValue(v)
    setInvalid(false)
    setSel(null)
    setOpen(true)
  }
  const complete = (name: string) => q && edit(q.base + name + sepOf(q.base))

  const go = async (typed: string) => {
    const p = trimTrailingSep(expandTilde(typed.trim(), home, win), win)
    if (p === root) return onClose()
    // Must be an absolute host path AND an existing dir —
    // checked via the pane's WSL context so a Linux path validates through the UNC share.
    const ok = isAbsoluteHostPath(p) && (await ipc.pathIsDir(p, wsl))
    if (gone.current) return
    if (ok) {
      onSetRoot(p)
      onClose()
    } else setInvalid(true)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const n = matches.length
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!n) return
      e.preventDefault()
      setSel(matches[e.key === "ArrowDown" ? (cur + 1) % n : cur <= 0 ? n - 1 : cur - 1]!)
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
        setSel(null)
      } else onClose()
    }
  }

  // More than shown: past MAX_SHOWN, or past the read's cap (a truncated listing)
  const more = matches.length > MAX_SHOWN || !!listing?.truncated
  return (
    // The pane gives the keyboard to its view on mouseup (terminal-pane). A press that starts
    // in here (caret, a suggestion, the list's scrollbar) must leave it in the input, even when
    // the release lands elsewhere (a picked suggestion's list may be gone by then).
    <div
      className="root-input-wrap"
      onMouseDown={() =>
        window.addEventListener("mouseup", (e) => e.stopPropagation(), {
          capture: true,
          once: true,
        })
      }
    >
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
        <div
          className="path-suggest"
          role="listbox"
          ref={listRef}
          // a press anywhere in the list (its scrollbar too) keeps the input focused
          onMouseDown={(e) => e.preventDefault()}
        >
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
          {more && <div className="path-suggest-more">… more — keep typing to narrow</div>}
        </div>
      )}
    </div>
  )
}
