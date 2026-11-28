import { useDriven } from "../lib/driven-store"
import { useEffect, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  Desktop,
  Globe,
  Plugs,
  Terminal,
  TerminalWindow,
  X,
  Columns,
  Rows,
  Folder,
  FolderPlus,
  FileText,
} from "@phosphor-icons/react"
import { TerminalManager } from "../terminal/terminal-manager"
import { ipc } from "../lib/ipc"
import { activeTheme, useStore } from "../store"
import { sessionColor } from "../lib/session-color"
import { agentByPane, type AgentKind } from "../lib/agent-graph"
import {
  canMove,
  findPaneById,
  paneSessionIds,
  visibleSessionIds,
  visibleTerminal,
  type MoveTarget,
} from "../lib/pane-tree"
import { SURFACE_DRAG_TYPE } from "../lib/group-move"
import { dropZone, insertIndex } from "../lib/drop-zone"
import { displaySessionTitle, shellType, shortCwd } from "../lib/session-label"
import { hostColor, hostColorCss, remoteWhere } from "../lib/ssh-hosts-ui"
import { isIdle, remoteStatusUi } from "../lib/remote-connect"
import { canRetry, type SshFailure } from "../lib/ssh-errors"
import { statusUi } from "../lib/status-ui"
import { stripOverflow } from "../lib/strip-overflow"
import { newSurfaceKey } from "../lib/platform"
import { resolveDefaultShell } from "../lib/shells"
import type { DropZone, PaneLeaf } from "../types"
import { ResumeBanner } from "./resume-banner"
import { IntegrationHint } from "./integration-hint"
import { AgentHint } from "./agent-hint"
import { agentIcon } from "./agent-icon"
import { FolderView } from "./folder-view"
import { FileView } from "./file-view"
import { ContextMenu } from "./context-menu"
import { focusEntry } from "./refocus-terminal"
import { UnsavedMark } from "./unsaved-mark"
import { isTerminalEntry } from "../lib/entries"
import { folderChoices, type FolderChoice } from "../lib/folder-entries"
import { agentWorkDirs } from "../lib/agent-dirs"
import { baseName } from "../lib/file-tree"
import { wslContext } from "../lib/wsl"

/** A pane: a strip of terminal tabs (surfaces) + a mount point for the visible one.
 *  Terminals live in TerminalManager, so switching surfaces re-attaches (no respawn). */
