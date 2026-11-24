import { create } from "zustand"
import { moveTo } from "./lib/tab-order"
import { moveTerminal as moveTerminalPure, type GroupDrop } from "./lib/group-move"
import type { Session, ShellOption, SshHost, Tab } from "./types"
import type { PrRef } from "./lib/pr-detail"
import {
  addSurface,
  allEntryIds,
  allSessionIds,
  findPane,
  findPaneById,
  firstEntryId,
  makeLeaf,
  moveSurface,
  paneSessionIds,
  removeNode,
  removePane,
  splitNode,
  visibleSessionIds,
} from "./lib/pane-tree"
import { makeTab, withFocus } from "./lib/tab-focus"
import { files, type FileView } from "./lib/file-store"
import {
  EMPTY_VIEW,
  isMarkdownPath,
  objectId,
  placeOf,
  viewOf,
  type FileEntry,
  type FolderEntry,
  type FolderView,
  type ObjectEntry,
} from "./lib/folder-entries"
import { isTerminalEntry } from "./lib/entries"
import { inheritShell, resolveDefaultShell } from "./lib/shells"
import { hostShellOption, sameHosts } from "./lib/ssh-hosts-ui"
import { pushRecent, toggleHidden, togglePinned } from "./lib/ssh-host-list"
import { declineIntegration, integrationOn, setIntegration, undecided } from "./lib/ssh-integration"
import { reopenFor, type ReopenCwd } from "./lib/remote-reports"
import { DEFAULT_HIDDEN_HOSTS } from "./lib/ssh-validate"
import type { RemotePhase } from "./lib/remote-connect"
import { reduceSignals } from "./lib/session-status"
import type { SignalEvent } from "./lib/session-status"
import { gitKey, paneOfGitKey } from "./lib/agent-dirs"
import {
  addWork,
  forgetRoot,
  keepDirRoots,
  setDirRoots as withDirRoots,
  settleAllWork,
  workPane,
  type DirRoot,
  type PaneWork,
} from "./lib/agent-work"
import {
  reduceAgentEvent,
  emptyGraph,
  dropPaneSessions,
  agentByPane,
  type AgentKind,
} from "./lib/agent-graph"
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
import type { EditorInfo } from "./lib/file-actions"
import { normalizeRootPath } from "./lib/breadcrumb"
import { wslContext, type WslContext } from "./lib/wsl"
import type { WorkspaceState } from "./lib/workspace"
import type { MoveTarget } from "./lib/pane-tree"
import type { SessionMeta } from "./lib/session-color"
import { mergePaneGit, type PaneGitInfo } from "./lib/pane-git"
import { isPosixShell, type ResumePlan, type ResumeState } from "./lib/resume"
import { clampPanelWidth, RIGHT_PANEL_DEFAULT } from "./lib/right-panel"

const newId = () => crypto.randomUUID()
let workSeq = 0 // orders agents' work events (which folder was worked in last)

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

// The inherited shell, else the default, else the first such one. A WSL shell would start in
// `~`: main can't hand a host path to `wsl --cd`.
/** A shell on this machine's own filesystem (not ssh, not WSL), for a host folder. */
function hostShellFor(state: AppState, src: Session | undefined): ShellOption | undefined {
  const ok = (s: ShellOption | undefined) => !!s && !s.remote && !wslContext(s.command, s.args)
  const inherited = inheritShell(state.shells, src)
  if (ok(inherited)) return inherited
  const def = resolveDefaultShell(state.shells, state.settings.defaultShell)
  if (ok(def)) return def
  return state.shells.find(ok) ?? def
}

/** A host shell (not ssh, not WSL), or none: for a host folder that mustn't open elsewhere. */
function hostOnlyShellFor(state: AppState, src: Session | undefined): ShellOption | undefined {
  const s = hostShellFor(state, src)
  return s && !s.remote && !wslContext(s.command, s.args) ? s : undefined
}

// A WSL folder isn't used: a new tab takes the shell it's given, which may not be WSL.
/** Where new tabs open: the focused folder entry's path, else the tab's terminal's cwd. */
function focusedCwd(state: AppState): string | undefined {
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  const o = tab ? state.objects[tab.activeEntryId] : undefined
  const folder = o && placeOf(o)
  if (folder && !folder.wsl) return folder.path
  const sid = tab?.activeSessionId
  return sid ? state.sessions[sid]?.cwd : undefined
}

