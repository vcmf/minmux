import { create } from "zustand"
import { moveTo } from "./lib/tab-order"
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
import { hostShellOption, sameHosts } from "./lib/ssh-hosts-ui"
import { pushRecent, toggleHidden, togglePinned } from "./lib/ssh-host-list"
import { declineIntegration, integrationOn, setIntegration, undecided } from "./lib/ssh-integration"
import { reopenFor, type ReopenCwd } from "./lib/remote-reports"
import { DEFAULT_HIDDEN_HOSTS } from "./lib/ssh-validate"
import type { RemotePhase } from "./lib/remote-connect"
import { reduceSignals } from "./lib/session-status"
import type { SignalEvent } from "./lib/session-status"
import { inGitKey, paneOfGitKey } from "./lib/agent-dirs"
import { reduceAgentEvent, emptyGraph, dropPaneSessions, claudePaneIds } from "./lib/agent-graph"
import {
  tabCloseConfirm,
  terminalCloseConfirm,
  type CloseConfirm,
  type TerminalState,
  confirmStillValid,
} from "./lib/close-confirm"
import { tabTitle, displaySessionTitle } from "./lib/session-label"
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

function makeSession(shell: ShellOption, initialCwd?: string, reopen?: ReopenCwd): Session {
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
    ...(shell.remote && reopen ? { reopenCwd: reopen } : {}),
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

interface AppState {
  sessions: Record<string, Session>
  tabs: Tab[]
  activeTabId: string | null
  shells: ShellOption[]
  sshHosts: SshHost[] // saved ssh hosts (main's list, refreshed when ~/.ssh/config changes)
  remotePhase: Record<string, RemotePhase> // ssh panes started here: where each connection is
  remoteDetail: Record<string, string> // with it: the prompt ("password") or failure kind
  sshHostsLoaded: boolean // main has answered once (before that, "no hosts" isn't known)
  windowFocused: boolean
  systemDark: boolean // OS prefers a dark colour scheme (drives appearance: "system")
  settings: Settings
  settingsOpen: boolean
  paletteOpen: boolean
  hostPickerOpen: boolean // the "Connect to host" picker
  // The one-line "open splits in the same folder?" hint, on the split that prompted it
  // (runtime only). `on` = just turned on: it says when it takes effect.
  integrationHint: { sessionId: string; alias: string; state: "ask" | "on" } | null
  hintDismissed: string[] // aliases whose hint was closed this run ("not now")
  answerIntegrationHint: (choice: "on" | "never" | "dismiss") => void
  sshRecent: string[] // hostIds, newest first (a convenience: localStorage, last writer wins)
  searchOpen: boolean
  rightView: RightView // which view the single right-side panel shows (null = hidden)
  rightPanelWidth: number // px width of the right panel (drag-resizable, persisted)
  sidebarCollapsed: boolean
  git: GitStatus | null
  agents: AgentGraph // live tree of Claude agents/sub-agents (M6, fed by hook events)
  home: string
  platform: string // process.platform ("darwin"|"win32"|"linux"); "" until fetched
  profile: string // a non-default profile's name ("dev"), shown by the brand; "" otherwise
  editor: EditorInfo | null // configured editor availability (file context menu)
  // file open in the preview popup (null = closed); wsl = the pane's distro so a WSL path
  // is read via its UNC share (captured at open time — the active pane may change after).
  preview: { abs: string; name: string; wsl?: WslContext } | null
  paneRoot: Record<string, string> // per-session Files-panel root override (absent = follow cwd)
  closeConfirm: CloseConfirm | null // a close awaiting the "are you sure?" dialog (lib/close-confirm)
  dragging: { tabId: string; sessionId: string } | null // surface being dragged (drop hints on)
  agentMeta: Record<string, SessionMeta> // per pane: the Claude session's /color + /rename
  paneGit: Record<string, PaneGitInfo> // per terminal: branch + GitHub PR (sidebar)
  resume: Record<string, ResumeState> // per terminal: Claude-session resume banner

  setHome: (home: string) => void
  setPlatform: (platform: string) => void
  setProfile: (profile: string) => void
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
  // undefined = unknown again; verified = reported by our integrated shell (nonce-checked), by
  // `host`. A verified folder replaces the one to reopen (it's where the shell really is now).
  setRemoteCwd: (
    sessionId: string,
    cwd: string | undefined,
    verified?: boolean,
    host?: string,
  ) => void
  setReopenCwd: (sessionId: string, reopen: ReopenCwd | undefined) => void // next connection's folder
  setPaletteOpen: (open: boolean) => void
  setHostPickerOpen: (open: boolean) => void
  /** Open a host: a new tab, or a split of the active pane. Remembered as recent. */
  openHost: (host: SshHost, how: "tab" | "row" | "column") => void
  toggleHostPinned: (hostId: string) => void // settings.ssh.pinned
  setHostHidden: (alias: string, hide: boolean) => void // settings.ssh.hidden
  toggleHostIntegration: (alias: string) => void // settings.ssh.integration
  setSearchOpen: (open: boolean) => void
  setSidebarCollapsed: (collapsed: boolean) => void
  setSettingsOpen: (open: boolean) => void
  setSettings: (settings: Settings) => void
  updateSettings: (next: Settings) => void // validate + apply + persist (every UI entry point)
  settingsLoaded: boolean // settings.json read at least once (gates theming + first spawns)
  setShells: (shells: ShellOption[]) => void
  setSshHosts: (hosts: SshHost[]) => void
  setRemotePhase: (sessionId: string, phase: RemotePhase, detail?: string) => void
  restoreWorkspace: (ws: WorkspaceState, livePtys?: string[]) => void
  setRightPanelWidth: (px: number, maxAvail?: number) => void
  newTab: (shell: ShellOption) => void
  splitWith: (direction: "row" | "column", shell: ShellOption) => void // a new tab if none
  closeTab: (tabId: string) => void
  moveTab: (tabId: string, insertAt: number) => void // reorder (drag & drop; lands before insertAt)
  moveActiveTab: (delta: -1 | 1) => void // ⌘K "Move session left/right"
  setActiveTab: (tabId: string) => void
  renameTab: (tabId: string, title: string) => void
  splitActive: (direction: "row" | "column", fallback?: ShellOption) => void
  openFolderInSplit: (cwd: string, paneId?: string) => void // split active pane at cwd; shell from paneId
  splitPaneAt: (paneId: string, cwd: string) => void // split beside that pane (its shell); not "seen"
  newSurface: (fallback?: ShellOption) => void // new terminal tab in the focused pane
  closeSurface: (tabId: string, sessionId: string) => void // one terminal; last one closes the pane
  closePane: (tabId: string, paneId: string) => void // the pane with all its terminals
  requestClosePane: (tabId: string, paneId: string) => void // confirms first if several terminals
  requestCloseTab: (tabId: string) => void // confirms first: >1 terminals, or its one is running
  requestCloseTerminal: (tabId: string, sessionId: string) => void // confirms first if running
  confirmClose: () => void // the dialog's Close
  cancelClose: () => void
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

/** A close's state update + dropping a pending confirm whose target it just removed. */
const closing =
  (fn: (state: AppState) => Partial<AppState>) =>
  (state: AppState): Partial<AppState> => {
    const next = fn(state)
    const c = state.closeConfirm
    if (!c || !next.tabs || confirmStillValid(c, next.tabs)) return next
    return { ...next, closeConfirm: null }
  }

/** What closing needs to know about terminals: running a command, or a live Claude. */
function terminalStates(state: AppState, ids: string[]): TerminalState[] {
  const claude = claudePaneIds(state.agents)
  return ids.map((id) => ({
    id,
    running: !!state.sessions[id]?.running,
    claude: claude.includes(id),
  }))
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
  opts: { shell: ShellOption; cwd?: string; direction: "row" | "column"; reopen?: ReopenCwd },
): Partial<AppState> {
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  if (!tab) return {}
  const session = makeSession(opts.shell, opts.cwd, opts.reopen)
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

/** Whether a hint for `alias` still has a question to ask: ask mode, and no entry decides it. */
export const hintStillAsks = (
  alias: string,
  ssh: { integrationMode: string; integration: string[] },
): boolean => ssh.integrationMode === "ask" && undecided(alias, ssh.integration)

/** A split of an ssh pane on a host you never chose for (ask mode): offer shell integration on
 *  the new pane, once per host per run — it's what makes a split open in the same folder. */
function hintFor(state: AppState, shell: ShellOption, next: Partial<AppState>): Partial<AppState> {
  const alias = shell.remote?.label
  const ssh = state.settings.ssh
  const tab = next.tabs?.find((t) => t.id === state.activeTabId)
  if (!alias || !tab || ssh.integrationMode !== "ask") return {}
  if (!undecided(alias, ssh.integration) || state.hintDismissed.includes(alias)) return {}
  // Already offered on a split of this host: it stays there (moving it would resize that pane
  // under whatever now runs in it).
  if (state.integrationHint?.alias === alias && state.sessions[state.integrationHint.sessionId]) {
    return {}
  }
  return { integrationHint: { sessionId: tab.activeSessionId, alias, state: "ask" } }
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
): Pick<
  AppState,
  | "sessions"
  | "paneRoot"
  | "agentMeta"
  | "paneGit"
  | "resume"
  | "remotePhase"
  | "remoteDetail"
  | "integrationHint"
> {
  const sessions = { ...state.sessions }
  const paneRoot = { ...state.paneRoot }
  const agentMeta = { ...state.agentMeta }
  const paneGit = { ...state.paneGit }
  const resume = { ...state.resume }
  const remotePhase = { ...state.remotePhase }
  const remoteDetail = { ...state.remoteDetail }
  for (const id of ids) {
    delete remotePhase[id]
    delete remoteDetail[id]
    delete resume[id]
    delete paneGit[id]
    delete paneGit[inGitKey(id)] // …and its Claude `in` folder's
    delete sessions[id]
    delete paneRoot[id] // don't leak the pane's root override
    delete agentMeta[id] // …or its Claude accent
  }
  // The hint goes with the pane it was on (closing it isn't an answer: a later split asks again).
  const hint = state.integrationHint
  const integrationHint = hint && ids.includes(hint.sessionId) ? null : hint
  return {
    sessions,
    paneRoot,
    agentMeta,
    paneGit,
    resume,
    remotePhase,
    remoteDetail,
    integrationHint,
  }
}

/** Remove a tab; if it was active, the last remaining tab takes over. */
function withoutTab(state: AppState, tabId: string): Pick<AppState, "tabs" | "activeTabId"> {
  const tabs = state.tabs.filter((t) => t.id !== tabId)
  const activeTabId =
    state.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : state.activeTabId
  return { tabs, activeTabId }
}

const RECENT_KEY = "smterm.ssh.recent"

// Recent hosts are a convenience: storage can be missing or throw (private mode, tests).
function readRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]")
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 10) : []
  } catch {
    return []
  }
}
function writeRecent(ids: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids))
  } catch {
    // not remembered: fine
  }
}

