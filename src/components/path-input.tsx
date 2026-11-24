import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react"
import { FolderSimple } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import type { WslContext } from "../lib/wsl"
import { folderReads } from "../lib/fs-reads"
import type { DirListing } from "../lib/dir-listing"
import { isAbsoluteHostPath } from "../lib/file-actions"
import {
  commonPrefix,
  expandTilde,
  isUncPath,
  matchDirs,
  sepOf,
  splitPathInput,
  trimTrailingSep,
} from "../lib/path-complete"

const MAX_SHOWN = 200 // suggestions rendered at once; keep typing to narrow

// Typing inside a name filters a listing already read; only a new folder (a `/` typed or
// deleted) is read, once, through the shared read queue. Reads land in the box's own cache,
// which lives while it's open; it neither reads nor writes the folder views' listings (whether
// one of those is current isn't known here, and a box's read would go stale under a view).
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
  const id = useId()
  const KEY = `complete\0${id}\0` // this box's read keys (the queue is shared)
  const pending = useRef(new Set<string>()) // folders being read: asked again, not re-read

  useEffect(() => inputRef.current?.select(), [])

  const typed = value.trimStart() // a pasted path often brings a leading space
  const q = useMemo(() => splitPathInput(typed, home, win), [typed, home, win])
  const dir = open ? q?.dir : undefined
  const [own, setOwn] = useState<Record<string, DirListing>>({})
  const listing = dir ? own[dir] : undefined
  const matches = useMemo(
    () => (q && listing && !listing.error ? matchDirs(listing.entries, q.prefix, ci) : []),
    [q, listing, ci],
  )
  const shown = useMemo(() => matches.slice(0, MAX_SHOWN), [matches])
  const cur = sel === null ? -1 : shown.indexOf(sel)
  // A capped read may miss folders (symlinked ones past the cap read as files): Tab won't guess.
  // The hint says so only when it read nothing but folders (dirs sort first).
  const partial = !!listing?.truncated
  const cut = partial && listing.entries.every((e) => e.isDir)
  // Shown with matches, or to say a too-big folder wasn't listed in full
  const listed = open && !!q && !!listing && (shown.length > 0 || cut)

  // Read the folder being typed into, once while the box is open (a failed read: again when
  // it's typed into again).
  useEffect(() => {
    const key = `${KEY}${scope}\0${dir}`
    // A folder typed past: its queued read goes (it reads again when typed into again)
    folderReads.drop((k) => {
      const drop = k.startsWith(KEY) && k !== key
      if (drop) pending.current.delete(k.slice(k.lastIndexOf("\0") + 1))
      return drop
    })
    if (!dir || (own[dir] && !own[dir].error) || pending.current.has(dir)) return
    pending.current.add(dir)
    folderReads.request({
      key,
      urgent: true,
      front: true,
      run: () =>
        ipc
          .readdir(dir, wslRef.current)
          .catch((): DirListing => ({ entries: [], truncated: false, error: true }))
          .then((l) => !gone.current && setOwn((o) => ({ ...o, [dir]: l })))
          .finally(() => pending.current.delete(dir)),
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `own` checked at entry only
  }, [dir, scope, KEY])
  const gone = useRef(false) // unmounted: a pending check mustn't re-root after a cancel
  const goId = useRef(0) // the latest Enter (an edit voids it): older checks are dropped
  useEffect(
    () => () => {
      gone.current = true
      folderReads.drop((k) => k.startsWith(KEY))
    },
    [KEY],
  )

  useEffect(() => {
    if (cur >= 0) listRef.current?.children[cur]?.scrollIntoView?.({ block: "nearest" })
  }, [cur])

  // The pane clips overflow: fit the list in what's left of it below the box, as it resizes.
  useLayoutEffect(() => {
    const list = listRef.current
    const pane = list?.closest(".terminal-pane")
    if (!list || !pane) return
    const fit = () => {
      const room = pane.getBoundingClientRect().bottom - list.getBoundingClientRect().top - 6
      list.style.maxHeight = `${Math.max(48, Math.min(280, room))}px`
    }
    fit()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(fit)
    ro.observe(pane)
    return () => ro.disconnect()
  }, [listed])

  const edit = (v: string) => {
    setValue(v)
    goId.current++
    setInvalid(false)
    setSel(null)
    setOpen(true)
  }
  const complete = (name: string) => q && edit(q.base + name + sepOf(q.base))

  const go = async (path: string) => {
    const p = trimTrailingSep(expandTilde(path.trim(), home, win), win)
    if (p === root) return onClose()
    // Must be an absolute host path AND an existing dir —
    // checked via the pane's WSL context so a Linux path validates through the UNC share.
    const id = ++goId.current
    const ok =
      (isAbsoluteHostPath(p, wsl ? undefined : platform) || (win && isUncPath(p))) &&
      (await ipc.pathIsDir(p, wsl).catch(() => false))
    if (gone.current || id !== goId.current) return
    if (ok) {
      onSetRoot(p)
      onClose()
    } else setInvalid(true)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.nativeEvent.isComposing) return // the IME's keys (pick, confirm, cancel a candidate)
    const n = shown.length // only rows on screen are selectable
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!n) return
      e.preventDefault()
      setSel(shown[e.key === "ArrowDown" ? (cur + 1) % n : cur <= 0 ? n - 1 : cur - 1]!)
    } else if (e.key === "Tab") {
      if (e.shiftKey || !q) return // nothing to complete: Tab moves focus as usual
      e.preventDefault()
      if (!open) return setOpen(true)
      if (cur >= 0) complete(shown[cur]!)
      // More folders past the read's cap may match: only a pick completes
      else if (partial) return
      else if (matches.length === 1) complete(matches[0]!)
      else {
        const p = commonPrefix(matches, ci)
        if (p.length > q.prefix.length) edit(q.base + p)
      }
    } else if (e.key === "Enter") {
      if (cur >= 0 && q) void go(q.base + shown[cur]!)
      else void go(value)
    } else if (e.key === "Escape") {
      if (listed) {
        setOpen(false)
        setSel(null)
      } else onClose()
    }
  }

  // More than shown: past MAX_SHOWN, or past the read's cap (a truncated listing)
  const more = matches.length > MAX_SHOWN || cut
  return (
    // data-keep-focus: the pane's mouseup leaves the keyboard here (terminal-pane), so a press
    // on the caret, a suggestion or the list's scrollbar doesn't close the box.
    <div className="root-input-wrap" data-keep-focus>
      <input
        ref={inputRef}
        className={`root-input${invalid ? " invalid" : ""}`}
        value={value}
        spellCheck={false}
        placeholder="Absolute folder path… (Tab completes)"
        role="combobox"
        aria-expanded={listed}
        aria-controls={listed ? `${id}-list` : undefined}
        aria-activedescendant={cur >= 0 ? `${id}-opt-${cur}` : undefined}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={onKeyDown}
        // Not when the window loses focus (⌘Tab to look a name up): the text stays
        onBlur={() => document.hasFocus() && onClose()}
      />
      {listed && q && (
        <div
          className="path-suggest"
          role="listbox"
          id={`${id}-list`}
          ref={listRef}
          // a press anywhere in the list (its scrollbar too) keeps the input focused
          onMouseDown={(e) => e.preventDefault()}
        >
          {shown.map((name, i) => (
            <div
              key={name}
              role="option"
              id={`${id}-opt-${i}`}
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
          {more && (
            <div className="path-suggest-more">
              {shown.length ? "… more — keep typing to narrow" : "Too many to list — type the name"}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
