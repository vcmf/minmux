import { create } from "zustand"
import type { Session, ShellOption, SshHost, Tab } from "./types"
import {
  addSurface,
  allSessionIds,
  findPane,
  findPaneById,
  firstSessionId,
  makeLeaf,
  moveSurface,
  removeNode,
  removePane,
  selectSurface,
  splitNode,
  visibleSessionIds,
} from "./lib/pane-tree"
import { inheritShell, resolveDefaultShell } from "./lib/shells"
import { sameHosts } from "./lib/ssh-hosts-ui"
import { reduceSignals } from "./lib/session-status"
import type { SignalEvent } from "./lib/session-status"
import { inGitKey, paneOfGitKey } from "./lib/agent-dirs"
import { reduceAgentEvent, emptyGraph, dropPaneSessions } from "./lib/agent-graph"
import type { AgentEvent, AgentGraph } from "./lib/agent-graph"
import { defaultSettings, mergeSettings } from "./settings/schema"
import { saveSettings } from "./settings/io"
import { resolveTheme, type Theme } from "./settings/themes"
import type { Settings } from "./settings/schema"
import type { GitStatus } from "./lib/ipc"
import { isAbsoluteHostPath } from "./lib/file-actions"
import type { EditorInfo } from "./lib/file-actions"
import { normalizeRootPath } from "./lib/breadcrumb"
import type { WslContext } from "./lib/wsl"
import type { WorkspaceState } from "./lib/workspace"
import type { MoveTarget } from "./lib/pane-tree"
import type { SessionMeta } from "./lib/session-color"
import { mergePaneGit, type PaneGitInfo } from "./lib/pane-git"
import type { ResumeState } from "./lib/resume"
import { clampPanelWidth, RIGHT_PANEL_DEFAULT } from "./lib/right-panel"

const newId = () => crypto.randomUUID()

function makeSession(shell: ShellOption, initialCwd?: string): Session {
  return {
    id: newId(),
    title: shell.label,
    command: shell.command,
    args: shell.args,
    status: "idle",
    unread: false,
    // A remote session's shell runs on the host: a local cwd would be meaningless there.
    ...(shell.remote ? { remote: { ...shell.remote } } : { cwd: initialCwd }),
    ...(shell.remote && shell.remoteSaved !== undefined ? { remoteSaved: shell.remoteSaved } : {}),
  }
}

/** The shell to open a LOCAL folder with, beside `src`: its own, unless it's an ssh session
 *  (the folder is on this machine, not the host) — then the default local shell. */
function localShellFor(state: AppState, src: Session | undefined): ShellOption | undefined {
  const inherited = inheritShell(state.shells, src)
  if (inherited && !inherited.remote) return inherited
  return resolveDefaultShell(state.shells, state.settings.defaultShell)
}

/** The cwd of the currently focused terminal, if known — new panes/tabs inherit it. */
function focusedCwd(state: AppState): string | undefined {
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  const sid = tab?.activeSessionId
  return sid ? state.sessions[sid]?.cwd : undefined
}

/** The single right-side panel's active view (null = hidden). Files / Changes / Agents
 *  share one panel — the top-bar icons switch it (click the active one to hide). */
export type RightView = "files" | "changes" | "agents" | null

/** A pane close awaiting confirmation (the pane holds several terminals). */
export interface ClosePaneConfirm {
  tabId: string
  paneId: string
  count: number
}