export function TerminalPane({ pane, tabId }: { pane: PaneLeaf; tabId: string }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const folderRef = useRef<HTMLDivElement>(null) // the folder view's box, while one shows
  // The terminal font (a change refits the parked terminals behind a folder).
  const fontKey = useStore((s) => {
    const f = s.settings.font
    return `${f.family}|${f.size}|${f.lineHeight}`
  })
  const stripRef = useRef<HTMLDivElement>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; hasSel: boolean } | null>(null)
  const activeId = pane.activeEntryId
  const isTerm = isTerminalEntry(activeId) // else a folder entry shows in place of a terminal
  // Each entry's kind, path and peek flag ("" for a terminal), flat: the strip re-renders only
  // on a change.
  const objFlat = useStore(
    useShallow((s) =>
      pane.entryIds.flatMap((id) => {
        const o = s.objects[id]
        return [o?.kind ?? "", o?.path ?? "", o?.kind === "file" && o.peek ? "1" : ""]
      }),
    ),
  )
  const objAt = (i: number) => ({
    kind: objFlat[i * 3] as "" | "folder" | "file",
    path: objFlat[i * 3 + 1]!,
    peek: objFlat[i * 3 + 2] === "1",
  })
  const activeKind = objAt(pane.entryIds.indexOf(activeId)).kind
  const [folderMenu, setFolderMenu] = useState<{
    x: number
    y: number
    choices: FolderChoice[]
  } | null>(null)
  const surfaces = useStore(useShallow((s) => pane.entryIds.map((id) => s.sessions[id])))
  // Each surface's agent session colour (/color, or derived from /rename) — undefined = none.
  const agentMeta = useStore((s) => s.agentMeta) // stable ref — changes only on a meta update
  const scheme = useStore((s) => activeTheme(s).scheme)
  const accents = pane.entryIds.map((id) => sessionColor(agentMeta[id], scheme))
  // Which agent runs in each surface, as one string ("claude,,codex") so a hook event only
  // re-renders the pane when that changes.
  const agentFlags = useStore((s) => {
    const byPane = agentByPane(s.agents)
    return pane.entryIds.map((id) => byPane[id] ?? "").join(",")
  }).split(",")
  const home = useStore((s) => s.home)
  const session = surfaces[pane.entryIds.indexOf(activeId)]
  const drivenBy = useDriven((s) => (session ? s.by[session.id] : undefined))
  const focused = useStore(
    (s) =>
      s.activeTabId === tabId && s.tabs.find((t) => t.id === tabId)?.activeEntryId === activeId,
  )
  const status = session?.status ?? "idle"
  // An ssh pane waiting at a Connect prompt (restored on-focus, closed, or failed).
  const remoteIdle = useStore((s) => {
    const p = s.remotePhase[activeId]
    return isIdle(p) ? p : undefined
  })
  // The failure kind (phase failed) or "ended" / "lost" (phase closed).
  const remoteDetail = useStore((s) => s.remoteDetail[activeId])
  const failure = remoteDetail as SshFailure | undefined
  const sshHosts = useStore((s) => s.sshHosts)
  const hostColors = useStore((s) => s.settings.ssh.colors)
  // A surface's host colour as CSS (undefined = none set, or a local shell).
  const colorOf = (s: { remote?: { target: string } } | undefined) => {
    const c = s?.remote ? hostColor(s.remote.target, hostColors) : undefined
    return c ? hostColorCss(c) : undefined
  }
  const activeColor = colorOf(session)
  // Each surface's remote phase + detail, flat primitives (a surface tab shows its state dot).
  const remoteFlat = useStore(
    useShallow((s) =>
      pane.entryIds.flatMap((id) => [s.remotePhase[id] ?? "", s.remoteDetail[id] ?? ""]),
    ),
  )
  // The focus/attention top rail only disambiguates between panes — pointless when
  // the tab has a single pane, so suppress it there.
  const isSplit = useStore((s) => {
    const tab = s.tabs.find((t) => t.id === tabId)
    return tab ? tab.root.type === "split" : false
  })
  const multi = pane.entryIds.length > 1
  // A terminal is being dragged — from this group or another (whose drag opened this one) —
  // → show drop targets (overlay + strip markers).
  const dragging = useStore((s) => s.dragging)
  const [dropHint, setDropHint] = useState<DropZone | null>(null)
  const [stripSlot, setStripSlot] = useState<number | null>(null)
  // Last raw zone/slot under the cursor: dragover fires ~20×/s even when still, so only
  // re-evaluate (canMove + setState) when it actually changes.
  const lastZone = useRef<DropZone | null>(null)
  const lastSlot = useRef<number | null>(null)

  // The visible surface read at event time (the render closure can be a frame stale).
  const visibleNow = () => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId)
    return (tab && findPaneById(tab.root, pane.id)?.activeEntryId) ?? activeId
  }

  // Header actions act on THIS pane: focus it first, then split / add a surface.
  const split = (direction: "row" | "column") => {
    const store = useStore.getState()
    store.setActivePane(tabId, visibleNow())
    store.splitActive(direction)
  }
  const addSurface = () => {
    const store = useStore.getState()
    store.setActivePane(tabId, visibleNow())
    // Same fallback as ⌘T / the palette: a shell no longer listed still gets a terminal.
    store.newSurface(resolveDefaultShell(store.shells, store.settings.defaultShell))
  }

  // The terminal whose grid hidden terminal `id` takes: this pane's visible one, else one on screen
  // elsewhere in the tab, else the tab's terminal; never `id` itself (that sizes nothing).
  const sizeLike = (id: string) => {
    const tab = useStore.getState().tabs.find((t) => t.id === tabId)
    const options = [
      visibleTerminal(pane),
      ...(tab ? visibleSessionIds(tab.root) : []),
      tab?.activeSessionId,
    ]
    return options.find((o) => !!o && o !== id)
  }

  // ▤+: this pane's terminal's folder as a new tab here; a menu when its shell, its agent and
  // the checkouts the agent edits in are different folders (the sidebar's from / in / edits).
  const openFolder = (e: React.MouseEvent) => {
    const s = useStore.getState()
    const term = visibleTerminal(pane) ?? paneSessionIds(pane)[0]
    const sess = term ? s.sessions[term] : undefined
    if (!term || !sess || sess.remote) return
    const choices = folderChoices(sess.cwd, agentWorkDirs(s.agents)[term]?.cwd, s.paneWork[term])
    if (choices.length === 1) openChoice(choices[0]!)
    else if (choices.length > 1) {
      const r = e.currentTarget.getBoundingClientRect()
      setFolderMenu({ x: r.left, y: r.bottom + 4, choices })
    }
  }
  const openChoice = (c: FolderChoice) => {
    const s = useStore.getState()
    const term = visibleTerminal(pane) ?? paneSessionIds(pane)[0]
    const sess = term ? s.sessions[term] : undefined
    const wsl = sess ? wslContext(sess.command, sess.args) : undefined
    s.openFolder(c.path, { tabId, paneId: pane.id, wsl })
    requestAnimationFrame(() =>
      focusEntry(useStore.getState().tabs.find((t) => t.id === tabId)?.activeEntryId ?? ""),
    )
  }
  const hasTerminal = paneSessionIds(pane).length > 0

  useEffect(() => {
    const el = mountRef.current
    if (!el || !isTerminalEntry(activeId)) return // a folder shows: the terminals stay parked
    const s = useStore.getState().sessions[activeId]
    if (!s) return
    TerminalManager.attach(s, el)
    const ro = new ResizeObserver(() => {
      TerminalManager.fit(activeId)
      // This pane's hidden surfaces can't measure themselves — they take its grid.
      const tab = useStore.getState().tabs.find((t) => t.id === tabId)
      const self = tab && findPaneById(tab.root, pane.id)
      if (self) TerminalManager.syncHiddenSizes(self)
    })
    ro.observe(el)
    // Do NOT dispose — the terminal (and its PTY) survives being hidden behind another
    // surface or unmounted; disposal happens when the session leaves the store.
    return () => {
      ro.disconnect()
      TerminalManager.detach(activeId, el)
    }
  }, [activeId, pane.id, tabId])

  // A folder shows: the pane's parked terminals still follow its size (a terminal's mount would
  // be this box minus its 4px / 2px padding), so a TUI isn't drawn at a stale width meanwhile.
  useEffect(() => {
    const el = folderRef.current
    if (!el || isTerminalEntry(activeId)) return
    const size = () => {
      const r = el.getBoundingClientRect()
      for (const id of paneSessionIds(pane))
        TerminalManager.sizeHidden(id, r.width - 8, r.height - 4)
    }
    const ro = new ResizeObserver(size)
    ro.observe(el)
    // A font change gives the same box a different grid: refit once the new font is applied.
    const raf = requestAnimationFrame(size)
    return () => {
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the pane's terminals, by content
  }, [activeId, pane.entryIds.join(" "), fontKey])

  // Hidden surfaces still run: spawn/reattach their PTY (status, notifications, cwd)
  // without mounting them — e.g. after a restore or renderer reload.
  const idsKey = pane.entryIds.join(" ")
  useEffect(() => {
    const sessions = useStore.getState().sessions
    for (const id of paneSessionIds(pane)) {
      const s = sessions[id]
      if (s && id !== activeId) TerminalManager.ensureRunning(s, sizeLike(id))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, activeId])

  // Keep the visible surface's tab in view when the strip overflows (e.g. after ⌘T).
  useEffect(() => {
    stripRef.current
      ?.querySelector(".surface-tab.active")
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" })
  }, [activeId, idsKey])

  // Fade the strip's edges where tabs are scrolled out of view (its scrollbar is hidden).
  // Set on the DOM directly: scrolling must not re-render the pane.
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    const update = () => {
      const o = stripOverflow(strip.scrollLeft, strip.scrollWidth, strip.clientWidth)
      strip.toggleAttribute("data-fade-left", o.left)
      strip.toggleAttribute("data-fade-right", o.right)
    }
    // The strip's own box (pane resize) and each tab's (titles change width) move the overflow.
    const ro = new ResizeObserver(update)
    ro.observe(strip)
    for (const el of strip.children) ro.observe(el)
    strip.addEventListener("scroll", update, { passive: true })
    update()
    return () => {
      ro.disconnect()
      strip.removeEventListener("scroll", update)
    }
  }, [idsKey])

  // Would dropping here change anything? (e.g. a pane's only surface onto its own edge: no.)
  const wouldMove = (target: MoveTarget) => {
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === tabId)
    if (!tab || !s.dragging) return false
    // An entry from another group must still exist (a shell may exit mid-drag).
    const id = s.dragging.sessionId
    return canMove(tab.root, id, target) && (!!s.sessions[id] || !!s.objects[id])
  }
  const clearDropState = () => {
    lastZone.current = null
    lastSlot.current = null
    setDropHint(null)
    setStripSlot(null)
  }
  const drop = (target: MoveTarget) => {
    const d = useStore.getState().dragging
    clearDropState()
    if (d) useStore.getState().moveSurface(tabId, d.sessionId, target)
  }
  // Hint + marker only live during a drag (it can end anywhere, e.g. Esc or another pane).
  useEffect(() => {
    if (!dragging) clearDropState()
  }, [dragging])
  // Drag events that leave for a child of the same element aren't a real leave.
  const leftFor = (e: React.DragEvent) =>
    !(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))

  // Top rail: an unfocused pane of a split that needs input shows amber first (the signal
  // that says which agent is blocked); else a Claude session colour paints it — on any pane,
  // split or not (faded on unfocused panes so focus still reads); else it only marks focus
  // between split panes.
  const accent = accents[pane.entryIds.indexOf(activeId)]
  const railClass =
    isSplit && !focused && status === "attention"
      ? " waiting"
      : accent
        ? ` tinted${isSplit && !focused ? " dimmed" : ""}`
        : isSplit && focused
          ? " focused"
          : ""

  // Right-click clipboard menu. Copy is disabled without a selection.
  const openMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (!isTerm) return // a folder view has its own (per row)
    useStore.getState().setActivePane(tabId, activeId)
    setMenu({ x: e.clientX, y: e.clientY, hasSel: TerminalManager.hasSelection(activeId) })
  }
  const runMenu = (fn: () => void) => {
    fn()
    setMenu(null)
    TerminalManager.focus(activeId)
  }

  return (
    <div
      className={`terminal-pane${railClass}`}
      style={accent ? ({ "--pane-accent": accent } as React.CSSProperties) : undefined}
      onMouseDown={() => useStore.getState().setActivePane(tabId, visibleNow())}
      // Re-focus the terminal after any click/selection so keystrokes reach the
      // PTY (the textarea doesn't always keep focus after a selection) — unless a field that
      // asks to keep it has it (the folder path box, mid-completion).
      onMouseUp={(e) => {
        const a = document.activeElement
        if (a?.closest("[data-keep-focus]") && e.currentTarget.contains(a)) return
        focusEntry(visibleNow())
      }}
      onContextMenu={openMenu}
    >
      <div
        className="pane-header"
        // A host with a colour marks the whole header (left rail), not just its chip.
        style={activeColor ? { boxShadow: `inset 3px 0 0 ${activeColor}` } : undefined}
        // The whole header is the strip's drop area: a slot between tabs reorders / joins
        // this pane there; past the last tab (incl. the empty header space) = the end.
        onDragOver={(e) => {
          if (!dragging) return
          e.preventDefault()
          e.dataTransfer.dropEffect = "move"
          const strip = stripRef.current
          if (!strip) return
          // Auto-scroll an overflowing strip when hovering near its edges.
          const r = strip.getBoundingClientRect()
          if (e.clientX < r.left + 24) strip.scrollLeft -= 12
          else if (e.clientX > r.right - 24 && e.clientX < r.right) strip.scrollLeft += 12
          const tabs = [...strip.querySelectorAll(".surface-tab")]
          const slot = insertIndex(
            tabs.map((t) => t.getBoundingClientRect()),
            e.clientX,
          )
          if (slot === lastSlot.current) return
          lastSlot.current = slot
          setStripSlot(wouldMove({ paneId: pane.id, index: slot }) ? slot : null)
        }}
        onDragLeave={(e) => {
          if (!leftFor(e)) return
          lastSlot.current = null
          setStripSlot(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          if (stripSlot !== null) drop({ paneId: pane.id, index: stripSlot })
          else clearDropState()
        }}
      >
        <div
          className={`surface-tabs${dragging ? " dragging" : ""}`}
          role="tablist"
          ref={stripRef}
          // A plain mouse wheel scrolls vertically; map it onto the horizontal strip.
          onWheel={(e) => {
            if (e.deltaY && !e.deltaX) e.currentTarget.scrollLeft += e.deltaY
          }}
        >
          {pane.entryIds.map((id, i) => {
            const s = surfaces[i]
            const active = id === activeId
            const ui = s?.remote
              ? remoteStatusUi(
                  (remoteFlat[i * 2] || undefined) as Parameters<typeof remoteStatusUi>[0],
                  s.status,
                  remoteFlat[i * 2 + 1] || undefined,
                )
              : statusUi(s?.status ?? "idle")
            const label = objAt(i).path ? baseName(objAt(i).path) : displaySessionTitle(s, home)
            return (
              <div
                key={id}
                role="tab"
                aria-selected={active}
                className={
                  `surface-tab${active ? " active" : ""}${multi ? " multi" : ""}` +
                  (objAt(i).peek ? " peek" : "") +
                  (dragging?.sessionId === id ? " dragging" : "") +
                  (stripSlot === i ? " insert-before" : "") +
                  (stripSlot === pane.entryIds.length && i === pane.entryIds.length - 1
                    ? " insert-after"
                    : "")
                }
                title={
                  objAt(i).path
                    ? objAt(i).peek
                      ? `${objAt(i).path} · preview (double-click to keep)`
                      : objAt(i).path
                    : displaySessionTitle(s, home)
                }
                // The title's length caps the tab's shrink floor (CSS): a short title isn't padded.
                style={{ "--title-ch": [...label].length } as React.CSSProperties}
                onDoubleClick={() => objAt(i).peek && useStore.getState().keepEntry(id)}
                // Drag a surface to another pane's edge (split), centre (join) or strip slot.
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "move"
                  e.dataTransfer.setData(SURFACE_DRAG_TYPE, id)
                  useStore.getState().setDragging({ tabId, sessionId: id })
                }}
                onDragEnd={() => useStore.getState().setDragging(null)}
                // Left-click selects; the pane's onMouseUp then focuses the new terminal.
                onMouseDown={(e) => {
                  if (e.button === 0) useStore.getState().setActivePane(tabId, id)
                }}
                // No clipboard menu on a tab — it would target the visible surface, not this one.
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                }}
                // Middle-click closes a surface (browser convention).
                onAuxClick={(e) => {
                  if (e.button === 1 && multi) useStore.getState().requestCloseEntry(tabId, id)
                }}
              >
                {objAt(i).kind === "folder" ? (
                  <Folder
                    size={13}
                    weight="fill"
                    color={active && focused ? "var(--accent)" : "var(--blue)"}
                  />
                ) : objAt(i).kind === "file" ? (
                  <FileText size={13} color={active && focused ? "var(--accent)" : "var(--dim)"} />
                ) : (
                  (() => {
                    const kind = agentFlags[i] as AgentKind | ""
                    const Icon = kind ? agentIcon(kind) : s?.remote ? Globe : Terminal
                    return (
                      <Icon
                        size={13}
                        weight="fill"
                        // The session's colour when it has one (the tab "dot"), else focus/dim.
                        // A host's colour (a safety cue) beats an agent's /color accent.
                        color={
                          colorOf(s) ??
                          accents[i] ??
                          (active && focused ? "var(--accent)" : "var(--dim)")
                        }
                      />
                    )
                  })()
                )}
                <span className="pane-title">{label}</span>
                {objAt(i).kind === "file" && <UnsavedMark id={id} />}
                {/* Hidden surfaces surface their state on the tab (you can't see the pane). */}
                {/* Static dot (no pulse): don't animate compositing next to a WebGL canvas. */}
                {!active && s && (ui.dot !== "faint" || s.status !== "idle") && (
                  <span className={`dot ${ui.dot}`} />
                )}
                {multi && (
                  <button
                    className="surface-close"
                    title="Close terminal"
                    onMouseDown={(e) => {
                      e.stopPropagation()
                      e.preventDefault() // keep focus off this button: the dialog focuses its own
                      if (e.button === 0) useStore.getState().requestCloseEntry(tabId, id)
                    }}
                  >
                    <X size={10} />
                  </button>
                )}
              </div>
            )
          })}
        </div>
        {!isTerm ? null : session?.remote ? (
          // Where this pane runs: user@hostname (else the alias), in the host's colour if set.
          <span
            className={`host-chip${activeColor ? " colored" : ""}`}
            style={activeColor ? ({ "--host": activeColor } as React.CSSProperties) : undefined}
            title={`ssh ${session.remote.target}`}
          >
            {remoteWhere(session.remote, sshHosts)}
          </span>
        ) : session?.peer ? (
          // Another minmux's pane: the machine it's on.
          <span className="host-chip peer" title={`On ${session.peer.key}, over your tailnet`}>
            <Desktop size={11} aria-hidden />
            {session.peer.machine}
          </span>
        ) : (
          <span className="pane-badge">{shellType(session?.command ?? "")}</span>
        )}
        {isTerm && drivenBy && (
          <span
            className="pane-badge driven-chip"
            title="Another machine sizes this pane while you work there. Typing here takes it back."
          >
            driven from {drivenBy}
          </span>
        )}
        <div className="pane-header-spacer" />
        {remoteIdle === "failed" &&
          failure === "host-gone" &&
          session?.remote?.env === "native" && (
            <button
              className="pane-connect"
              title="Open ~/.ssh/config"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => ipc.openSshConfig()}
            >
              Open ssh config
            </button>
          )}
        {remoteIdle && !(remoteIdle === "failed" && failure && !canRetry(failure)) && (
          <button
            className="pane-connect"
            title={remoteIdle === "waiting" ? "Connect (Enter)" : "Reconnect (Enter)"}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => {
              TerminalManager.connect(activeId)
              TerminalManager.focus(activeId)
            }}
          >
            <Plugs size={12} />
            {remoteIdle === "waiting"
              ? "Connect"
              : remoteIdle === "failed"
                ? "Retry"
                : remoteDetail === "ended"
                  ? "Start again"
                  : "Reconnect"}
          </button>
        )}
        {hasTerminal && !surfaces.some((s) => s?.remote) && (
          <button
            className="iconbtn"
            style={{ width: 22, height: 22 }}
            title="Open folder in a new tab"
            aria-label="Open folder in a new tab"
            onMouseDown={(e) => {
              e.stopPropagation()
              e.preventDefault() // keep focus where it is: the new tab takes it
              if (e.button === 0) openFolder(e)
            }}
          >
            <FolderPlus size={13} />
          </button>
        )}
        <button
          className="iconbtn"
          style={{ width: 22, height: 22 }}
          title={`New terminal (${newSurfaceKey})`}
          aria-label={`New terminal (${newSurfaceKey})`}
          onMouseDown={(e) => {
            e.stopPropagation()
            if (e.button === 0) addSurface()
          }}
        >
          {/* cmux-style: a boxed ">_" terminal glyph. */}
          <TerminalWindow size={13} />
        </button>
        <button
          className="iconbtn"
          style={{ width: 22, height: 22 }}
          title="Split right"
          onMouseDown={(e) => {
            e.stopPropagation()
            split("row")
          }}
        >
          <Columns size={13} />
        </button>
        <button
          className="iconbtn"
          style={{ width: 22, height: 22 }}
          title="Split down"
          onMouseDown={(e) => {
            e.stopPropagation()
            split("column")
          }}
        >
          <Rows size={13} />
        </button>
        <button
          className="iconbtn"
          style={{ width: 22, height: 22 }}
          title="Close pane"
          onMouseDown={(e) => {
            e.stopPropagation()
            // preventDefault: the mousedown's default focus-the-button would otherwise run
            // AFTER the dialog focuses its confirm button, breaking Enter + the Tab trap.
            e.preventDefault()
            if (e.button === 0) useStore.getState().requestClosePane(tabId, pane.id)
          }}
        >
          <X size={13} />
        </button>
      </div>
      {isTerm ? (
        <>
          <ResumeBanner sessionId={activeId} />
          <IntegrationHint sessionId={activeId} />
          <AgentHint key={activeId} sessionId={activeId} />
          <div className="terminal-mount" ref={mountRef} />
        </>
      ) : (
        <div className="folder-mount" ref={folderRef}>
          {activeKind === "file" ? (
            <FileView key={activeId} entryId={activeId} tabId={tabId} />
          ) : (
            <FolderView key={activeId} entryId={activeId} tabId={tabId} />
          )}
        </div>
      )}
      {folderMenu && (
        <ContextMenu
          x={folderMenu.x}
          y={folderMenu.y}
          items={folderMenu.choices.map((c, i) => ({
            id: String(i),
            label: `${c.label} · ${shortCwd(c.path, home)}`,
          }))}
          onSelect={(i) => {
            const c = folderMenu.choices[Number(i)]
            setFolderMenu(null)
            if (c) openChoice(c)
          }}
          onClose={() => setFolderMenu(null)}
        />
      )}
      {/* While dragging: a transparent layer over the terminal (xterm's canvas would swallow
          the drag events) that shows where the surface would land. No animation — it sits
          over a WebGL canvas. */}
      {dragging && (
        <div
          className="drop-overlay"
          onDragOver={(e) => {
            e.preventDefault()
            e.dataTransfer.dropEffect = "move"
            const zone = dropZone(e.currentTarget.getBoundingClientRect(), e.clientX, e.clientY)
            if (zone === lastZone.current) return
            lastZone.current = zone
            setDropHint(wouldMove({ paneId: pane.id, zone }) ? zone : null)
          }}
          onDragLeave={(e) => {
            if (!leftFor(e)) return
            lastZone.current = null
            setDropHint(null)
          }}
          onDrop={(e) => {
            e.preventDefault()
            if (dropHint) drop({ paneId: pane.id, zone: dropHint })
            else clearDropState()
          }}
        >
          {dropHint && <div className={`drop-hint ${dropHint}`} />}
        </div>
      )}
      {menu && (
        <>
          <div
            className="ctx-backdrop"
            onMouseDown={() => setMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu(null)
            }}
          />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            <button
              className="ctx-item"
              disabled={!menu.hasSel}
              onMouseDown={(e) => {
                e.preventDefault()
                runMenu(() => TerminalManager.copySelection(activeId))
              }}
            >
              Copy
            </button>
            <button
              className="ctx-item"
              onMouseDown={(e) => {
                e.preventDefault()
                runMenu(() => TerminalManager.paste(activeId))
              }}
            >
              Paste
            </button>
            <button
              className="ctx-item"
              onMouseDown={(e) => {
                e.preventDefault()
                runMenu(() => TerminalManager.selectAll(activeId))
              }}
            >
              Select all
            </button>
          </div>
        </>
      )}
    </div>
  )
}
