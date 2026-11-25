import { useCallback, useMemo, useState } from "react"
import { useTabDrag } from "./use-tab-drag"
import { SURFACE_DRAG_TYPE } from "../lib/group-move"
import { useTabRename } from "./use-tab-rename"
import { focusActiveEntry, focusEntry, refocusActiveTerminal } from "./refocus-terminal"
import { folderChoices, placeOf, type FolderChoice } from "../lib/folder-entries"
import { isTerminalEntry } from "../lib/entries"
import { baseName } from "../lib/file-tree"
import { useShallow } from "zustand/react/shallow"
import {
  CaretDown,
  CaretRight,
  Columns,
  FileText,
  Folder,
  GitMerge,
  Globe,
  MagnifyingGlass,
  PushPin,
  GitPullRequest,
  Plus,
  Rows,
  Terminal,
  X,
} from "@phosphor-icons/react"
import { activeTheme, canOpenTerminalIn, useStore } from "../store"
import { sessionColor } from "../lib/session-color"
import { agentPanes, paneAgents, type AgentKind } from "../lib/agent-graph"
import { agentWorkDirs, agentWorkFlat, gitKey, inLabel, inLine, samePath } from "../lib/agent-dirs"
import { moreFolders, paneWorkFlat } from "../lib/agent-work"
import { agentInfo } from "../lib/agent-kinds"
import { agentIcon } from "./agent-icon"
import { ContextMenu } from "./context-menu"
import { integrationOn } from "../lib/ssh-integration"
import {
  folderMenuItems,
  isAbsoluteHostPath,
  revealLabel,
  type FileActionId,
} from "../lib/file-actions"
import { wslContext } from "../lib/wsl"
import { messageSnippet, prStateUi, type PaneGitInfo, type PrInfo } from "../lib/pane-git"
import { ipc } from "../lib/ipc"
import { openLink } from "../lib/open-link"
import { allPanes, findPane } from "../lib/pane-tree"
import { resolveDefaultShell } from "../lib/shells"
import { statusUi } from "../lib/status-ui"
import { detailUser, homeRelative, shortRemoteCwd } from "../lib/remote-cwd"
import { isWaitingRemote, remoteStatusUi, remoteSummary, summaryText } from "../lib/remote-connect"
import {
  connectedHostIds,
  envTitle,
  groupHosts,
  hostColor,
  hostColorCss,
  remoteWhere,
} from "../lib/ssh-hosts-ui"
import type { SshHost, Tab } from "../types"
import { hostMenuItems, sidebarHosts, visibleHosts, type HostActionId } from "../lib/ssh-host-list"
import { runHostAction } from "../lib/ssh-host-actions"
import { sessionMenuItems, type SessionActionId } from "../lib/session-menu"
import {
  remoteRowTitle,
  tabTitle,
  tabTitleParts,
  sessionSubline,
  branchLine,
  displaySessionTitle,
  shellType,
  shortCwd,
} from "../lib/session-label"