export const useStore = create<AppState>((set, get) => ({
  sessions: {},
  tabs: [],
  activeTabId: null,
  shells: [],
  sshHosts: [],
  sshHostsLoaded: false,
  remotePhase: {},
  remoteDetail: {},
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
  hostPickerOpen: false,
  integrationHint: null,
  hintDismissed: [],
  sshRecent: readRecent(),
  searchOpen: false,
  rightView: null,
  rightPanelWidth: RIGHT_PANEL_DEFAULT,
  sidebarCollapsed: false,
  git: null,
  agents: emptyGraph,
  home: "",
  platform: "",
  profile: "",
  editor: null,
  preview: null,
  paneRoot: {},
  closeConfirm: null,
  dragging: null,
  agentMeta: {},
  paneGit: {},
  resume: {},

  setHome: (home) => set({ home }),
  setPlatform: (platform) => set({ platform }),
  setProfile: (profile) => set({ profile }),
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
  // Display only: local panels read `cwd`, which a remote session never has.
  setRemoteCwd: (sessionId, cwd, verified = false, host) =>
    set((state) => {
      const s = state.sessions[sessionId]
      const ok = verified && cwd !== undefined && !!host
      if (!s?.remote) return state
      // Any report of where the shell is replaces the folder to reopen: the shell is elsewhere
      // now (a plain connection's own OSC 7 too), or went somewhere we won't reopen.
      const reported = cwd !== undefined || verified
      const same =
        s.remoteCwd === cwd &&
        !!s.remoteCwdVerified === ok &&
        s.remoteCwdHost === (ok ? host : undefined) &&
        !(reported && s.reopenCwd)
      if (same) return state
      const next: Session = { ...s, remoteCwd: cwd, remoteCwdVerified: ok, remoteCwdHost: host }
      if (cwd === undefined) delete next.remoteCwd
      if (!ok) {
        delete next.remoteCwdVerified
        delete next.remoteCwdHost
      }
      if (reported) delete next.reopenCwd
      return { sessions: { ...state.sessions, [sessionId]: next } }
    }),
  setReopenCwd: (sessionId, reopen) =>
    set((state) => {
      const s = state.sessions[sessionId]
      if (!s?.remote || JSON.stringify(s.reopenCwd) === JSON.stringify(reopen)) return state
      const next: Session = { ...s, reopenCwd: reopen }
      if (!reopen) delete next.reopenCwd
      return { sessions: { ...state.sessions, [sessionId]: next } }
    }),
  // One overlay at a time: opening either closes the other (⌘K over an open picker).
  setPaletteOpen: (paletteOpen) =>
    set(paletteOpen ? { paletteOpen, hostPickerOpen: false } : { paletteOpen }),
  setHostPickerOpen: (hostPickerOpen) =>
    set(hostPickerOpen ? { hostPickerOpen, paletteOpen: false } : { hostPickerOpen }),
  openHost: (host, how) => {
    if (host.hidden) return // listed only so it can be shown again
    const shell = hostShellOption(host)
    if (how === "tab") get().newTab(shell)
    else get().splitWith(how, shell)
    const sshRecent = pushRecent(get().sshRecent, host.hostId)
    set({ sshRecent })
    writeRecent(sshRecent)
  },
  toggleHostPinned: (hostId) => {
    const st = get()
    const ssh = st.settings.ssh
    st.updateSettings({ ...st.settings, ssh: { ...ssh, pinned: togglePinned(ssh.pinned, hostId) } })
  },
  toggleHostIntegration: (alias) => {
    const st = get()
    const ssh = st.settings.ssh
    const on = !integrationOn(alias, ssh.integration, ssh.integrationMode)
    st.updateSettings({
      ...st.settings,
      ssh: {
        ...ssh,
        integration: setIntegration(ssh.integration, alias, on, ssh.integrationMode),
      },
    })
  },
  answerIntegrationHint: (choice) => {
    const st = get()
    const hint = st.integrationHint
    if (!hint) return
    const ssh = st.settings.ssh
    // Decided meanwhile (the host menu, Settings): nothing left to ask; never write behind it.
    const stale = hint.state === "ask" && !hintStillAsks(hint.alias, ssh)
    if (choice === "dismiss" || stale) {
      return set({
        integrationHint: null,
        hintDismissed: [...st.hintDismissed.filter((a) => a !== hint.alias), hint.alias],
      })
    }
    const integration =
      choice === "on"
        ? setIntegration(ssh.integration, hint.alias, true, ssh.integrationMode)
        : declineIntegration(ssh.integration, hint.alias)
    st.updateSettings({ ...st.settings, ssh: { ...ssh, integration } })
    set({ integrationHint: choice === "on" ? { ...hint, state: "on" } : null })
  },
  setHostHidden: (alias, hide) => {
    const st = get()
    const ssh = st.settings.ssh
    const isDefault = DEFAULT_HIDDEN_HOSTS.some((a) => a.toLowerCase() === alias.toLowerCase())
    st.updateSettings({
      ...st.settings,
      ssh: {
        ...ssh,
        hidden: toggleHidden(ssh.hidden, alias, hide),
        // Showing a default-hidden git host is recorded as "shown"; hiding it again undoes that.
        shown:
          isDefault && !hide
            ? toggleHidden(ssh.shown, alias, true)
            : toggleHidden(ssh.shown, alias, false),
      },
    })
  },
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
  // Unchanged, or the session is gone (a late answer after a close) → the same state.
  setRemotePhase: (sessionId, phase, detail) =>
    set((state) => {
      if (!state.sessions[sessionId]) return state
      const samePhase = state.remotePhase[sessionId] === phase
      const sameDetail = state.remoteDetail[sessionId] === detail
      if (samePhase && sameDetail) return state
      let remoteDetail = state.remoteDetail
      if (!sameDetail) {
        remoteDetail = { ...state.remoteDetail }
        if (detail === undefined) delete remoteDetail[sessionId]
        else remoteDetail[sessionId] = detail
      }
      return {
        remotePhase: samePhase ? state.remotePhase : { ...state.remotePhase, [sessionId]: phase },
        remoteDetail,
      }
    }),

  // Unchanged → the same state object, so nothing is notified.
  setSshHosts: (hosts) =>
    set((state) =>
      state.sshHostsLoaded && sameHosts(state.sshHosts, hosts)
        ? state
        : { sshHosts: hosts, sshHostsLoaded: true },
    ),

  restoreWorkspace: (ws, livePtys = []) =>
    set({
      // Marked so a restored ssh pane can follow `ssh.restore` (terminal-manager) — unless its
      // ssh is still live in main (a renderer reload): that one isn't waiting for anything.
      sessions: Object.fromEntries(
        Object.entries(ws.sessions).map(([id, s]) => [
          id,
          s.remote && !livePtys.includes(id) ? { ...s, restored: true } : s,
        ]),
      ),
      remotePhase: {},
      remoteDetail: {},
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
    set(
      closing((state) => {
        const tab = state.tabs.find((t) => t.id === tabId)
        if (!tab) return {}
        return { ...dropSessions(state, allSessionIds(tab.root)), ...withoutTab(state, tabId) }
      }),
    ),

  moveTab: (tabId, insertAt) =>
    set((state) => {
      const tabs = moveTo(state.tabs, tabId, insertAt)
      return tabs === state.tabs ? {} : { tabs }
    }),

  moveActiveTab: (delta) => {
    const { tabs, activeTabId } = get()
    const i = tabs.findIndex((t) => t.id === activeTabId)
    if (i < 0) return
    // insertAt is "before the item now at": one step right = past the next item.
    get().moveTab(tabs[i]!.id, delta < 0 ? i - 1 : i + 2)
  },

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
      // An ssh pane's split opens where it verifiably is (its host's shell integration).
      const reopen = shell.remote ? reopenFor(src) : undefined
      const next = splitActivePane(state, { shell, cwd: src?.cwd, direction, reopen })
      return { ...next, ...hintFor(state, shell, next) }
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
      const session = makeSession(shell, src?.cwd, shell.remote ? reopenFor(src) : undefined)
      const root = addSurface(tab.root, pane.id, session.id)
      const next = {
        sessions: { ...state.sessions, [session.id]: session },
        tabs: replaceTab(state.tabs, tab.id, (t) => ({ ...t, root, activeSessionId: session.id })),
      }
      return { ...next, ...hintFor(state, shell, next) }
    }),

  closeSurface: (tabId, sessionId) =>
    set(
      closing((state) => {
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
    ),

  closePane: (tabId, paneId) =>
    set(
      closing((state) => {
        const tab = state.tabs.find((t) => t.id === tabId)
        const pane = tab && findPaneById(tab.root, paneId)
        if (!tab || !pane) return {}
        const dropped = dropSessions(state, pane.sessionIds)
        const root = removePane(tab.root, paneId)
        if (root === null) return { ...dropped, ...withoutTab(state, tabId) }
        const activeSessionId = pane.sessionIds.includes(tab.activeSessionId)
          ? firstSessionId(root)
          : tab.activeSessionId
        return {
          ...dropped,
          sessions: markSeen(dropped.sessions, activeSessionId),
          tabs: replaceTab(state.tabs, tabId, (t) => ({ ...t, root, activeSessionId })),
        }
      }),
    ),

  requestClosePane: (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    const pane = tab && findPaneById(tab.root, paneId)
    if (!pane) return
    if (pane.sessionIds.length > 1) {
      set({ closeConfirm: { kind: "pane", tabId, paneId, count: pane.sessionIds.length } })
    } else {
      // One terminal: the terminal rule (asks while it runs a command or Claude).
      get().requestCloseTerminal(tabId, pane.sessionIds[0]!)
    }
  },

  requestCloseTab: (tabId) => {
    const s = get()
    const tab = s.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const title = tabTitle(tab, s.sessions, s.home)
    const ask = tabCloseConfirm(tabId, title, terminalStates(s, allSessionIds(tab.root)))
    if (ask) set({ closeConfirm: ask })
    else s.closeTab(tabId)
  },

  requestCloseTerminal: (tabId, sessionId) => {
    const s = get()
    const session = s.sessions[sessionId]
    const [t] = terminalStates(s, [sessionId])
    if (!session || !t) return
    const ask = terminalCloseConfirm(tabId, displaySessionTitle(session, s.home), t)
    if (ask) set({ closeConfirm: ask })
    else s.closeSurface(tabId, sessionId)
  },

  confirmClose: () => {
    const c = get().closeConfirm
    set({ closeConfirm: null })
    if (!c) return
    if (c.kind === "pane") get().closePane(c.tabId, c.paneId)
    else if (c.kind === "tab") get().closeTab(c.tabId)
    else get().closeSurface(c.tabId, c.sessionId)
  },

  cancelClose: () => set({ closeConfirm: null }),

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