interface AppState {
  sessions: Record<string, Session>
  tabs: Tab[]
  activeTabId: string | null
  shells: ShellOption[]
  sshHosts: SshHost[] // saved ssh hosts (main's list, refreshed when ~/.ssh/config changes)
  windowFocused: boolean
  systemDark: boolean // OS prefers a dark colour scheme (drives appearance: "system")
  settings: Settings
  settingsOpen: boolean
  paletteOpen: boolean
  searchOpen: boolean
  rightView: RightView // which view the single right-side panel shows (null = hidden)
  rightPanelWidth: number // px width of the right panel (drag-resizable, persisted)
  sidebarCollapsed: boolean
  git: GitStatus | null
  agents: AgentGraph // live tree of Claude agents/sub-agents (M6, fed by hook events)
  home: string
  platform: string // process.platform ("darwin"|"win32"|"linux"); "" until fetched
  editor: EditorInfo | null // configured editor availability (file context menu)
  // file open in the preview popup (null = closed); wsl = the pane's distro so a WSL path
  // is read via its UNC share (captured at open time — the active pane may change after).
  preview: { abs: string; name: string; wsl?: WslContext } | null
  paneRoot: Record<string, string> // per-session Files-panel root override (absent = follow cwd)
  closePaneConfirm: ClosePaneConfirm | null // multi-surface pane close awaiting the dialog
  dragging: { tabId: string; sessionId: string } | null // surface being dragged (drop hints on)
  agentMeta: Record<string, SessionMeta> // per pane: the Claude session's /color + /rename
  paneGit: Record<string, PaneGitInfo> // per terminal: branch + GitHub PR (sidebar)
  resume: Record<string, ResumeState> // per terminal: Claude-session resume banner

  setHome: (home: string) => void
  setPlatform: (platform: string) => void
  setEditor: (editor: EditorInfo) => void
  setPreview: (preview: { abs: string; name: string; wsl?: WslContext } | null) => void
  setPaneRoot: (sessionId: string, root: string) => void
  clearPaneRoot: (sessionId: string) => void
  setSessionOscTitle: (sessionId: string, title: string) => void
  setGit: (git: GitStatus | null) => void
  applyAgentEvents: (events: AgentEvent[]) => void
  claudeExited: (paneId: string) => void // the pane's shell prompt came back after Claude
  setRightView: (view: RightView) => void
  setSessionCwd: (sessionId: string, cwd: string) => void
  setPaletteOpen: (open: boolean) => void
  setSearchOpen: (open: boolean) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setSettings: (settings: Settings) => void
  updateSettings: (next: Settings) => void // validate + apply + persist (every UI entry point)
  settingsLoaded: boolean // settings.json read at least once (gates theming + first spawns)
  setShells: (shells: ShellOption[]) => void
  setSshHosts: (hosts: SshHost[]) => void
  restoreWorkspace: (ws: WorkspaceState) => void
  setRightPanelWidth: (px: number, maxAvail?: number) => void
  newTab: (shell: ShellOption) => void
  splitWith: (direction: "row" | "column", shell: ShellOption) => void // a new tab if none
  closeTab: (tabId: string) => void
  setActiveTab: (tabId: string) => void
  renameTab: (tabId: string, title: string) => void
  splitActive: (direction: "row" | "column", fallback?: ShellOption) => void
  openFolderInSplit: (cwd: string, paneId?: string) => void // split active pane at cwd; shell from paneId
  splitPaneAt: (paneId: string, cwd: string) => void // split beside that pane (its shell); not "seen"
  newSurface: (fallback?: ShellOption) => void // new terminal tab in the focused pane
  closeSurface: (tabId: string, sessionId: string) => void // one terminal; last one closes the pane
  closePane: (tabId: string, paneId: string) => void // the pane with all its terminals
  requestClosePane: (tabId: string, paneId: string) => void // confirms first if several terminals
  cancelClosePane: () => void
  setDragging: (dragging: { tabId: string; sessionId: string } | null) => void
  setAgentMeta: (sessionId: string, meta: SessionMeta | null) => void
  setPaneGit: (fresh: Record<string, PaneGitInfo>, polled: string[]) => void
  setResume: (sessionId: string, state: ResumeState | null) => void
  moveSurface: (tabId: string, sessionId: string, target: MoveTarget) => void // drag & drop
  setActivePane: (tabId: string, sessionId: string) => void
  focusSession: (sessionId: string) => void
  setWindowFocused: (focused: boolean) => void
  setSystemDark: (dark: boolean) => void
  signalSession: (sessionId: string, ev: SignalEvent) => void
  revealTab: (tabId: string) => void
}