/** Left sidebar: a tree of real sessions (tabs) → panes, with live status dots. */
export function Sidebar() {
  const tabDrag = useTabDrag("y") // reorder sessions: same order as the top bar
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => (s.activeView ? null : s.activeTabId)) // none behind a view
  const sessions = useStore((s) => s.sessions)
  const objects = useStore((s) => s.objects)
  const shells = useStore((s) => s.shells)
  const defaultShellPref = useStore((s) => s.settings.defaultShell)
  const paneGit = useStore((s) => s.paneGit) // branch + PR per terminal (polled in App)
  // ssh panes: connecting / at a prompt / disconnected … (stable refs; change on a transition)
  const remotePhase = useStore((s) => s.remotePhase)
  const remoteDetail = useStore((s) => s.remoteDetail)
  const sshRestore = useStore((s) => s.settings.ssh.restore)
  const sshHosts = useStore((s) => s.sshHosts)
  const hostColors = useStore((s) => s.settings.ssh.colors)
  const hostCss = (target: string) => {
    const c = hostColor(target, hostColors)
    return c ? hostColorCss(c) : undefined
  }
  // The agent's last reply per pane (newest session root that ran in it), as a flat
  // [paneId, message, …] list of primitives: the shallow compare keeps the sidebar from
  // re-rendering on every agent hook event — only when a reply actually changes.
  const replies = useStore(
    useShallow((s) => {
      const latest: Record<string, string> = {}
      for (const rid of s.agents.rootIds) {
        const n = s.agents.nodes[rid]
        if (n?.paneId && n.lastMessage && !n.nested) latest[n.paneId] = n.lastMessage // lead only
      }
      return Object.entries(latest).flat()
    }),
  )
  const home = useStore((s) => s.home)
  const platform = useStore((s) => s.platform)
  // Agent session colours per terminal (same as the pane border + tab icon).
  const agentMeta = useStore((s) => s.agentMeta)
  const scheme = useStore((s) => activeTheme(s).scheme)
  const accentOf = (id: string) => sessionColor(agentMeta[id], scheme)
  // Terminals running an agent, and which (flat primitives: re-render only when they change).
  const panesFlat = useStore(useShallow((s) => agentPanes(s.agents)))
  const agentIn = paneAgents(panesFlat)
  // Where each pane's agent works, as memoized primitives: the shallow compare re-renders
  // only when a folder changes, not on every hook event.
  const workFlat = useStore(useShallow((s) => agentWorkFlat(s.agents)))
  const work: Record<string, { agent: AgentKind; cwd: string; others: string }> = {}
  for (let i = 0; i + 3 < workFlat.length; i += 4)
    work[workFlat[i]!] = {
      agent: workFlat[i + 1] as AgentKind,
      cwd: workFlat[i + 2]!,
      others: workFlat[i + 3]!,
    }

  // The checkout each pane's agent edits in (`edits`), flat the same way.
  const editFlat = useStore(useShallow((s) => paneWorkFlat(s.paneWork)))
  const edits: Record<string, EditDir> = {}
  for (let i = 0; i + 3 < editFlat.length; i += 4)
    edits[editFlat[i]!] = {
      agent: editFlat[i + 1] as AgentKind,
      shown: editFlat[i + 2]!,
      more: editFlat[i + 3] ? editFlat[i + 3]!.split("\n") : [],
    }

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const defaultShell = resolveDefaultShell(shells, defaultShellPref)
  const newSession = () => {
    if (defaultShell) useStore.getState().newTab(defaultShell)
  }

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const focusPane = (tabId: string, entryId: string) => {
    const store = useStore.getState()
    store.setActiveTab(tabId)
    store.setActivePane(tabId, entryId)
    requestAnimationFrame(() => focusEntry(entryId))
  }

  // Right-click a terminal row: "Open folder in…" its from / in / edits folders, as a tab of
  // its pane (the same choices as its pane's open-folder button).
  const [openMenu, setOpenMenu] = useState<{
    x: number
    y: number
    tabId: string
    sessionId: string
    choices: FolderChoice[]
  } | null>(null)
  const openFolderMenu = (e: React.MouseEvent, tabId: string, sessionId: string) => {
    const s = useStore.getState()
    const sess = s.sessions[sessionId]
    if (!sess || sess.remote) return
    const choices = folderChoices(
      sess.cwd,
      agentWorkDirs(s.agents)[sessionId]?.cwd,
      s.paneWork[sessionId],
    )
    if (!choices.length) return
    e.preventDefault()
    setOpenMenu({ x: e.clientX, y: e.clientY, tabId, sessionId, choices })
  }
  /** A folder as a new tab of the pane holding entry `entryId` (in `tabId`), focused. */
  const openFolderBeside = (tabId: string, entryId: string, path: string) => {
    const s = useStore.getState()
    const tab = s.tabs.find((t) => t.id === tabId)
    const pane = tab && findPane(tab.root, entryId)
    if (!pane) return
    const sess = s.sessions[entryId]
    const wsl = sess ? wslContext(sess.command, sess.args) : s.objects[entryId]?.wsl
    s.setActiveTab(tabId)
    s.openFolder(path, { tabId, paneId: pane.id, wsl })
    requestAnimationFrame(focusActiveEntry)
  }

  // Right-click on a folder line: copy it, open a terminal there, or reveal it.
  const [dirMenu, setDirMenu] = useState<{
    x: number
    y: number
    path: string
    sessionId: string // the row's entry: a terminal, or a folder entry
    tabId: string
    revealHint?: string // why Reveal is unavailable (undefined = available)
  } | null>(null)
  const openDirMenu = (e: React.MouseEvent, path: string, sessionId: string, tabId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const st = useStore.getState()
    const s = st.sessions[sessionId]
    const wsl = s ? wslContext(s.command, s.args) : st.objects[sessionId]?.wsl
    // Reveal needs a path the host OS can open: not a WSL one, nor a POSIX-style path on
    // Windows (Git Bash's /c/…).
    const revealHint = wsl
      ? "WSL path"
      : !isAbsoluteHostPath(path, platform)
        ? "not a host path"
        : undefined
    setDirMenu({ x: e.clientX, y: e.clientY, path, sessionId, tabId, revealHint })
  }
  // Closing the menu (Escape, outside click, any action) returns focus to the active terminal
  // — the one you were typing in, or the split "Open terminal here" just made.
  const closeDirMenu = useCallback(() => {
    setDirMenu(null)
    refocusActiveTerminal() // …unless something else (a text field) has focus by then
  }, [])
  const onDirAction = (id: FileActionId) => {
    if (!dirMenu) return
    if (id === "copyPath") ipc.clipboardWrite(dirMenu.path)
    else if (id === "reveal") ipc.revealPath(dirMenu.path)
    else if (id === "openTab") openFolderBeside(dirMenu.tabId, dirMenu.sessionId, dirMenu.path)
    else if (id === "openHere" && !isTerminalEntry(dirMenu.sessionId)) {
      // A folder row: a terminal in it, as a tab of the folder's pane.
      const s = useStore.getState()
      s.setActiveTab(dirMenu.tabId)
      s.setActivePane(dirMenu.tabId, dirMenu.sessionId)
      s.newSurface()
    } else if (id === "openHere") {
      // Split beside that terminal, with its shell (a WSL path opens in WSL); the new split
      // takes focus. A pane closed meanwhile → no-op.
      useStore.getState().splitPaneAt(dirMenu.sessionId, dirMenu.path)
    }
  }

  // Rename a session in place (double-click its name), or from its right-click menu.
  const rename = useTabRename()
  const [sessionMenu, setSessionMenu] = useState<{ x: number; y: number; tabId: string } | null>(
    null,
  )
  const closeSessionMenu = useCallback(() => {
    setSessionMenu(null)
    refocusActiveTerminal() // skipped if Rename's field or the close dialog took focus
  }, [])
  // The menu's session; closed while the menu was open → no menu (and no action).
  const menuTab = sessionMenu ? tabs.find((t) => t.id === sessionMenu.tabId) : undefined
  // The name only: the live "+N" must not be pinned into a manual title.
  const startRename = (tab: Tab) => rename.start(tab.id, tabTitleParts(tab, sessions, home).base)
  const onSessionAction = (id: SessionActionId) => {
    const tab = menuTab
    if (!tab) return
    if (id === "rename") startRename(tab)
    else if (id === "resetName") useStore.getState().renameTab(tab.id, "")
    else if (id === "close") useStore.getState().requestCloseTab(tab.id)
  }

  const branchFor = (sessionId: string) => paneGit[sessionId]?.branch

  const lastMessage: Record<string, string> = {}
  for (let k = 0; k + 1 < replies.length; k += 2) lastMessage[replies[k]!] = replies[k + 1]!

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span className="section-label">Sessions</span>
        <button
          className="iconbtn"
          title="New session"
          disabled={!defaultShell}
          onClick={newSession}
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="tree sidebar-sessions" {...tabDrag.listProps}>
        {tabDrag.target && (
          <span className="tab-drop-line y" style={{ top: tabDrag.target.offset - 1 }} />
        )}
        {tabs.map((tab) => {
          const panes = allPanes(tab.root) // one walk → ids, pane count, visible set
          const ids = panes.flatMap((p) => p.entryIds) // terminals and folder tabs, in pane order
          const paneCount = panes.length
          const visible = new Set(panes.map((p) => p.activeEntryId))
          const open = !collapsed.has(tab.id)
          const active = tab.id === activeTabId
          const focused = sessions[tab.activeSessionId]
          const groupSub = sessionSubline(focused?.cwd, home, branchFor(tab.activeSessionId))
          const editing = rename.editingId === tab.id
          return (
            <div
              key={tab.id}
              {...tabDrag.spanProps(tab.id)}
              className={`tree-group${tabDrag.dragging === tab.id ? " dragging" : ""}${
                tabDrag.joinId === tab.id ? " drop-join" : ""
              }`}
            >
              <div
                {...tabDrag.handleProps(tab.id, !editing)}
                className={`tree-row${active ? " active" : ""}`}
                style={{ paddingLeft: 12 }}
                // A left click selects; a right-click only opens this row's menu.
                onMouseDown={(e) => {
                  if (e.button === 0) useStore.getState().setActiveTab(tab.id)
                }}
                onContextMenu={(e) => {
                  e.preventDefault()
                  setSessionMenu({ x: e.clientX, y: e.clientY, tabId: tab.id })
                }}
              >
                <button
                  className="tree-caret tree-icon"
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    toggle(tab.id)
                  }}
                  // Collapsing must never also start a reorder drag of this session.
                  onDragStart={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                  }}
                >
                  {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
                </button>
                <div className="tree-labels">
                  <span className="tree-primary-row">
                    {editing ? (
                      <input
                        className="tab-rename tree-rename"
                        aria-label="Session name"
                        {...rename.inputProps}
                      />
                    ) : (
                      <span className="tree-primary session" onDoubleClick={() => startRename(tab)}>
                        {tabTitle(tab, sessions, home)}
                      </span>
                    )}
                    {focused && <span className="pane-badge">{shellType(focused.command)}</span>}
                  </span>
                  {groupSub && (
                    <span className="tree-sub" title={focused?.cwd}>
                      {groupSub}
                    </span>
                  )}
                </div>
                <span className="tree-meta status-faint tree-swap-meta">
                  {paneCount} {paneCount === 1 ? "pane" : "panes"}
                </span>
                <RowClose
                  title="Close session"
                  onClose={() => useStore.getState().requestCloseTab(tab.id)}
                />
              </div>

              {open &&
                ids.map((id) => {
                  const folder = objects[id]
                  if (folder) {
                    const isActive = active && tab.activeEntryId === id
                    return (
                      <div
                        key={id}
                        className={`tree-row${isActive ? " active" : ""}${visible.has(id) ? "" : " surface-hidden"}`}
                        style={{ paddingLeft: 32 }}
                        title={folder.path}
                        draggable
                        onDragStart={(e) => {
                          e.stopPropagation()
                          e.dataTransfer.effectAllowed = "move"
                          e.dataTransfer.setData(SURFACE_DRAG_TYPE, id)
                          useStore.getState().setDragging({ tabId: tab.id, sessionId: id })
                        }}
                        onDragEnd={() => useStore.getState().setDragging(null)}
                        onClick={(e) =>
                          e.button === 0 &&
                          !(e.ctrlKey && platform === "darwin") &&
                          focusPane(tab.id, id)
                        }
                        onContextMenu={(e) => openDirMenu(e, folder.path, id, tab.id)}
                      >
                        <span className="tree-icon">
                          {folder.kind === "file" ? (
                            <FileText size={14} color={isActive ? "var(--accent)" : "var(--dim)"} />
                          ) : (
                            <Folder
                              size={14}
                              weight="fill"
                              color={isActive ? "var(--accent)" : "var(--blue)"}
                            />
                          )}
                        </span>
                        <div className="tree-labels">
                          <span className="tree-primary-row">
                            <span
                              className="tree-primary"
                              style={
                                folder.kind === "file" && folder.peek
                                  ? { fontStyle: "italic" }
                                  : undefined
                              }
                            >
                              {baseName(folder.path)}
                            </span>
                          </span>
                          <span className="tree-sub">{shortCwd(placeOf(folder).path, home)}</span>
                        </div>
                        <RowClose
                          title={folder.kind === "file" ? "Close file" : "Close folder"}
                          onClose={() => useStore.getState().requestCloseEntry(tab.id, id)}
                        />
                      </div>
                    )
                  }
                  const s = sessions[id]
                  if (!s) return null
                  const ui = s.remote
                    ? remoteStatusUi(
                        // A restored on-focus pane in a tab not shown yet hasn't started: it's
                        // waiting too (Connect all counts it), not idle.
                        isWaitingRemote(s, remotePhase[id], sshRestore)
                          ? "waiting"
                          : remotePhase[id],
                        s.status,
                        remoteDetail[id],
                      )
                    : statusUi(s.status)
                  const isActive = active && tab.activeEntryId === id
                  // The host's colour, looked up once for the icon and the host box.
                  const rowColor = s.remote ? hostCss(s.remote.target) : undefined
                  const rowUser = s.remote
                    ? detailUser(sshHosts.find((h) => h.hostId === s.remote!.hostId)?.detail)
                    : undefined
                  return (
                    <div
                      key={id}
                      // A surface hidden behind another in its pane reads dimmer.
                      className={`tree-row${isActive ? " active" : ""}${visible.has(id) ? "" : " surface-hidden"}`}
                      style={{ paddingLeft: 32 }}
                      // Drag it onto another group, into a gap (a new group), or onto a pane.
                      draggable
                      onDragStart={(e) => {
                        e.stopPropagation() // not a reorder of its group
                        e.dataTransfer.effectAllowed = "move"
                        e.dataTransfer.setData(SURFACE_DRAG_TYPE, id)
                        useStore.getState().setDragging({ tabId: tab.id, sessionId: id })
                      }}
                      onDragEnd={() => useStore.getState().setDragging(null)}
                      // Left button only: a right-click (folder menu) mustn't switch tabs or
                      // focus the terminal (Escape closing the menu would reach a running Claude).
                      // (macOS Ctrl-click is a right-click that reports button 0.)
                      // On click, not press: pressing to drag it elsewhere mustn't switch groups.
                      onClick={(e) =>
                        e.button === 0 &&
                        !(e.ctrlKey && platform === "darwin") &&
                        focusPane(tab.id, id)
                      }
                      onContextMenu={(e) => openFolderMenu(e, tab.id, id)}
                    >
                      <span className="tree-icon">
                        {(() => {
                          const kind = agentIn[id]
                          const Icon = kind ? agentIcon(kind) : s.remote ? Globe : Terminal
                          return (
                            <Icon
                              size={14}
                              weight="fill"
                              // A host's colour (a safety cue) beats an agent's /color accent.
                              color={
                                rowColor ??
                                accentOf(id) ??
                                (isActive ? "var(--accent)" : "var(--dim)")
                              }
                            />
                          )
                        })()}
                      </span>
                      <div className="tree-labels">
                        <span className="tree-primary-row">
                          {s.remote && s.remoteCwd ? (
                            // Like a local row: the folder's name, then (boxed) where it is.
                            <>
                              <span className="tree-primary">
                                {remoteRowTitle(s, home, rowUser)}
                              </span>
                              <span
                                className={`host-box${rowColor ? " colored" : ""}`}
                                style={
                                  rowColor
                                    ? ({ "--host": rowColor } as React.CSSProperties)
                                    : undefined
                                }
                                title={remoteWhere(s.remote, sshHosts)}
                              >
                                {s.remote.label}
                              </span>
                            </>
                          ) : (
                            <>
                              <span className="tree-primary">{displaySessionTitle(s, home)}</span>
                              <span className="pane-badge">{shellType(s.command)}</span>
                            </>
                          )}
                        </span>
                        {s.status === "attention" && s.detail ? (
                          <span className="tree-sub attn">{s.detail}</span>
                        ) : (
                          lastMessage[id] && (
                            <span className="tree-snippet" title={lastMessage[id]}>
                              {messageSnippet(lastMessage[id])}
                            </span>
                          )
                        )}
                        {s.remote ? (
                          // Its folders are on the host: no local folder line or menu.
                          <span
                            className="tree-sub"
                            title={s.remoteCwd ?? `ssh ${s.remote.target}`}
                          >
                            {s.remoteCwd
                              ? // Front-shortened to fit: the folder at the end is what matters.
                                shortRemoteCwd(homeRelative(s.remoteCwd, rowUser), 28) +
                                (s.remote.env === "native" ? "" : ` · ${envTitle(s.remote.env)}`)
                              : remoteWhere(s.remote, sshHosts)}
                          </span>
                        ) : (
                          <DirLines
                            shellCwd={s.cwd}
                            home={home}
                            shellGit={paneGit[id]}
                            inGit={paneGit[gitKey(id, "in")]}
                            work={work[id]}
                            edit={edits[id]}
                            editGit={paneGit[gitKey(id, "edit")]}
                            onMenu={(e, path) => openDirMenu(e, path, id, tab.id)}
                            pane={id}
                          />
                        )}
                      </div>
                      {(s.status !== "attention" || ui.word !== "needs input") && (
                        <span
                          className="tree-meta tree-swap-meta"
                          style={{ color: `var(--${ui.dot === "hollow" ? "faint" : ui.dot})` }}
                        >
                          {ui.word}
                        </span>
                      )}
                      <RowClose
                        title="Close terminal"
                        onClose={() => useStore.getState().requestCloseTerminal(tab.id, id)}
                      />
                      <span className={`dot ${ui.dot}${ui.pulse ? " pulse" : ""}`} />
                    </div>
                  )
                })}
            </div>
          )
        })}
      </div>

      <RemoteHosts />

      {dirMenu && (
        <ContextMenu
          x={dirMenu.x}
          y={dirMenu.y}
          items={folderMenuItems(revealLabel(platform), dirMenu.revealHint, {
            openTab: isTerminalEntry(dirMenu.sessionId),
            // A folder tab lists host paths, or WSL ones in their distro: not Git Bash's /c/….
            openTabHint: dirMenu.revealHint === "not a host path" ? dirMenu.revealHint : undefined,
            openHereHint:
              !isTerminalEntry(dirMenu.sessionId) &&
              !canOpenTerminalIn(useStore.getState(), dirMenu.sessionId)
                ? "no shell for it"
                : undefined,
          })}
          onSelect={onDirAction}
          onClose={closeDirMenu}
        />
      )}
      {openMenu && (
        <ContextMenu
          x={openMenu.x}
          y={openMenu.y}
          items={openMenu.choices.map((c, i) => ({
            id: String(i),
            label: `Open folder in a tab · ${c.label} ${shortCwd(c.path, home)}`,
          }))}
          onSelect={(i) => {
            const c = openMenu.choices[Number(i)]
            setOpenMenu(null)
            if (c) openFolderBeside(openMenu.tabId, openMenu.sessionId, c.path)
          }}
          onClose={() => {
            setOpenMenu(null)
            refocusActiveTerminal()
          }}
        />
      )}
      {sessionMenu && menuTab && (
        <ContextMenu
          x={sessionMenu.x}
          y={sessionMenu.y}
          items={sessionMenuItems(menuTab)}
          onSelect={onSessionAction}
          onClose={closeSessionMenu}
        />
      )}
      <div className="legend">
        <span className="legend-item">
          <span className="dot accent" /> running
        </span>
        <span className="legend-item">
          <span className="dot amber" /> needs input
        </span>
        <span className="legend-item">
          <span className="dot faint" /> idle
        </span>
      </div>
    </div>
  )
}