/** The folder `tab`'s focus stands in, when it's a folder or file entry. */
function focusedFolder(state: AppState, tab: Tab): { path: string; wsl?: WslContext } | undefined {
  const o = state.objects[tab.activeEntryId]
  return o && placeOf(o)
}

/** A WSL shell for `distro` (undefined: the default one): the inherited one if it matches. */
function wslShellFor(
  state: AppState,
  src: Session | undefined,
  distro: string | undefined,
): ShellOption | undefined {
  const ok = (s: ShellOption | undefined) => {
    const w = s && !s.remote ? wslContext(s.command, s.args) : undefined
    return !!w && w.distro === distro
  }
  const inherited = inheritShell(state.shells, src)
  return ok(inherited) ? inherited : state.shells.find(ok)
}

/** The shell a terminal opened in folder `f` runs: a WSL one for its distro, else a host one. */
const folderShell = (state: AppState, src: Session | undefined, f: { wsl?: WslContext }) =>
  f.wsl ? wslShellFor(state, src, f.wsl.distro) : hostShellFor(state, src)

/** Whether a terminal can open in folder entry `id` (its "New terminal here"). */
export const canOpenTerminalIn = (state: AppState, id: string): boolean => {
  const o = state.objects[id]
  if (!o) return false
  const f = placeOf(o)
  // The same shells the action would find: its tab's terminal's included.
  const tab = state.tabs.find((t) => !!findPane(t.root, id))
  return !!folderShell(state, tab ? state.sessions[tab.activeSessionId] : undefined, f)
}

// A focused folder's: a host shell, or a WSL one for its distro. A WSL folder no shell opens:
// a terminal like the tab's own, where it is (not an ssh one). No folder focused: the tab's
// terminal's own shell and folder.
/** The shell and folder a new terminal of `tab` starts with; undefined: none can. */
function newTerminalSource(
  state: AppState,
  tab: Tab,
  fallback: ShellOption | undefined,
): { shell: ShellOption; cwd: string | undefined; src: Session | undefined } | undefined {
  const src = state.sessions[tab.activeSessionId]
  const folder = focusedFolder(state, tab)
  if (folder) {
    const shell = folderShell(state, src, folder) ?? (folder.wsl ? undefined : fallback)
    if (shell) return { shell, cwd: folder.path, src }
    // A WSL folder no shell opens: a terminal like the tab's own, where that one is (an ssh
    // one isn't copied: the folder is on this machine), so ⌘T / ⌘D / + still do something.
    if (src?.remote) return fallback ? { shell: fallback, cwd: undefined, src } : undefined
  }
  const shell = inheritShell(state.shells, src) ?? fallback
  return shell ? { shell, cwd: src?.cwd, src } : undefined
}

