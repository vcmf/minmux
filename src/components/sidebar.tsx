import { useCallback, useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  CaretDown,
  CaretRight,
  Columns,
  FileText,
  GitMerge,
  Globe,
  GitPullRequest,
  Plus,
  Rows,
  Terminal,
} from "@phosphor-icons/react"
import { activeTheme, useStore } from "../store"
import { sessionColor } from "../lib/session-color"
import { claudePaneIds } from "../lib/agent-graph"
import { claudeWorkFlat, inGitFor, inGitKey, inLabel, worksElsewhere } from "../lib/agent-dirs"
import { ClaudeIcon } from "./claude-icon"
import { ContextMenu } from "./context-menu"
import {
  folderMenuItems,
  isAbsoluteHostPath,
  revealLabel,
  type FileActionId,
} from "../lib/file-actions"
import { wslContext } from "../lib/wsl"
import { messageSnippet, prStateUi, type PaneGitInfo, type PrInfo } from "../lib/pane-git"
import { ipc } from "../lib/ipc"
import { TerminalManager } from "../terminal/terminal-manager"
import { allPanes } from "../lib/pane-tree"
import { resolveDefaultShell } from "../lib/shells"
import { statusUi } from "../lib/status-ui"
import { remoteStatusUi, type AuthPrompt } from "../lib/remote-connect"
import { connectedHostIds, groupHosts, hostShellOption, remoteSubline } from "../lib/ssh-hosts-ui"
import type { SshHost } from "../types"
import {
  tabTitle,
  sessionSubline,
  branchLine,
  displaySessionTitle,
  shellType,
} from "../lib/session-label"