/** A pane's agent's other checkout: the one shown, and the rest it worked in. */
interface EditDir {
  agent: AgentKind
  shown: string // "" when none
  more: string[]
}

/** The folder line(s): one when Claude works where it started (or isn't running); else
 *  `from` (the shell's folder — where the session is saved) + `in` (where Claude works now).
 *  Then `edits`: another checkout the agent changes files in, with its own branch / PR. */
function DirLines({
  shellCwd,
  home,
  shellGit,
  inGit,
  work,
  edit,
  editGit,
  onMenu,
  pane,
}: {
  pane: string // its PR links look the PR up with this pane's gh
  shellCwd: string | undefined
  home: string
  shellGit: PaneGitInfo | undefined
  inGit: PaneGitInfo | undefined
  work: { agent: AgentKind; cwd: string; others: string } | undefined
  edit: EditDir | undefined
  editGit: PaneGitInfo | undefined
  onMenu: (e: React.MouseEvent, path: string) => void
}) {
  const menuFor = (path: string | undefined) =>
    path ? (e: React.MouseEvent) => onMenu(e, path) : undefined
  // Shown once its own lookup answered for it, with something to say (a branch or a PR); a
  // checkout with neither (detached HEAD) still counts in the `+N`.
  const shown = edit?.shown
  const answered = !!shown && !!editGit?.forCwd && samePath(editGit.forCwd, shown)
  const editKnown = answered && (editGit!.branch || editGit!.pr) ? editGit : undefined
  const others = moreFolders(
    work?.others ? work.others.split("\n") : [],
    answered && !editKnown ? [shown!, ...edit!.more] : (edit?.more ?? []),
    editKnown ? shown : undefined,
  )
  const more = others.length > 0 && (
    <span
      className="tree-more"
      title={`Other checkouts this session worked in:\n${others.join("\n")}`}
    >
      +{others.length}
    </span>
  )
  const editsLine = shown && editKnown && (
    <>
      <span
        className="tree-sub tree-dir"
        title={withGhHint(
          `${agentInfo(edit.agent).label} changed files or ran \`cd … &&\` commands here:\n${shown}`,
          editKnown,
        )}
        onContextMenu={menuFor(shown)}
      >
        <span className="tree-dir-label">edits</span>
        <span className="tree-dir-path">{sessionSubline(shown, home, editKnown.branch)}</span>
        {more}
      </span>
      {editKnown.pr && <PrLine pr={editKnown.pr} pane={pane} />}
    </>
  )
  // Another checkout (its own branch / PR), or another folder of the same one (a sub-project:
  // no git line of its own — it's from's).
  const line = work ? inLine(shellCwd, work.cwd, shellGit, inGit, work.agent) : null
  if (!shellCwd || !work || !line) {
    return (
      <>
        <span
          className="tree-sub tree-dir"
          title={withGhHint(shellCwd ?? "", shellGit)}
          onContextMenu={menuFor(shellCwd)}
        >
          {editsLine && <span className="tree-dir-label">from</span>}
          <span className="tree-dir-path">
            {sessionSubline(shellCwd, home, shellGit?.branch) || "shell"}
          </span>
          {!editsLine && more}
        </span>
        {shellGit?.pr && <PrLine pr={shellGit.pr} pane={pane} />}
        {editsLine}
      </>
    )
  }
  // Each line keeps its own PR: the session belongs to `from`'s branch, the work to `in`'s.
  return (
    <>
      <span
        className="tree-sub tree-dir"
        title={withGhHint(
          `Claude started here (the session is saved under it):\n${shellCwd}`,
          shellGit,
        )}
        onContextMenu={menuFor(shellCwd)}
      >
        <span className="tree-dir-label">from</span>
        <span className="tree-dir-path">{sessionSubline(shellCwd, home, shellGit?.branch)}</span>
      </span>
      {shellGit?.pr && <PrLine pr={shellGit.pr} pane={pane} />}
      <span
        className="tree-sub tree-dir"
        title={withGhHint(
          `Claude is working here now:\n${work.cwd}`,
          line.elsewhere ? line.known : undefined,
        )}
        onContextMenu={menuFor(work.cwd)}
      >
        <span className="tree-dir-label">in</span>
        <span className="tree-dir-path">
          {branchLine(
            line.elsewhere ? line.known.branch : undefined,
            line.label ?? inLabel(shellCwd, work.cwd, home, shellGit?.real),
          )}
        </span>
        {!editsLine && more}
      </span>
      {line.elsewhere && line.known.pr && <PrLine pr={line.known.pr} pane={pane} />}
      {editsLine}
    </>
  )
}