/** Whether the user is actively looking at this exact session: window focused +
 *  it's the active tab's focused pane. Per-pane, so the heuristic never nags (and
 *  we don't badge) the pane you're driving. */
export function isVisibleIn(state: AppState, sessionId: string): boolean {
  if (!state.windowFocused || !state.activeTabId) return false
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  return tab?.activeSessionId === sessionId
}

/** Mark a session as seen: drop attention/unread/reason. A still-running agent
 *  falls back to "working" (not idle) so it keeps reading as active. */
function seen(s: Session): Session {
  if (s.status !== "attention" && !s.unread && !s.detail) return s
  return {
    ...s,
    status: s.status === "attention" ? (s.running ? "working" : "idle") : s.status,
    unread: false,
    detail: undefined,
  }
}

/** The theme to render now: the settings' family in its dark/light variant (OS for "system"). */
export const activeTheme = (s: Pick<AppState, "settings" | "systemDark">): Theme =>
  resolveTheme(s.settings.theme, s.settings.appearance, s.systemDark)

export const isSessionVisible = (sessionId: string): boolean =>
  isVisibleIn(useStore.getState(), sessionId)

// Split the active tab's active pane with a new session (shell + cwd + direction).
// Shared by splitActive (inherit the active pane) and openFolderInSplit (agents board);
// each caller resolves its own shell/cwd, this owns the pane-tree mechanics.
function splitActivePane(
  state: AppState,
  opts: { shell: ShellOption; cwd?: string; direction: "row" | "column" },
): Partial<AppState> {
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  if (!tab) return {}
  const session = makeSession(opts.shell, opts.cwd)
  const root = splitNode(
    tab.root,
    tab.activeSessionId,
    opts.direction,
    session.id,
    newId(),
    newId(),
  )
  return {
    sessions: { ...state.sessions, [session.id]: session },
    tabs: state.tabs.map((t) =>
      t.id === tab.id ? { ...t, root, activeSessionId: session.id } : t,
    ),
  }
}

/** Make `sessionId` the tab's focus and its pane's visible surface (same tab if unchanged). */
function focusIn(tab: Tab, sessionId: string): Tab {
  const root = selectSurface(tab.root, sessionId)
  if (root === tab.root && tab.activeSessionId === sessionId) return tab
  return { ...tab, root, activeSessionId: sessionId }
}

/** Apply `fn` to one tab; the SAME array when unchanged (keeps `tabs` subscribers quiet). */
function replaceTab(tabs: Tab[], tabId: string, fn: (t: Tab) => Tab): Tab[] {
  const i = tabs.findIndex((t) => t.id === tabId)
  if (i === -1) return tabs
  const next = fn(tabs[i]!)
  if (next === tabs[i]) return tabs
  const out = tabs.slice()
  out[i] = next
  return out
}

/** Sessions map with `sessionId` marked seen; the same map when nothing changes. */
function markSeen(sessions: Record<string, Session>, sessionId: string): Record<string, Session> {
  const s = sessions[sessionId]
  const next = s && seen(s)
  return next && next !== s ? { ...sessions, [sessionId]: next } : sessions
}

/** Drop sessions (and their Files-panel root overrides) from the store maps. */
function dropSessions(
  state: AppState,
  ids: string[],
): Pick<AppState, "sessions" | "paneRoot" | "agentMeta" | "paneGit" | "resume"> {
  const sessions = { ...state.sessions }
  const paneRoot = { ...state.paneRoot }
  const agentMeta = { ...state.agentMeta }
  const paneGit = { ...state.paneGit }
  const resume = { ...state.resume }
  for (const id of ids) {
    delete resume[id]
    delete paneGit[id]
    delete paneGit[inGitKey(id)] // …and its Claude `in` folder's
    delete sessions[id]
    delete paneRoot[id] // don't leak the pane's root override
    delete agentMeta[id] // …or its Claude accent
  }
  return { sessions, paneRoot, agentMeta, paneGit, resume }
}