/** Left sidebar: a tree of real sessions (tabs) → panes, with live status dots. */
export function Sidebar() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const sessions = useStore((s) => s.sessions)
  const shells = useStore((s) => s.shells)
  const defaultShellPref = useStore((s) => s.settings.defaultShell)
  const paneGit = useStore((s) => s.paneGit) // branch + PR per terminal (polled in App)
  // ssh panes: connecting / at a prompt / disconnected … (stable refs; change on a transition)
  const remotePhase = useStore((s) => s.remotePhase)
  const remoteDetail = useStore((s) => s.remoteDetail)
  // Claude's last reply per pane (newest session root that ran in it), as a flat
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
  // Claude session colours per terminal (same as the pane border + tab icon).
  const agentMeta = useStore((s) => s.agentMeta)
  const scheme = useStore((s) => activeTheme(s).scheme)
  const accentOf = (id: string) => sessionColor(agentMeta[id], scheme)
  // Terminals running Claude (shallow-compared list: re-render only when the set changes).
  const claudePanes = useStore(useShallow((s) => claudePaneIds(s.agents)))
  // Where each pane's Claude works, as memoized primitives: the shallow compare re-renders
  // only when a folder changes, not on every hook event.
  const workFlat = useStore(useShallow((s) => claudeWorkFlat(s.agents)))
  const work: Record<string, { cwd: string; others: string }> = {}
  for (let i = 0; i + 2 < workFlat.length; i += 3)
    work[workFlat[i]!] = { cwd: workFlat[i + 1]!, others: workFlat[i + 2]! }

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

  const focusPane = (tabId: string, sessionId: string) => {
    const store = useStore.getState()
    store.setActiveTab(tabId)
    store.setActivePane(tabId, sessionId)
    requestAnimationFrame(() => TerminalManager.focus(sessionId))
  }

  // Right-click on a folder line: copy it, open a terminal there, or reveal it.
  const [dirMenu, setDirMenu] = useState<{
    x: number
    y: number
    path: string
    sessionId: string
    revealHint?: string // why Reveal is unavailable (undefined = available)
  } | null>(null)
  const openDirMenu = (e: React.MouseEvent, path: string, sessionId: string) => {
    e.preventDefault()
    e.stopPropagation()
    const s = useStore.getState().sessions[sessionId]
    const wsl = s ? wslContext(s.command, s.args) : undefined
    // Reveal needs a path the host OS can open: not a WSL one, nor a POSIX-style path on
    // Windows (Git Bash's /c/…).
    const revealHint = wsl
      ? "WSL path"
      : !isAbsoluteHostPath(path, platform)
        ? "not a host path"
        : undefined
    setDirMenu({ x: e.clientX, y: e.clientY, path, sessionId, revealHint })
  }
  // Closing the menu (Escape, outside click, any action) returns focus to the active terminal
  // — the one you were typing in, or the split "Open terminal here" just made.
  const closeDirMenu = useCallback(() => {
    setDirMenu(null)
    // …unless something else (a text field) still has focus — leave it there.
    const el = document.activeElement
    if (el && el !== document.body) return
    const s = useStore.getState()
    const sid = s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId
    if (sid) requestAnimationFrame(() => TerminalManager.focus(sid))
  }, [])
  const onDirAction = (id: FileActionId) => {
    if (!dirMenu) return
    if (id === "copyPath") ipc.clipboardWrite(dirMenu.path)
    else if (id === "reveal") ipc.revealPath(dirMenu.path)
    else if (id === "openHere") {
      // Split beside that terminal, with its shell (a WSL path opens in WSL); the new split
      // takes focus. A pane closed meanwhile → no-op.
      useStore.getState().splitPaneAt(dirMenu.sessionId, dirMenu.path)
    }
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

      <div className="tree">
        {tabs.map((tab) => {
          const panes = allPanes(tab.root) // one walk → ids, pane count, visible set
          const ids = panes.flatMap((p) => p.sessionIds)
          const paneCount = panes.length
          const visible = new Set(panes.map((p) => p.activeSessionId))
          const open = !collapsed.has(tab.id)
          const active = tab.id === activeTabId
          const focused = sessions[tab.activeSessionId]
          const groupSub = sessionSubline(focused?.cwd, home, branchFor(tab.activeSessionId))
          return (
            <div key={tab.id}>
              <div
                className={`tree-row${active ? " active" : ""}`}
                style={{ paddingLeft: 12 }}
                onMouseDown={() => useStore.getState().setActiveTab(tab.id)}
              >
                <button
                  className="tree-caret tree-icon"
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    toggle(tab.id)
                  }}
                >
                  {open ? <CaretDown size={13} /> : <CaretRight size={13} />}
                </button>
                <div className="tree-labels">
                  <span className="tree-primary-row">
                    <span className="tree-primary session">{tabTitle(tab, sessions, home)}</span>
                    {focused && <span className="pane-badge">{shellType(focused.command)}</span>}
                  </span>
                  {groupSub && (
                    <span className="tree-sub" title={focused?.cwd}>
                      {groupSub}
                    </span>
                  )}
                </div>
                <span className="tree-meta status-faint">
                  {paneCount} {paneCount === 1 ? "pane" : "panes"}
                </span>
              </div>

              {open &&
                ids.map((id) => {
                  const s = sessions[id]
                  if (!s) return null
                  const ui = s.remote
                    ? remoteStatusUi(
                        remotePhase[id],
                        s.status,
                        remoteDetail[id] as AuthPrompt | undefined,
                      )
                    : statusUi(s.status)
                  const isActive = active && tab.activeSessionId === id
                  return (
                    <div
                      key={id}
                      // A surface hidden behind another in its pane reads dimmer.
                      className={`tree-row${isActive ? " active" : ""}${visible.has(id) ? "" : " surface-hidden"}`}
                      style={{ paddingLeft: 32 }}
                      // Left button only: a right-click (folder menu) mustn't switch tabs or
                      // focus the terminal (Escape closing the menu would reach a running Claude).
                      // (macOS Ctrl-click is a right-click that reports button 0.)
                      onMouseDown={(e) =>
                        e.button === 0 &&
                        !(e.ctrlKey && platform === "darwin") &&
                        focusPane(tab.id, id)
                      }
                    >
                      <span className="tree-icon">
                        {(() => {
                          const Icon = claudePanes.includes(id)
                            ? ClaudeIcon
                            : s.remote
                              ? Globe
                              : Terminal
                          return (
                            <Icon
                              size={14}
                              weight="fill"
                              color={accentOf(id) ?? (isActive ? "var(--accent)" : "var(--dim)")}
                            />
                          )
                        })()}
                      </span>
                      <div className="tree-labels">
                        <span className="tree-primary-row">
                          <span className="tree-primary">{displaySessionTitle(s, home)}</span>
                          <span className="pane-badge">{shellType(s.command)}</span>
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
                          <span className="tree-sub" title={s.remote.target}>
                            {remoteSubline(s.remote)}
                          </span>
                        ) : (
                          <DirLines
                            shellCwd={s.cwd}
                            home={home}
                            shellGit={paneGit[id]}
                            inGit={paneGit[inGitKey(id)]}
                            work={work[id]}
                            onMenu={(e, path) => openDirMenu(e, path, id)}
                          />
                        )}
                      </div>
                      {(s.status !== "attention" || ui.word !== "needs input") && (
                        <span
                          className="tree-meta"
                          style={{ color: `var(--${ui.dot === "hollow" ? "faint" : ui.dot})` }}
                        >
                          {ui.word}
                        </span>
                      )}
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
          items={folderMenuItems(revealLabel(platform), dirMenu.revealHint)}
          onSelect={onDirAction}
          onClose={closeDirMenu}
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

/** The folder line(s): one when Claude works where it started (or isn't running); else
 *  `from` (the shell's folder — where the session is saved) + `in` (where Claude works now). */
function DirLines({
  shellCwd,
  home,
  shellGit,
  inGit,
  work,
  onMenu,
}: {
  shellCwd: string | undefined
  home: string
  shellGit: PaneGitInfo | undefined
  inGit: PaneGitInfo | undefined
  work: { cwd: string; others: string } | undefined
  onMenu: (e: React.MouseEvent, path: string) => void
}) {
  const menuFor = (path: string | undefined) =>
    path ? (e: React.MouseEvent) => onMenu(e, path) : undefined
  const extra = work?.others ? work.others.split("\n").length : 0
  const more = extra > 0 && (
    <span className="tree-more" title={`Other worktrees of this session:\n${work!.others}`}>
      +{extra}
    </span>
  )
  if (!shellCwd || !work || !worksElsewhere(shellCwd, work.cwd, shellGit, inGit)) {
    return (
      <>
        <span className="tree-sub tree-dir" title={shellCwd} onContextMenu={menuFor(shellCwd)}>
          <span className="tree-dir-path">
            {sessionSubline(shellCwd, home, shellGit?.branch) || "shell"}
          </span>
          {more}
        </span>
        {shellGit?.pr && <PrLine pr={shellGit.pr} />}
      </>
    )
  }
  // Each line keeps its own PR: the session belongs to `from`'s branch, the work to `in`'s.
  return (
    <>
      <span
        className="tree-sub tree-dir"
        title={`Claude started here (the session is saved under it):\n${shellCwd}`}
        onContextMenu={menuFor(shellCwd)}
      >
        <span className="tree-dir-label">from</span>
        <span className="tree-dir-path">{sessionSubline(shellCwd, home, shellGit?.branch)}</span>
      </span>
      {shellGit?.pr && <PrLine pr={shellGit.pr} />}
      <span
        className="tree-sub tree-dir"
        title={`Claude is working here now:\n${work.cwd}`}
        onContextMenu={menuFor(work.cwd)}
      >
        <span className="tree-dir-label">in</span>
        <span className="tree-dir-path">
          {branchLine(
            inGitFor(inGit, work.cwd)?.branch,
            inLabel(shellCwd, work.cwd, home, shellGit?.real),
          )}
        </span>
        {more}
      </span>
      {inGitFor(inGit, work.cwd)?.pr && <PrLine pr={inGit!.pr!} />}
    </>
  )
}

/** "⎇ PR #51 merged" — the number opens the PR in the browser; the state is colour-coded. */
function PrLine({ pr }: { pr: PrInfo }) {
  const ui = prStateUi(pr.state)
  const Icon = pr.state === "merged" ? GitMerge : GitPullRequest
  return (
    <span className="tree-pr">
      <Icon size={12} color={`var(--${ui.color})`} />
      <button
        className="tree-pr-link"
        title={pr.url}
        // Don't let the row's mousedown focus the pane — this is a link.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={() => ipc.openExternal(pr.url)}
      >
        PR #{pr.number}
      </button>
      <span style={{ color: `var(--${ui.color})` }}>{ui.word}</span>
    </span>
  )
}

const REMOTE_COLLAPSED_KEY = "smterm.sidebar.remoteCollapsed"

// A per-window convenience: storage can be missing or throw (private mode, tests).
function readCollapsed(): boolean {
  try {
    return localStorage.getItem(REMOTE_COLLAPSED_KEY) === "1"
  } catch {
    return false
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
  const connected = useStore(useShallow((s) => connectedHostIds(s.sessions, s.remotePhase)))
  const [collapsed, setCollapsed] = useState(readCollapsed)
  const groups = useMemo(() => groupHosts(hosts), [hosts])

  const toggle = () => {
    setCollapsed((v) => {
      writeCollapsed(!v)
      return !v
    })
  }
  const open = (h: SshHost) => useStore.getState().newTab(hostShellOption(h))
  const split = (h: SshHost, direction: "row" | "column") =>
    useStore.getState().splitWith(direction, hostShellOption(h))

  return (
    <div className="remote">
      <div className="sidebar-header remote-header">
        <button className="remote-toggle" onClick={toggle} aria-expanded={!collapsed}>
          {collapsed ? <CaretRight size={11} /> : <CaretDown size={11} />}
          <span className="section-label">Remote</span>
          {hosts.length > 0 && <span className="status-faint remote-count">{hosts.length}</span>}
        </button>
        <button className="iconbtn" title="Open ssh config" onClick={() => ipc.openSshConfig()}>
          <FileText size={14} />
        </button>
      </div>
      {!collapsed && (
        <div className="remote-list">
          {loaded && hosts.length === 0 && (
            <div className="remote-empty">
              <span className="status-faint">No hosts in ~/.ssh/config</span>
              <button className="remote-empty-btn" onClick={() => ipc.openSshConfig()}>
                Open ssh config
              </button>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.env}>
              {groups.length > 1 && <div className="remote-group">{g.title}</div>}
              {g.hosts.map((h) => {
                const on = connected.includes(h.hostId)
                return (
                  // The row's label is its own button; the split buttons are siblings (a
                  // button can't hold buttons — assistive tech would flatten them).
                  <div key={h.hostId} className="tree-row remote-row" style={{ paddingLeft: 12 }}>
                    <button
                      className="remote-open"
                      title={`Open a terminal on ${h.label}`}
                      onClick={() => open(h)}
                    >
                      <span className="tree-icon">
                        <Globe size={14} color={on ? "var(--accent)" : "var(--dim)"} />
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
                          split(h, "row")
                        }}
                      >
                        <Columns size={13} />
                      </button>
                      <button
                        className="iconbtn"
                        title={`Split down on ${h.label}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          split(h, "column")
                        }}
                      >
                        <Rows size={13} />
                      </button>
                    </span>
                    {on && <span className="dot accent" title="Connected" />}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