/** The right-side panel's view (null = hidden): the agents list, from its top-bar icon. */
export type RightView = "agents" | null

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
  prDialogOpen: boolean // the pull requests dialog
  prLink: (PrRef & { at: number; pane?: string }) | null // a PR link clicked (in `pane`)
  ghMissing: boolean // gh isn't installed (as far as the dialog knows): its button is muted
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
  folderGit: Record<string, GitStatus> // folder entries' other repos, by repoKey (lib/folder-git)
  folderRoots: Record<string, string | null> // each shown folder's repo root, by wantKey
  agents: AgentGraph // live tree of agents/sub-agents (M6, fed by hook events)
  home: string
  platform: string // process.platform ("darwin"|"win32"|"linux"); "" until fetched
  profile: string // a non-default profile's name ("dev"), shown by the brand; "" otherwise
  editor: EditorInfo | null // configured editor availability (file context menu)
  preview: { abs: string; name: string } | null // the file in the preview popup (null = closed)
  objects: Record<string, ObjectEntry> // pane entries that aren't terminals, by `obj-` id
  folderViews: Record<string, FolderView> // per folder entry: what its view has open
  closeConfirm: CloseConfirm | null // a close awaiting the "are you sure?" dialog (lib/close-confirm)
  dragging: { tabId: string; sessionId: string } | null // surface being dragged (drop hints on)
  agentMeta: Record<string, SessionMeta> // per pane: the agent session's /color + /rename
  paneGit: Record<string, PaneGitInfo> // per terminal: branch + GitHub PR (sidebar)
  paneWork: Record<string, PaneWork> // per terminal: the folders its agent worked in (`edits`)
  dirRoots: Record<string, DirRoot> // folder → its checkout root, from lookups (all panes)
  resume: Record<string, ResumeState> // per terminal: agent-session resume banner
  // per terminal: the "approve minmux's hooks" hint for the agent launched there (Codex)
  agentHint: Record<string, { kind: AgentKind; dismissals: number }>

  setHome: (home: string) => void
  setPlatform: (platform: string) => void
  setProfile: (profile: string) => void
  setEditor: (editor: EditorInfo) => void
  setPreview: (preview: { abs: string; name: string } | null) => void
  /** Open a folder as a new tab of a pane (default: the active tab's focused pane), focused. */
  openFolder: (path: string, opts?: { tabId?: string; paneId?: string; wsl?: WslContext }) => void
  // Default: the active tab's focused pane. A peek replaces the pane's peek; a file already open
  // there is focused (at `line`) instead.
  /** Open a file as a tab of a pane, focused. */
  openFile: (
    path: string,
    opts?: {
      tabId?: string
      paneId?: string
      wsl?: WslContext
      line?: number
      peek?: boolean
      diff?: boolean // open on its diff (a changed file from the changes list)
      anchor?: string // a markdown heading to open at (a link in a rendered file)
    },
  ) => void
  setFileView: (id: string, view: FileView) => void
  keepEntry: (id: string) => void // a peek becomes a kept tab (double-click, drag)
  setFolderView: (id: string, view: FolderView) => void
  setFolderRoot: (id: string, path: string) => void // re-root a folder entry (double-click)
  requestCloseEntry: (tabId: string, entryId: string) => void // a terminal asks; a folder closes
  setSessionOscTitle: (sessionId: string, title: string) => void
  setGit: (git: GitStatus | null) => void
  setFolderGit: (key: string, git: GitStatus | null) => void // null drops it
  setFolderRoots: (roots: Record<string, string | null>) => void
  applyAgentEvents: (events: AgentEvent[]) => void
  agentExited: (paneId: string) => void // the pane's shell prompt came back after its agent
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
  setPrDialogOpen: (open: boolean) => void
  openPrLink: (pr: PrRef, pane?: string) => void // opens the dialog on that PR
  setGhMissing: (missing: boolean) => void
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
  renameTab: (tabId: string, title: string) => void // trimmed; "" unpins (back to the live title)
  splitActive: (direction: "row" | "column", fallback?: ShellOption) => void
  // split active pane at cwd; shell from paneId (`host`: a host folder, never a WSL shell)
  openFolderInSplit: (cwd: string, paneId?: string, host?: boolean) => void
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
  /** Folder → root lookups (undefined: failed), and checkouts found gone (removed worktrees). */
  // `searched`: the answers are the `.git` search's (a failure there goes to git at once).
  setDirRoots: (
    answers: Record<string, string | null | undefined>,
    gone?: string[],
    searched?: boolean,
  ) => void
  setResume: (sessionId: string, state: ResumeState | null) => void
  resumeInSplit: (plan: ResumePlan) => string | undefined // split beside the focused pane, resume there
  setAgentHint: (sessionId: string, hint: { kind: AgentKind; dismissals: number } | null) => void
  moveSurface: (tabId: string, sessionId: string, target: MoveTarget) => void // drag & drop
  // Drag a terminal to another group, into one of its panes, or out into a new group.
  moveTerminal: (sessionId: string, drop: GroupDrop) => void
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

/** What closing needs to know about terminals: running a command, or a live agent. */
function terminalStates(state: AppState, ids: string[]): TerminalState[] {
  const agentIn = agentByPane(state.agents)
  return ids.map((id) => ({ id, running: !!state.sessions[id]?.running, agent: agentIn[id] }))
}

/** Whether the user is actively looking at this exact session: window focused +
 *  it's the active tab's focused pane. Per-pane, so the heuristic never nags (and
 *  we don't badge) the pane you're driving. */