/** Remove a tab; if it was active, the last remaining tab takes over. */
function withoutTab(state: AppState, tabId: string): Pick<AppState, "tabs" | "activeTabId"> {
  const tabs = state.tabs.filter((t) => t.id !== tabId)
  const activeTabId =
    state.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : state.activeTabId
  return { tabs, activeTabId }
}

export const useStore = create<AppState>((set, get) => ({
  sessions: {},
  tabs: [],
  activeTabId: null,
  shells: [],
  sshHosts: [],
  windowFocused: true,
  // Seeded from the OS now (not after an effect) so "system" never starts on the wrong scheme.
  systemDark:
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true,
  settings: defaultSettings,
  settingsLoaded: false,
  settingsOpen: false,
  paletteOpen: false,
  searchOpen: false,
  rightView: null,
  rightPanelWidth: RIGHT_PANEL_DEFAULT,
  sidebarCollapsed: false,
  git: null,
  agents: emptyGraph,
  home: "",
  platform: "",
  editor: null,
  preview: null,
  paneRoot: {},
  closePaneConfirm: null,
  dragging: null,
  agentMeta: {},
  paneGit: {},
  resume: {},

  setHome: (home) => set({ home }),
  setPlatform: (platform) => set({ platform }),
  setEditor: (editor) => set({ editor }),
  setPreview: (preview) => set({ preview }),
  // Central guard for every reroot entry point (double-click, context menu, breadcrumb,
  // typed path, picker): normalize and require an absolute path. WSL panes are allowed —
  // their Linux paths (/home/…) are absolute, and readdir/preview read them via the
  // distro's UNC share (the old WSL rejection predated that translation).
  setPaneRoot: (sessionId, root) =>
    set((s) => {
      if (!s.sessions[sessionId]) return {}
      const norm = normalizeRootPath(root)
      if (!isAbsoluteHostPath(norm)) return {}
      return { paneRoot: { ...s.paneRoot, [sessionId]: norm } }
    }),
  clearPaneRoot: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.paneRoot)) return {}
      const next = { ...s.paneRoot }
      delete next[sessionId]
      return { paneRoot: next }
    }),
  setSessionOscTitle: (sessionId, title) =>
    set((state) => {
      const s = state.sessions[sessionId]
      const next = title.trim()
      if (!s || !next || s.oscTitle === next) return {}
      return { sessions: { ...state.sessions, [sessionId]: { ...s, oscTitle: next } } }
    }),
  setGit: (git) => set({ git }),

  // Fold a coalesced batch of hook events into the agent tree (one re-render per batch).
  applyAgentEvents: (events) =>
    set((state) => ({ agents: events.reduce(reduceAgentEvent, state.agents) })),
  claudeExited: (paneId) =>
    set((state) => {
      const agents = dropPaneSessions(state.agents, paneId)
      return agents === state.agents ? state : { agents }
    }),
  setRightView: (rightView) => set({ rightView }),
  setSessionCwd: (sessionId, cwd) =>
    set((state) => {
      const s = state.sessions[sessionId]
      // A remote shell's OSC 7 path is on the host: local panels must never read it.
      if (!s || s.remote || s.cwd === cwd) return {}
      return { sessions: { ...state.sessions, [sessionId]: { ...s, cwd } } }
    }),
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  setSearchOpen: (searchOpen) => set({ searchOpen }),
  setSidebarCollapsed: (sidebarCollapsed) => set({ sidebarCollapsed }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setSettings: (settings) => set({ settings, settingsLoaded: true }),
  updateSettings: (next) => {
    const validated = mergeSettings(next)
    set({ settings: validated, settingsLoaded: true })
    void saveSettings(validated)
  },
  setShells: (shells) => set({ shells }),
  // Unchanged → the same state object, so nothing is notified.
  setSshHosts: (hosts) =>
    set((state) => (sameHosts(state.sshHosts, hosts) ? state : { sshHosts: hosts })),

  restoreWorkspace: (ws) =>
    set({
      sessions: ws.sessions,
      tabs: ws.tabs,
      activeTabId: ws.activeTabId,
      ...(ws.rightPanelWidth !== undefined ? { rightPanelWidth: ws.rightPanelWidth } : {}),
    }),
  setRightPanelWidth: (px, maxAvail) => set({ rightPanelWidth: clampPanelWidth(px, maxAvail) }),

  newTab: (shell) =>
    set((state) => {
      const session = makeSession(shell, focusedCwd(state))
      const tab: Tab = {
        id: newId(),
        title: "", // unpinned — display derives from the focused pane's live title
        root: makeLeaf(newId(), session.id),
        activeSessionId: session.id,
      }
      return {
        sessions: { ...state.sessions, [session.id]: session },
        tabs: [...state.tabs, tab],
        activeTabId: tab.id,
      }
    }),

  closeTab: (tabId) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      if (!tab) return {}
      return { ...dropSessions(state, allSessionIds(tab.root)), ...withoutTab(state, tabId) }
    }),

  setActiveTab: (tabId) => {
    set({ activeTabId: tabId })
    get().revealTab(tabId)
  },

  renameTab: (tabId, title) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
    })),

  // Split the active pane with a given shell (e.g. an ssh host), not the source's own.
  splitWith: (direction, shell) => {
    if (!get().tabs.some((t) => t.id === get().activeTabId)) return get().newTab(shell)
    set((state) => splitActivePane(state, { shell, direction }))
  },

  splitActive: (direction, fallback) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab) return {}
      // Inherit the source pane's shell + cwd (WSL → WSL), not the list's first entry.
      const src = state.sessions[tab.activeSessionId]
      const shell = inheritShell(state.shells, src) ?? fallback
      if (!shell) return {}
      return splitActivePane(state, { shell, cwd: src?.cwd, direction })
    }),

  // Open a folder (an agent's cwd / worktree from the board) as a split beside the active
  // pane. Resolves the shell from the AGENT's own pane (paneId) so a WSL agent's path opens
  // in a WSL shell, not the active native pane's; a missing dir falls back to $HOME in main.
  openFolderInSplit: (cwd, paneId) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab) return {}
      const agentSession = paneId ? state.sessions[paneId] : undefined
      const src = state.sessions[tab.activeSessionId]
      const shell = localShellFor(state, agentSession ?? src)
      if (!shell) return {}
      return splitActivePane(state, { shell, cwd, direction: "row" })
    }),

  // A terminal at `cwd` beside pane `paneId` (any tab), with its shell — the new split takes
  // focus. Unlike focusing the pane first, its attention/unread state stays (you never looked).
  splitPaneAt: (paneId, cwd) => {
    const before = get().activeTabId
    set((state) => {
      const tab = state.tabs.find((t) => allSessionIds(t.root).includes(paneId))
      const shell = localShellFor(state, state.sessions[paneId])
      if (!tab || !shell) return {}
      // Split the pane holding it — as shown (no surface swap), not marked seen itself.
      const tabs = state.tabs.map((t) => (t.id === tab.id ? { ...t, activeSessionId: paneId } : t))
      const at = { ...state, activeTabId: tab.id, tabs }
      return { activeTabId: tab.id, ...splitActivePane(at, { shell, cwd, direction: "row" }) }
    })
    // Switched tabs: what's now on screen counts as seen (as setActiveTab does).
    const now = get().activeTabId
    if (now && now !== before) get().revealTab(now)
  },

  // New terminal as a tab (surface) of the focused pane, inheriting its shell + cwd.
  newSurface: (fallback) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab) return {}
      const pane = findPane(tab.root, tab.activeSessionId)
      if (!pane) return {}
      const src = state.sessions[tab.activeSessionId]
      const shell = inheritShell(state.shells, src) ?? fallback
      if (!shell) return {}
      const session = makeSession(shell, src?.cwd)
      const root = addSurface(tab.root, pane.id, session.id)
      return {
        sessions: { ...state.sessions, [session.id]: session },
        tabs: replaceTab(state.tabs, tab.id, (t) => ({ ...t, root, activeSessionId: session.id })),
      }
    }),

  closeSurface: (tabId, sessionId) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      const pane = tab && findPane(tab.root, sessionId)
      if (!tab || !pane) return {}
      const dropped = dropSessions(state, [sessionId])
      const root = removeNode(tab.root, sessionId)
      if (root === null) return { ...dropped, ...withoutTab(state, tabId) }
      // Closing the focused terminal: focus moves to the surface its pane now shows,
      // or (the pane is gone) to the leftmost pane.
      const survivor = findPaneById(root, pane.id)
      const activeSessionId =
        tab.activeSessionId === sessionId
          ? (survivor?.activeSessionId ?? firstSessionId(root))
          : tab.activeSessionId
      return {
        ...dropped,
        // The surface revealed in its place is now being looked at.
        sessions: markSeen(dropped.sessions, activeSessionId),
        tabs: replaceTab(state.tabs, tabId, (t) => ({ ...t, root, activeSessionId })),
      }
    }),

  closePane: (tabId, paneId) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      const pane = tab && findPaneById(tab.root, paneId)
      if (!tab || !pane) return { closePaneConfirm: null }
      const dropped = dropSessions(state, pane.sessionIds)
      const root = removePane(tab.root, paneId)
      if (root === null) return { ...dropped, ...withoutTab(state, tabId), closePaneConfirm: null }
      const activeSessionId = pane.sessionIds.includes(tab.activeSessionId)
        ? firstSessionId(root)
        : tab.activeSessionId
      return {
        ...dropped,
        sessions: markSeen(dropped.sessions, activeSessionId),
        closePaneConfirm: null,
        tabs: replaceTab(state.tabs, tabId, (t) => ({ ...t, root, activeSessionId })),
      }
    }),

  requestClosePane: (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    const pane = tab && findPaneById(tab.root, paneId)
    if (!pane) return
    if (pane.sessionIds.length > 1) {
      set({ closePaneConfirm: { tabId, paneId, count: pane.sessionIds.length } })
    } else {
      get().closePane(tabId, paneId)
    }
  },

  cancelClosePane: () => set({ closePaneConfirm: null }),

  setDragging: (dragging) => set({ dragging }),

  // Branch/PR poll results. Panes that were polled but came back empty (left the repo) are
  // cleared; unchanged results keep the same map (no re-render).
  setPaneGit: (fresh, polled) =>
    set((state) => {
      // Drop results for terminals that closed while the poll was in flight (else they'd
      // be re-added after dropSessions cleared them, and never removed).
      const live: typeof fresh = {}
      for (const [id, info] of Object.entries(fresh))
        if (state.sessions[paneOfGitKey(id)]) live[id] = info
      let next = mergePaneGit(state.paneGit, live)
      for (const id of polled) {
        if (id in live || !(id in next)) continue
        if (next === state.paneGit) next = { ...next }
        delete next[id]
      }
      return next === state.paneGit ? {} : { paneGit: next }
    }),

  setResume: (sessionId, st) =>
    set((state) => {
      if (st && !state.sessions[sessionId]) return {}
      if (!st && !(sessionId in state.resume)) return {}
      const resume = { ...state.resume }
      if (st) resume[sessionId] = st
      else delete resume[sessionId]
      return { resume }
    }),

  // A Claude pane's /color + /rename from main (null = claude left the pane → no accent).
  setAgentMeta: (sessionId, meta) =>
    set((state) => {
      if (!state.sessions[sessionId]) return {} // the pane already closed
      const agentMeta = { ...state.agentMeta }
      if (meta) agentMeta[sessionId] = meta
      else if (sessionId in agentMeta) delete agentMeta[sessionId]
      else return {}
      return { agentMeta }
    }),

  // Drop a dragged surface: the terminal keeps its session (re-attaches, no respawn),
  // becomes visible where it lands and takes focus.
  moveSurface: (tabId, sessionId, target) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      // Stale drop (the surface or target pane went away mid-drag): just end the drag.
      if (!tab || !findPane(tab.root, sessionId) || !findPaneById(tab.root, target.paneId)) {
        return { dragging: null }
      }
      const root = moveSurface(tab.root, sessionId, target, { splitId: newId(), paneId: newId() })
      return {
        dragging: null,
        tabs: replaceTab(state.tabs, tabId, (t) =>
          root === t.root && t.activeSessionId === sessionId
            ? t
            : { ...t, root, activeSessionId: sessionId },
        ),
        sessions: markSeen(state.sessions, sessionId),
      }
    }),

  setActivePane: (tabId, sessionId) =>
    set((state) => ({
      tabs: replaceTab(state.tabs, tabId, (t) => focusIn(t, sessionId)),
      // Focusing a pane = you've seen it: clear its attention/unread/reason.
      sessions: markSeen(state.sessions, sessionId),
    })),

  // The terminal itself gained focus (click/keyboard) — make its pane active. This is
  // the authoritative focus signal: a click handler on the pane container misses clicks
  // inside a terminal that has mouse-tracking on (agent TUIs), because xterm's selection
  // service stopPropagation()s those mousedowns. Derives the tab from the session.
  focusSession: (sessionId) =>
    set((state) => {
      const tab = state.tabs.find((t) => allSessionIds(t.root).includes(sessionId))
      if (!tab) return {}
      return {
        activeTabId: tab.id,
        tabs: replaceTab(state.tabs, tab.id, (t) => focusIn(t, sessionId)),
        sessions: markSeen(state.sessions, sessionId),
      }
    }),

  setWindowFocused: (focused) => {
    set({ windowFocused: focused })
    const { activeTabId, revealTab } = get()
    if (focused && activeTabId) revealTab(activeTabId)
  },

  setSystemDark: (systemDark) => set({ systemDark }),

  signalSession: (sessionId, ev) =>
    set((state) => {
      const session = state.sessions[sessionId]
      if (!session) return {}
      const next = reduceSignals(
        { status: session.status, unread: session.unread, running: session.running },
        ev,
        isVisibleIn(state, sessionId),
      )
      // The attention reason (OSC-9 message / "needs input"); cleared otherwise.
      const detail =
        next.status === "attention"
          ? ev.type === "attention"
            ? ev.detail || "needs input"
            : "needs input"
          : undefined
      if (
        next.status === session.status &&
        next.unread === session.unread &&
        next.running === session.running &&
        detail === session.detail
      ) {
        return {}
      }
      return { sessions: { ...state.sessions, [sessionId]: { ...session, ...next, detail } } }
    }),

  revealTab: (tabId) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      if (!tab) return {}
      const sessions = { ...state.sessions }
      let changed = false
      // Only what's actually on screen — a surface hidden behind another in its pane
      // hasn't been seen, so it keeps its attention.
      for (const id of visibleSessionIds(tab.root)) {
        const s = sessions[id]
        if (!s) continue
        const status = s.status === "attention" ? (s.running ? "working" : "idle") : s.status
        if (s.unread || status !== s.status || s.detail) {
          sessions[id] = { ...s, status, unread: false, detail: undefined }
          changed = true
        }
      }
      return changed ? { sessions } : {}
    }),
}))
