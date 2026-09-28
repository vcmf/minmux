import { useEffect, useMemo, useRef, useState } from "react"
import {
  Plus,
  CaretDown,
  MagnifyingGlass,
  GearSix,
  GitDiff,
  TreeStructure,
  FolderOpen,
  Bell,
  Minus,
  Square,
  X,
  Copy,
  SidebarSimple,
  Sun,
  Moon,
  Globe,
  Plugs,
} from "@phosphor-icons/react"
import { activeTheme, useStore } from "../store"
import { ipc } from "../lib/ipc"
import { allSessionIds } from "../lib/pane-tree"
import { aggregateBadge } from "../lib/session-status"
import { countWaitingRemote, tabRemoteBadge } from "../lib/remote-connect"
import { hostColor, hostColorCss } from "../lib/ssh-hosts-ui"
import { tabTitleParts } from "../lib/session-label"
import { resolveDefaultShell } from "../lib/shells"
import { envTitle } from "../lib/ssh-hosts-ui"
import { hostSections, visibleHosts } from "../lib/ssh-host-list"
import { TerminalManager } from "../terminal/terminal-manager"
import brandIcon from "../assets/icon.png"

/** How many hosts the new-tab menu lists before "All hosts…". */
const QUICK_HOSTS = 6

/** The mux top bar: brand · session tabs · search pill · window controls. */
export function TopBar() {
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const shells = useStore((s) => s.shells)
  const sshHosts = useStore((s) => s.sshHosts)
  const sshPinned = useStore((s) => s.settings.ssh.pinned)
  const sshRecent = useStore((s) => s.sshRecent)
  // The new-tab menu's short list: the picker's order (pinned, recent, config), first few.
  const quickHosts = useMemo(
    () =>
      hostSections(sshHosts, { pinned: sshPinned, recent: sshRecent })
        .flatMap((s) => s.hosts)
        .slice(0, QUICK_HOSTS),
    [sshHosts, sshPinned, sshRecent],
  )
  const sessions = useStore((s) => s.sessions)
  const remotePhase = useStore((s) => s.remotePhase)
  const remoteDetail = useStore((s) => s.remoteDetail)
  const windowFocused = useStore((s) => s.windowFocused)
  const hostColors = useStore((s) => s.settings.ssh.colors)
  // ssh panes waiting at a Connect prompt (a relaunch under on-focus): one click connects all.
  const waitingSsh = useStore((s) =>
    countWaitingRemote(s.sessions, s.remotePhase, s.settings.ssh.restore),
  )
  const home = useStore((s) => s.home)
  const defaultShellPref = useStore((s) => s.settings.defaultShell)
  const rightView = useStore((s) => s.rightView)
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed)
  const scheme = useStore((s) => activeTheme(s).scheme)
  const profile = useStore((s) => s.profile)
  const [maximized, setMaximized] = useState(false)
  const [shellMenu, setShellMenu] = useState(false)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [editingId])

  useEffect(() => {
    void ipc.isMaximized().then(setMaximized)
    return ipc.onMaximizeChange(setMaximized)
  }, [])

  const defaultShell = resolveDefaultShell(shells, defaultShellPref)

  const openTab = (shell = defaultShell) => {
    if (shell) useStore.getState().newTab(shell)
    setShellMenu(false)
  }

  // Sessions awaiting the user, in tab order — drives the bell count + jump.
  const waiting: { tabId: string; sessionId: string }[] = []
  for (const tab of tabs) {
    for (const id of allSessionIds(tab.root)) {
      // Needs you: attention, or an ssh pane at a password / host-key prompt — unless it's the
      // pane you're looking at (the attention rule: never nag the pane you're driving).
      const driving = windowFocused && tab.id === activeTabId && tab.activeSessionId === id
      if (sessions[id]?.status === "attention" || (remotePhase[id] === "prompt" && !driving)) {
        waiting.push({ tabId: tab.id, sessionId: id })
      }
    }
  }

  const jumpToWaiting = () => {
    if (waiting.length === 0) return
    const cur = tabs.find((t) => t.id === activeTabId)?.activeSessionId
    const idx = waiting.findIndex((w) => w.tabId === activeTabId && w.sessionId === cur)
    const target = waiting[(idx + 1) % waiting.length]! // idx === -1 → first
    const store = useStore.getState()
    store.setActiveTab(target.tabId)
    store.setActivePane(target.tabId, target.sessionId)
    requestAnimationFrame(() => TerminalManager.focus(target.sessionId))
  }

  const startRename = (id: string, title: string) => {
    setDraft(title)
    setEditingId(id)
  }
  const commitRename = () => {
    if (editingId) {
      const name = draft.trim()
      if (name) useStore.getState().renameTab(editingId, name)
    }
    setEditingId(null)
  }

  return (
    <div className="topbar">
      <button
        className={`iconbtn${sidebarCollapsed ? "" : " on"}`}
        title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
        onClick={() => useStore.getState().setSidebarCollapsed(!sidebarCollapsed)}
      >
        <SidebarSimple size={15} />
      </button>
      <div className="brand">
        <img className="brand-icon" src={brandIcon} alt="" width={18} height={18} />
        <span className="brand-name">smterm</span>
        {profile && (
          <span
            className="brand-profile"
            title={`Profile "${profile}" — its own settings and layout`}
          >
            {profile}
          </span>
        )}
      </div>
      <div className="vdivider" />

      <div className="tabs">
        <div className="tab-list">
          {tabs.map((tab) => {
            const ids = allSessionIds(tab.root)
            const badge = aggregateBadge(
              ids.flatMap((id) => {
                const s = sessions[id]
                return s ? [{ status: s.status, unread: s.unread }] : []
              }),
            )
            // An ssh pane at a prompt reads as needing input; a dropped one, red (after attention).
            const remote = tabRemoteBadge(
              ids.map((id) => ({ phase: remotePhase[id], detail: remoteDetail[id] })),
            )
            const pulse = badge === "working" && !remote
            const dotClass =
              badge === "attention" || remote === "prompt"
                ? "amber"
                : remote === "down"
                  ? "red"
                  : badge === "working"
                    ? "accent"
                    : "faint"
            return (
              <div
                key={tab.id}
                className={`tab${tab.id === activeTabId ? " active" : ""}`}
                // The focused pane's host colour, as an underline (a prod tab reads as prod).
                style={(() => {
                  const r = sessions[tab.activeSessionId]?.remote
                  const c = r ? hostColor(r.target, hostColors) : undefined
                  return c ? { boxShadow: `inset 0 -2px 0 ${hostColorCss(c)}` } : undefined
                })()}
                onMouseDown={() => useStore.getState().setActiveTab(tab.id)}
                // The name only: the live "+N" must not be pinned into a manual title.
                onDoubleClick={() => startRename(tab.id, tabTitleParts(tab, sessions, home).base)}
              >
                {(badge || remote) && (
                  <span
                    className={`dot ${dotClass}${pulse ? " pulse" : ""}`}
                    title={remote === "down" ? "An ssh session here is disconnected" : undefined}
                  />
                )}
                {editingId === tab.id ? (
                  <input
                    ref={inputRef}
                    className="tab-rename"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onMouseDown={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename()
                      else if (e.key === "Escape") setEditingId(null)
                    }}
                  />
                ) : (
                  (() => {
                    const { base, more } = tabTitleParts(tab, sessions, home)
                    return (
                      <>
                        <span className="tab-title">{base}</span>
                        {more && (
                          <span className="tab-more" title="Panes here run on other places too">
                            {more}
                          </span>
                        )}
                      </>
                    )
                  })()
                )}
                {ids.length > 1 && <span className="tab-count">{ids.length}</span>}
                <button
                  className="tab-close"
                  title="Close tab"
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    useStore.getState().requestCloseTab(tab.id) // asks first when it'd kill work
                  }}
                >
                  <X size={11} />
                </button>
              </div>
            )
          })}
        </div>
        <div className="newtab">
          <button
            className="iconbtn"
            title="New tab"
            disabled={!defaultShell}
            onClick={() => openTab()}
          >
            <Plus size={14} />
          </button>
          <button
            className="iconbtn newtab-caret"
            title="New tab in…"
            disabled={shells.length === 0 && quickHosts.length === 0}
            onClick={() => setShellMenu((v) => !v)}
          >
            <CaretDown size={11} />
          </button>
          {shellMenu && (
            <>
              <div className="menu-backdrop" onMouseDown={() => setShellMenu(false)} />
              <div className="shell-menu">
                {shells.map((sh) => (
                  <button key={sh.id} className="shell-menu-item" onMouseDown={() => openTab(sh)}>
                    <span>{sh.label}</span>
                    {sh.id === defaultShell?.id && <span className="shell-menu-def">default</span>}
                  </button>
                ))}
                {quickHosts.length > 0 && <div className="shell-menu-group">SSH</div>}
                {quickHosts.map((h) => (
                  <button
                    key={h.hostId}
                    className="shell-menu-item"
                    title={h.detail}
                    onMouseDown={() => {
                      setShellMenu(false)
                      useStore.getState().openHost(h, "tab")
                    }}
                  >
                    <span className="shell-menu-host">
                      <Globe size={12} />
                      <span className="shell-menu-host-name">{h.label}</span>
                    </span>
                    {h.env !== "native" && (
                      <span className="shell-menu-def">{envTitle(h.env)}</span>
                    )}
                  </button>
                ))}
                {visibleHosts(sshHosts).length > quickHosts.length && (
                  <button
                    className="shell-menu-item shell-menu-more"
                    onMouseDown={(e) => {
                      e.preventDefault() // the picker's input keeps the focus it takes
                      setShellMenu(false)
                      useStore.getState().setHostPickerOpen(true)
                    }}
                  >
                    All hosts ({visibleHosts(sshHosts).length})…
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="topbar-right">
        {waitingSsh >= 2 && (
          <button
            className="connect-all"
            title="Connect every ssh pane that's waiting"
            onClick={() => TerminalManager.connectAll()}
          >
            <Plugs size={13} />
            Connect all ({waitingSsh})
          </button>
        )}
        <button
          className={`iconbtn bell${waiting.length ? " has" : ""}`}
          title={waiting.length ? `${waiting.length} waiting — jump` : "No sessions waiting"}
          disabled={waiting.length === 0}
          onClick={jumpToWaiting}
        >
          <Bell size={15} weight={waiting.length ? "fill" : "regular"} />
          {waiting.length > 0 && <span className="bell-count">{waiting.length}</span>}
        </button>
        <button className="searchpill" onClick={() => useStore.getState().setPaletteOpen(true)}>
          <MagnifyingGlass size={12} />
          <span>Search or run</span>
          <span className="kbd">⌘K</span>
        </button>
        {/* One right-side panel; these icons switch its view (click active → hide). */}
        <button
          className={`iconbtn${rightView === "files" ? " on" : ""}`}
          title="Files"
          onClick={() => useStore.getState().setRightView(rightView === "files" ? null : "files")}
        >
          <FolderOpen size={15} />
        </button>
        <button
          className={`iconbtn${rightView === "changes" ? " on" : ""}`}
          title="Changes"
          onClick={() =>
            useStore.getState().setRightView(rightView === "changes" ? null : "changes")
          }
        >
          <GitDiff size={15} />
        </button>
        <button
          className={`iconbtn${rightView === "agents" ? " on" : ""}`}
          title="Agents"
          onClick={() => useStore.getState().setRightView(rightView === "agents" ? null : "agents")}
        >
          <TreeStructure size={15} />
        </button>
        {/* One-click dark ↔ light for the current theme (leaves "system" for an explicit pick). */}
        <button
          className="iconbtn"
          title={scheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          aria-label={scheme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          onClick={() => {
            const st = useStore.getState()
            st.updateSettings({ ...st.settings, appearance: scheme === "dark" ? "light" : "dark" })
          }}
        >
          {scheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <button
          className="iconbtn"
          title="Settings"
          onClick={() => useStore.getState().setSettingsOpen(true)}
        >
          <GearSix size={15} />
        </button>
        <div className="vdivider" />
        <div className="wincontrols">
          <button className="winbtn" title="Minimize" onClick={() => ipc.minimizeWindow()}>
            <Minus size={11} />
          </button>
          <button
            className="winbtn"
            title={maximized ? "Restore" : "Maximize"}
            onClick={() => ipc.maximizeWindow()}
          >
            {maximized ? <Copy size={11} /> : <Square size={11} />}
          </button>
          <button className="winbtn close" title="Close" onClick={() => ipc.closeWindow()}>
            <X size={12} />
          </button>
        </div>
      </div>
    </div>
  )
}