export function isVisibleIn(state: AppState, sessionId: string): boolean {
  if (!state.windowFocused || !state.activeTabId) return false
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  return tab?.activeEntryId === sessionId
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

/** The active tab's focus when it's a terminal (keyboard, search, "the pane you're driving"). */
export function focusedTerminal(state: Pick<AppState, "tabs" | "activeTabId">): string | undefined {
  const id = state.tabs.find((t) => t.id === state.activeTabId)?.activeEntryId
  return id && isTerminalEntry(id) ? id : undefined
}

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
  // Beside the focused entry's pane.
  const root = splitNode(tab.root, tab.activeEntryId, opts.direction, session.id, newId(), newId())
  return {
    sessions: { ...state.sessions, [session.id]: session },
    tabs: state.tabs.map((t) => (t.id === tab.id ? withFocus(t, session.id, root) : t)),
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
  | "agentMeta"
  | "paneGit"
  | "paneWork"
  | "dirRoots"
  | "resume"
  | "agentHint"
  | "remotePhase"
  | "remoteDetail"
  | "integrationHint"
> {
  const sessions = { ...state.sessions }
  const agentMeta = { ...state.agentMeta }
  const paneGit = { ...state.paneGit }
  const paneWork = { ...state.paneWork }
  const resume = { ...state.resume }
  const agentHint = { ...state.agentHint }
  const remotePhase = { ...state.remotePhase }
  const remoteDetail = { ...state.remoteDetail }
  for (const id of ids) {
    delete remotePhase[id]
    delete remoteDetail[id]
    delete resume[id]
    delete agentHint[id]
    delete paneGit[id]
    delete paneGit[gitKey(id, "in")] // …and its agent's `in` folder's
    delete paneGit[gitKey(id, "edit")] // …and the checkout it edits in
    delete paneWork[id]
    delete sessions[id]
    delete agentMeta[id] // don't leak its Claude accent
  }
  // The hint goes with the pane it was on (closing it isn't an answer: a later split asks again).
  const hint = state.integrationHint
  const integrationHint = hint && ids.includes(hint.sessionId) ? null : hint
  return {
    sessions,
    agentMeta,
    paneGit,
    paneWork,
    dirRoots: keepDirRoots(state.dirRoots, paneWork), // the closed panes' folders go
    resume,
    agentHint,
    remotePhase,
    remoteDetail,
    integrationHint,
  }
}

/** Drop folder / file entries from the store maps (terminal ids are ignored). */
function dropObjects(state: AppState, ids: string[]): Pick<AppState, "objects" | "folderViews"> {
  const gone = ids.filter((id) => id in state.objects || id in state.folderViews)
  if (!gone.length) return { objects: state.objects, folderViews: state.folderViews }
  gone.forEach((id) => files.forget(id)) // a file tab's read and lines go with it
  const objects = { ...state.objects }
  const folderViews = { ...state.folderViews }
  for (const id of gone) {
    delete objects[id]
    delete folderViews[id]
  }
  return { objects, folderViews }
}

/** Remove a tab; if it was active, the last remaining tab takes over. */
function withoutTab(state: AppState, tabId: string): Pick<AppState, "tabs" | "activeTabId"> {
  const tabs = state.tabs.filter((t) => t.id !== tabId)
  const activeTabId =
    state.activeTabId === tabId ? (tabs[tabs.length - 1]?.id ?? null) : state.activeTabId
  return { tabs, activeTabId }
}

const RECENT_KEY = "minmux.ssh.recent"

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
  prDialogOpen: false,
  prLink: null,
  ghMissing: false,
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
  objects: {},
  folderViews: {},
  folderGit: {},
  folderRoots: {},
  closeConfirm: null,
  dragging: null,
  agentMeta: {},
  paneGit: {},
  paneWork: {},
  dirRoots: {},
  resume: {},
  agentHint: {},

  setHome: (home) => set({ home }),
  setPlatform: (platform) => set({ platform }),
  setProfile: (profile) => set({ profile }),
  setEditor: (editor) => set({ editor }),
  setPreview: (preview) => set({ preview }),
  openFile: (path, given = {}) =>
    set((state) => {
      // A heading is only a markdown file's; another file takes GitHub's `#L12` as its line.
      let opts = given
      if (opts.anchor && !isMarkdownPath(path)) {
        const n = /^L(\d+)/.exec(opts.anchor)
        opts = { ...opts, anchor: undefined, ...(n ? { line: Number(n[1]) } : {}) }
      }
      const tab = state.tabs.find((t) => t.id === (opts.tabId ?? state.activeTabId))
      if (!tab || !path) return {}
      const pane = opts.paneId
        ? findPaneById(tab.root, opts.paneId)
        : findPane(tab.root, tab.activeEntryId)
      if (!pane) return {}
      const line = opts.line && opts.line > 0 ? { line: opts.line } : {}
      // Already open in this pane: show it there (at the line asked for).
      // The same file: same distro (or both host), same path (any case on Windows).
      const key = (p: string) => (state.platform === "win32" && !opts.wsl ? p.toLowerCase() : p)
      const open = pane.entryIds.find((id) => {
        const o = state.objects[id]
        return (
          o?.kind === "file" &&
          o.wsl?.distro === opts.wsl?.distro &&
          !o.wsl === !opts.wsl &&
          key(o.path) === key(path)
        )
      })
      if (open) {
        const cur = state.objects[open] as FileEntry
        // At its line again, even the same one (scrolled away since): a new `seq` says "go".
        // The latest target only: a line drops the heading asked before, and the other way round.
        let next: FileEntry = cur
        if (opts.line) {
          next = { ...cur, line: opts.line, seq: (cur.seq ?? 0) + 1 }
          delete next.anchor
        } else if (opts.anchor) {
          next = { ...cur, anchor: opts.anchor, seq: (cur.seq ?? 0) + 1 }
          delete next.line
          delete next.view // a heading is the Preview's
        }
        if (opts.diff && cur.view !== "diff") next = { ...next, view: "diff" }
        else if (opts.line && !opts.diff && next.view === "diff") {
          next = { ...next } // a line is the text's: off the diff to show it
          delete next.view
        }
        const objects = next === cur ? state.objects : { ...state.objects, [open]: next }
        return {
          objects,
          tabs: replaceTab(state.tabs, tab.id, (t) => withFocus(t, open)),
          activeTabId: tab.id,
        }
      }
      const id = objectId(newId())
      const file: FileEntry = {
        kind: "file",
        path,
        ...(opts.wsl ? { wsl: opts.wsl } : {}),
        ...line,
        ...(opts.peek ? { peek: true as const } : {}),
        ...(opts.diff ? { view: "diff" as const } : {}),
        ...(opts.anchor ? { anchor: opts.anchor } : {}),
      }
      // A peek takes the place of the pane's previous one.
      const old = opts.peek
        ? pane.entryIds.find((e) => (state.objects[e] as FileEntry | undefined)?.peek)
        : undefined
      // Added right after it first, then it goes: the pane survives even when the peek was all
      // it held, and the new peek takes its place.
      const at = old ? pane.entryIds.indexOf(old) + 1 : undefined
      let root = addSurface(tab.root, pane.id, id, at)
      if (old) root = removeNode(root, old) ?? root
      const objects = { ...state.objects, [id]: file }
      if (old) {
        delete objects[old]
        files.forget(old) // the replaced peek's text and lines go now
      }
      return {
        objects,
        tabs: replaceTab(state.tabs, tab.id, (t) => withFocus(t, id, root)),
        activeTabId: tab.id,
      }
    }),

  setFileView: (id, view) =>
    set((state) => {
      const o = state.objects[id]
      if (o?.kind !== "file" || viewOf(o) === view) return state
      if (view === "preview" && !isMarkdownPath(o.path)) return state
      const next: FileEntry = { ...o }
      delete next.view // its default…
      if (viewOf(next) !== view) next.view = view as "source" | "diff" // …or the one asked for
      return { objects: { ...state.objects, [id]: next } }
    }),

  keepEntry: (id) =>
    set((state) => {
      const o = state.objects[id]
      if (o?.kind !== "file" || !o.peek) return state
      const kept: FileEntry = { ...o }
      delete kept.peek
      return { objects: { ...state.objects, [id]: kept } }
    }),

  openFolder: (path, opts = {}) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === (opts.tabId ?? state.activeTabId))
      if (!tab || !path) return {}
      const pane = opts.paneId
        ? findPaneById(tab.root, opts.paneId)
        : findPane(tab.root, tab.activeEntryId)
      if (!pane) return {}
      // Already open in this pane: show that one.
      const norm = normalizeRootPath(path)
      const open = pane.entryIds.find((e) => {
        const o = state.objects[e]
        return (
          o?.kind === "folder" &&
          (state.platform === "win32" && !opts.wsl
            ? o.path.toLowerCase() === norm.toLowerCase()
            : o.path === norm) &&
          !o.wsl === !opts.wsl &&
          o.wsl?.distro === opts.wsl?.distro
        )
      })
      if (open)
        return {
          tabs: replaceTab(state.tabs, tab.id, (t) => withFocus(t, open)),
          activeTabId: tab.id,
        }
      const id = objectId(newId())
      const folder: FolderEntry = {
        kind: "folder",
        path: normalizeRootPath(path),
        ...(opts.wsl ? { wsl: opts.wsl } : {}),
      }
      const root = addSurface(tab.root, pane.id, id)
      return {
        objects: { ...state.objects, [id]: folder },
        tabs: replaceTab(state.tabs, tab.id, (t) => withFocus(t, id, root)),
        activeTabId: tab.id,
      }
    }),

  setFolderView: (id, view) =>
    set((state) =>
      !state.objects[id] || state.folderViews[id] === view
        ? state // same state: nothing notified, nothing saved
        : { folderViews: { ...state.folderViews, [id]: view } },
    ),

  setFolderRoot: (id, path) =>
    set((state) => {
      const cur = state.objects[id]
      const norm = normalizeRootPath(path)
      if (cur?.kind !== "folder" || cur.path === norm) return state
      return {
        objects: { ...state.objects, [id]: { ...cur, path: norm } },
        folderViews: { ...state.folderViews, [id]: EMPTY_VIEW },
      }
    }),

  setSessionOscTitle: (sessionId, title) =>
    set((state) => {
      const s = state.sessions[sessionId]
      const next = title.trim()
      if (!s || !next || s.oscTitle === next) return {}
      return { sessions: { ...state.sessions, [sessionId]: { ...s, oscTitle: next } } }
    }),
  setGit: (git) => set({ git }),
  setFolderRoots: (roots) =>
    set((state) => {
      const cur = state.folderRoots
      const keys = Object.keys(roots)
      const same = keys.length === Object.keys(cur).length && keys.every((k) => cur[k] === roots[k])
      return same ? state : { folderRoots: roots }
    }),
  setFolderGit: (key, git) =>
    set((state) => {
      const cur = state.folderGit[key]
      if (git && cur && JSON.stringify(cur) === JSON.stringify(git)) return state // no re-render
      if (!git && !cur) return state
      const folderGit = { ...state.folderGit }
      if (git) folderGit[key] = git
      else delete folderGit[key]
      return { folderGit }
    }),

  // Fold a coalesced batch of hook events into the agent tree (one re-render per batch).
  applyAgentEvents: (events) =>
    set((state) => {
      let agents = state.agents
      let paneWork = state.paneWork
      const touched = new Set<string>()
      for (const ev of events) {
        agents = reduceAgentEvent(agents, ev)
        const pane = ev.worked && workPane(agents, ev)
        if (!pane || !state.sessions[pane]) continue
        const w = addWork(paneWork[pane], ev, ++workSeq, Date.now())
        if (w !== paneWork[pane]) paneWork = { ...paneWork, [pane]: w! }
        touched.add(pane)
      }
      if (paneWork === state.paneWork) return { agents }
      return {
        agents,
        paneWork: settleAllWork(paneWork, state.dirRoots, state.paneGit, touched),
      }
    }),
  agentExited: (paneId) =>
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
  setGhMissing: (ghMissing) => {
    if (get().ghMissing !== ghMissing) set({ ghMissing })
  },
  setPrDialogOpen: (prDialogOpen) =>
    set(prDialogOpen ? { prDialogOpen, paletteOpen: false } : { prDialogOpen, prLink: null }),
  openPrLink: (pr, pane) =>
    set({ prDialogOpen: true, paletteOpen: false, prLink: { ...pr, pane, at: Date.now() } }),
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
      objects: ws.objects ?? {},
      folderViews: ws.folderViews ?? {},
      ...(ws.rightPanelWidth !== undefined ? { rightPanelWidth: ws.rightPanelWidth } : {}),
    }),
  setRightPanelWidth: (px, maxAvail) => set({ rightPanelWidth: clampPanelWidth(px, maxAvail) }),

  newTab: (shell) =>
    set((state) => {
      const session = makeSession(shell, focusedCwd(state))
      // Title unpinned: the display derives from the focused pane's live title.
      const tab: Tab = makeTab(newId(), "", makeLeaf(newId(), session.id), session.id)
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
        return {
          ...dropSessions(state, allSessionIds(tab.root)),
          ...dropObjects(state, allEntryIds(tab.root)),
          ...withoutTab(state, tabId),
        }
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
    set((state) => {
      const name = title.trim()
      const tab = state.tabs.find((t) => t.id === tabId)
      if (!tab || tab.title === name) return state // same reference: no reconcile, no save
      return { tabs: state.tabs.map((t) => (t === tab ? { ...t, title: name } : t)) }
    }),

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
      // A focused folder: a terminal in that folder (newTerminalSource).
      const from = newTerminalSource(state, tab, fallback)
      if (!from) return {}
      const { shell, cwd } = from
      // An ssh pane's split opens where it verifiably is (its host's shell integration).
      const reopen = shell.remote ? reopenFor(src) : undefined
      const next = splitActivePane(state, { shell, cwd, direction, reopen })
      return { ...next, ...hintFor(state, shell, next) }
    }),

  // Open a folder (an agent's cwd / worktree from the board) as a split beside the active
  // pane. Resolves the shell from the AGENT's own pane (paneId) so a WSL agent's path opens
  // in a WSL shell, not the active native pane's; a missing dir falls back to $HOME in main.
  openFolderInSplit: (cwd, paneId, host) =>
    set((state) => {
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab) return {}
      const agentSession = paneId ? state.sessions[paneId] : undefined
      const src = state.sessions[tab.activeSessionId]
      // (a host folder: a host shell or none, never WSL's, which would start in `~`)
      const shell = host
        ? hostOnlyShellFor(state, agentSession ?? src)
        : localShellFor(state, agentSession ?? src)
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
      const tabs = state.tabs.map((t) =>
        t.id === tab.id ? withFocus(t, paneId, t.root, false) : t,
      )
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
      const pane = findPane(tab.root, tab.activeEntryId) // the focused pane
      if (!pane) return {}
      const src = state.sessions[tab.activeSessionId]
      const from = newTerminalSource(state, tab, fallback) // in the focused folder, if any
      if (!from) return {}
      const { shell, cwd } = from
      const session = makeSession(shell, cwd, shell.remote ? reopenFor(src) : undefined)
      const root = addSurface(tab.root, pane.id, session.id)
      const next = {
        sessions: { ...state.sessions, [session.id]: session },
        tabs: replaceTab(state.tabs, tab.id, (t) => withFocus(t, session.id, root)),
      }
      return { ...next, ...hintFor(state, shell, next) }
    }),

  closeSurface: (tabId, sessionId) =>
    set(
      closing((state) => {
        const tab = state.tabs.find((t) => t.id === tabId)
        const pane = tab && findPane(tab.root, sessionId)
        if (!tab || !pane) return {}
        const dropped = { ...dropSessions(state, [sessionId]), ...dropObjects(state, [sessionId]) }
        const root = removeNode(tab.root, sessionId)
        if (root === null) return { ...dropped, ...withoutTab(state, tabId) }
        // Closing the focused terminal: focus moves to the surface its pane now shows,
        // or (the pane is gone) to the leftmost pane.
        const survivor = findPaneById(root, pane.id)
        const focus =
          tab.activeEntryId === sessionId
            ? (survivor?.activeEntryId ?? firstEntryId(root))
            : tab.activeEntryId
        return {
          ...dropped,
          // The surface revealed in its place is now being looked at.
          sessions: markSeen(dropped.sessions, focus),
          tabs: replaceTab(state.tabs, tabId, (t) => withFocus(t, focus, root)),
        }
      }),
    ),

  closePane: (tabId, paneId) =>
    set(
      closing((state) => {
        const tab = state.tabs.find((t) => t.id === tabId)
        const pane = tab && findPaneById(tab.root, paneId)
        if (!tab || !pane) return {}
        const dropped = {
          ...dropSessions(state, paneSessionIds(pane)),
          ...dropObjects(state, pane.entryIds),
        }
        const root = removePane(tab.root, paneId)
        if (root === null) return { ...dropped, ...withoutTab(state, tabId) }
        const focus = pane.entryIds.includes(tab.activeEntryId)
          ? firstEntryId(root)
          : tab.activeEntryId
        return {
          ...dropped,
          sessions: markSeen(dropped.sessions, focus),
          tabs: replaceTab(state.tabs, tabId, (t) => withFocus(t, focus, root)),
        }
      }),
    ),

  requestClosePane: (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId)
    const pane = tab && findPaneById(tab.root, paneId)
    if (!pane) return
    const ids = paneSessionIds(pane)
    if (ids.length > 1) {
      set({ closeConfirm: { kind: "pane", tabId, paneId, count: ids.length } })
    } else if (ids[0] && pane.entryIds.length === 1) {
      // One terminal: the terminal rule (asks while it runs a command or Claude).
      get().requestCloseTerminal(tabId, ids[0])
    } else if (ids[0]) {
      // One terminal beside folders: its question, but the whole pane closes.
      const s = get()
      const [t] = terminalStates(s, ids)
      const session = s.sessions[ids[0]]
      const ask =
        t && session ? terminalCloseConfirm(tabId, displaySessionTitle(session, s.home), t) : null
      if (ask?.kind === "terminal") set({ closeConfirm: { ...ask, paneId } })
      else s.closePane(tabId, paneId)
    } else {
      get().closePane(tabId, paneId) // no terminal: nothing to ask about
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
    else if (c.paneId) get().closePane(c.tabId, c.paneId)
    else get().closeSurface(c.tabId, c.sessionId)
  },

  requestCloseEntry: (tabId, entryId) => {
    if (isTerminalEntry(entryId)) get().requestCloseTerminal(tabId, entryId)
    else get().closeSurface(tabId, entryId) // a folder / file: nothing runs, nothing to ask
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
      if (next === state.paneGit) return {}
      const paneWork = settleAllWork(state.paneWork, state.dirRoots, next)
      return paneWork === state.paneWork ? { paneGit: next } : { paneGit: next, paneWork }
    }),
  setDirRoots: (answers, gone = [], searched = false) =>
    set((state) => {
      let dirRoots = withDirRoots(state.dirRoots, answers, Date.now(), searched)
      for (const root of gone) dirRoots = forgetRoot(dirRoots, root, Date.now())
      // Only open panes' folders (a pane closed while its lookup was in flight adds none back).
      if (dirRoots !== state.dirRoots) dirRoots = keepDirRoots(dirRoots, state.paneWork)
      if (dirRoots === state.dirRoots) return {}
      const paneWork = settleAllWork(state.paneWork, dirRoots, state.paneGit)
      return paneWork === state.paneWork ? { dirRoots } : { dirRoots, paneWork }
    }),

  setAgentHint: (sessionId, hint) =>
    set((state) => {
      // Unchanged → the same state object, so nothing is notified.
      if (hint && !state.sessions[sessionId]) return state
      if (!hint && !(sessionId in state.agentHint)) return state
      const agentHint = { ...state.agentHint }
      if (hint) agentHint[sessionId] = hint
      else delete agentHint[sessionId]
      return { agentHint }
    }),

  // A past session (Sessions tab): a split in its folder, and the relaunch resume flow types its
  // command at the first prompt. An unverified folder (hung mount) isn't a spawn cwd: the typed
  // `cd` reaches it instead.
  resumeInSplit: (plan) => {
    const state = get()
    const before = state.tabs.find((t) => t.id === state.activeTabId)?.activeSessionId
    if (plan.cwdUnverified) {
      // Only a typed `cd` reaches it then, and only a POSIX shell gets one.
      const shell = localShellFor(state, before ? state.sessions[before] : undefined)
      if (!shell || !isPosixShell(shell.command)) return undefined
    }
    get().openFolderInSplit(plan.cwdUnverified ? state.home : plan.cwd)
    const id = get().tabs.find((t) => t.id === get().activeTabId)?.activeSessionId
    if (!id || id === before) return undefined
    get().setResume(id, { phase: "pending", plan })
    return id
  },

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
  moveSurface: (tabId, sessionId, target) => {
    // A terminal from another group (its group was spring-loaded open mid-drag).
    const here = get().tabs.find((t) => t.id === tabId)
    if (here && !findPane(here.root, sessionId))
      return get().moveTerminal(sessionId, { kind: "pane", tabId, target })
    let moved = false
    set((state) => {
      const tab = state.tabs.find((t) => t.id === tabId)
      // Stale drop (the surface or target pane went away mid-drag): just end the drag.
      if (!tab || !findPane(tab.root, sessionId) || !findPaneById(tab.root, target.paneId)) {
        return { dragging: null }
      }
      const root = moveSurface(tab.root, sessionId, target, { splitId: newId(), paneId: newId() })
      moved = root !== tab.root
      return {
        dragging: null,
        tabs: replaceTab(state.tabs, tabId, (t) => withFocus(t, sessionId, root)),
        sessions: markSeen(state.sessions, sessionId),
      }
    })
    if (moved) get().keepEntry(sessionId) // a peek dragged somewhere: kept
  },

  moveTerminal: (sessionId, drop) => {
    const state = get()
    const ids = { splitId: newId(), paneId: newId(), tabId: newId() }
    const r = moveTerminalPure(state.tabs, sessionId, drop, ids)
    if (!r) return set({ dragging: null })
    get().keepEntry(sessionId) // a peek moved to another group: kept
    // closing(): a pending close confirm naming the emptied group / the moved terminal goes.
    set(
      closing(() => ({
        dragging: null,
        tabs: r.tabs,
        activeTabId: r.activeTabId,
        sessions: markSeen(state.sessions, sessionId),
      })),
    )
    get().revealTab(r.activeTabId)
  },

  setActivePane: (tabId, sessionId) =>
    set((state) => ({
      tabs: replaceTab(state.tabs, tabId, (t) => withFocus(t, sessionId)),
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
        tabs: replaceTab(state.tabs, tab.id, (t) => withFocus(t, sessionId)),
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