/** A folder line's tooltip, plus why its PR line can't show (gh missing / logged out). */
function withGhHint(text: string, git: PaneGitInfo | undefined): string {
  if (git?.gh === "missing") return `${text}\n\nInstall GitHub CLI (gh) to see this branch's PR.`
  if (git?.gh === "unauthenticated")
    return `${text}\n\nRun \`gh auth login\` to see this branch's PR.`
  return text
}

/** A row's hover ×: takes the meta's place while the row is hovered / focused (CSS only). */
function RowClose({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <button
      className="tree-close"
      title={title}
      aria-label={title}
      // The row's mousedown selects / focuses it — closing must not; nor may the button take
      // focus (the terminal you're typing in keeps it; a dialog focuses its own button).
      onMouseDown={(e) => {
        e.stopPropagation()
        e.preventDefault()
      }}
      onClick={(e) => {
        e.stopPropagation()
        onClose()
        // Closed at once (no dialog): keep typing where you were — or in the terminal that
        // took over if you closed the focused one.
        if (useStore.getState().closeConfirm) return
        requestAnimationFrame(focusActiveEntry)
      }}
    >
      <X size={12} />
    </button>
  )
}

/** "⎇ PR #51 merged" — the number shows it in the pull requests dialog; state colour-coded. */
function PrLine({ pr, pane }: { pr: PrInfo; pane: string }) {
  const ui = prStateUi(pr.state)
  const Icon = pr.state === "merged" ? GitMerge : GitPullRequest
  return (
    <span className="tree-pr">
      <Icon size={12} color={`var(--${ui.color})`} />
      <button
        className="tree-pr-link"
        title={`${pr.url}: show it in the pull requests dialog`}
        // A link: neither focus the row's pane (its click) nor drag its terminal.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation()
          openLink(pr.url, pane)
        }}
        draggable={false}
        onDragStart={(e) => {
          e.preventDefault()
          e.stopPropagation()
        }}
      >
        PR #{pr.number}
      </button>
      <span style={{ color: `var(--${ui.color})` }}>{ui.word}</span>
    </span>
  )
}

const REMOTE_COLLAPSED_KEY = "minmux.sidebar.remoteCollapsed"

// A per-window convenience: storage can be missing or throw (private mode, tests).
// Collapsed until you open it (then your choice is remembered): the header's status says
// what's connected, and its search button opens the picker either way.
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(REMOTE_COLLAPSED_KEY) !== "0"
  } catch {
    return true
  }
}
function writeCollapsed(v: boolean) {
  try {
    localStorage.setItem(REMOTE_COLLAPSED_KEY, v ? "1" : "0")
  } catch {
    // not remembered — fine
  }
}

/** The saved ssh hosts (~/.ssh/config): click → a new tab on the host; hover → split. */
function RemoteHosts() {
  const hosts = useStore((s) => s.sshHosts)
  const loaded = useStore((s) => s.sshHostsLoaded)
  const pinned = useStore((s) => s.settings.ssh.pinned)
  const integration = useStore((s) => s.settings.ssh.integration)
  const mode = useStore((s) => s.settings.ssh.integrationMode)
  const connected = useStore(useShallow((s) => connectedHostIds(s.sessions, s.remotePhase)))
  // Hosts with any pane open (live or not): they stay listed while you work with them.
  const openIds = useStore(
    useShallow((s) => [
      ...new Set(Object.values(s.sessions).flatMap((x) => (x.remote ? [x.remote.hostId] : []))),
    ]),
  )
  const hostColors = useStore((s) => s.settings.ssh.colors)
  // Flattened to primitives for useShallow (a fresh object would re-render every update).
  const [live, connecting, needsYou, down] = useStore(
    useShallow((s) => {
      const r = remoteSummary(s.sessions, s.remotePhase, s.remoteDetail)
      return [r.live, r.connecting, r.needsYou, r.down]
    }),
  )
  const status = summaryText({ live, connecting, needsYou, down })
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const [menu, setMenu] = useState<{ x: number; y: number; host: SshHost } | null>(null)
  const visibleCount = useMemo(() => visibleHosts(hosts).length, [hosts])
  const shown = useMemo(() => sidebarHosts(hosts, pinned, openIds), [hosts, pinned, openIds])
  const groups = useMemo(() => groupHosts(shown), [shown])

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    writeCollapsed(next)
  }
  const browse = () => useStore.getState().setHostPickerOpen(true)
  const open = (h: SshHost, how: "tab" | "row" | "column") => useStore.getState().openHost(h, how)

  return (
    <div className="remote">
      <div className="sidebar-header remote-header">
        <button
          className="remote-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={status ? `Remote: ${status}` : "Remote"}
        >
          {collapsed ? <CaretRight size={11} /> : <CaretDown size={11} />}
          <span className="section-label">Remote</span>
          {status && (
            <span className="remote-status" title={status} aria-hidden>
              {live > 0 && (
                <>
                  <span className="dot accent" />
                  <span className="remote-status-n">{live}</span>
                </>
              )}
              {connecting > 0 && <span className="dot faint pulse" />}
              {needsYou > 0 && <span className="dot amber" />}
              {down > 0 && <span className="dot red" />}
            </span>
          )}
        </button>
        <span className="remote-header-actions">
          <button className="iconbtn" title="Connect to host…" onClick={browse}>
            <MagnifyingGlass size={14} />
          </button>
          <button className="iconbtn" title="Open ssh config" onClick={() => ipc.openSshConfig()}>
            <FileText size={14} />
          </button>
        </span>
      </div>
      {!collapsed && (
        <div className="remote-list">
          {loaded && visibleCount === 0 && hosts.length > 0 && (
            <div className="remote-empty">
              <span className="status-faint">All your hosts are hidden.</span>
              <button className="remote-empty-btn" onClick={browse}>
                Show hidden hosts
              </button>
            </div>
          )}
          {loaded && hosts.length === 0 && (
            <div className="remote-empty">
              <span className="status-faint">
                Hosts come from the <code>Host</code> entries in ~/.ssh/config. Add one there and it
                shows up as you save.
              </span>
              <button className="remote-empty-btn" onClick={() => ipc.openSshConfig()}>
                Open ssh config
              </button>
            </div>
          )}
          {visibleCount > 0 && shown.length === 0 && (
            <div className="remote-empty">
              <span className="status-faint">
                Pinned hosts and hosts you&apos;re using show here.
              </span>
              <button className="remote-empty-btn" onClick={browse}>
                Browse hosts
              </button>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.env}>
              {groups.length > 1 && <div className="remote-group">{g.title}</div>}
              {g.hosts.map((h) => {
                const on = connected.includes(h.hostId)
                const c = hostColor(h.target, hostColors)
                const color = c ? hostColorCss(c) : undefined
                return (
                  // The row's label is its own button; the split buttons are siblings (a
                  // button can't hold buttons — assistive tech would flatten them).
                  <div
                    key={h.hostId}
                    className="tree-row remote-row"
                    style={{ paddingLeft: 12 }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ x: e.clientX, y: e.clientY, host: h })
                    }}
                  >
                    <button
                      className="remote-open"
                      title={`Open a terminal on ${h.label}`}
                      onClick={() => open(h, "tab")}
                    >
                      <span className="tree-icon">
                        <Globe size={14} color={color ?? (on ? "var(--accent)" : "var(--dim)")} />
                      </span>
                      <span className="tree-labels">
                        <span className="tree-primary">{h.label}</span>
                        {h.detail && <span className="tree-sub">{h.detail}</span>}
                      </span>
                    </button>
                    <span className="remote-actions">
                      <button
                        className="iconbtn"
                        title={`Split right on ${h.label}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          open(h, "row")
                        }}
                      >
                        <Columns size={13} />
                      </button>
                      <button
                        className="iconbtn"
                        title={`Split down on ${h.label}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          open(h, "column")
                        }}
                      >
                        <Rows size={13} />
                      </button>
                    </span>
                    {pinned.includes(h.hostId) && (
                      <PushPin size={11} className="remote-pin" aria-label="Pinned" />
                    )}
                    {on && <span className="dot accent" title="Connected" />}
                  </div>
                )
              })}
            </div>
          ))}
          {visibleCount > 0 && (
            <button className="remote-all" onClick={browse}>
              All hosts ({visibleCount})…
            </button>
          )}
        </div>
      )}
      {menu && (
        <ContextMenu<HostActionId>
          x={menu.x}
          y={menu.y}
          items={hostMenuItems({
            pinned: pinned.includes(menu.host.hostId),
            native: menu.host.env === "native",
            integration: mode === "off" ? null : integrationOn(menu.host.label, integration, mode),
          })}
          onSelect={(id) => runHostAction(menu.host, id)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  )
}
