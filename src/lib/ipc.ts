import type { ShellOption, SpawnOpts, SshHost } from "../types"
import type { WslContext } from "./wsl"
import type { AgentEvent } from "./agent-graph"
import type { SessionMeta } from "./session-color"
import type { ResumePlan } from "./resume"
import type { PaneGitInfo, PaneGitRequest } from "./pane-git"
import type { DirListing } from "./dir-listing"
import type { EditorInfo } from "./file-actions"
import type { PreviewData } from "./file-preview"
import type { UpdateStatus } from "./version"

// The typed surface the preload exposes on window.smterm. Every renderer→main
// call goes through this one seam (keeps components portable + is the insulation
// point for a future out-of-process session daemon — see ARCHITECTURE Appendix A).
export type { SpawnOpts } from "../types"

export interface Ipc {
  // Resolves { reattached: true } when the session was already live in main and we
  // reconnected the (reloaded) renderer to it, replaying history, instead of spawning.
  // started: false = attachOnly found nothing live to reattach, so nothing was started.
  ptySpawn: (
    opts: SpawnOpts,
  ) => Promise<{ reattached: boolean; integrated?: boolean; started?: boolean }>
  onPtyData: (id: string, cb: (data: string) => void) => () => void
  ptyWrite: (id: string, data: string) => void
  ptyResize: (id: string, cols: number, rows: number) => void
  ptyKill: (id: string) => void
  // The PTY's process exited on its own (not a pty:kill) — e.g. a dropped ssh connection.
  onPtyExit: (id: string, cb: (e: { code: number; signal: number }) => void) => () => void
  listSshHosts: () => Promise<SshHost[] | null> // null = main couldn't build it this time
  onSshHostsChanged: (cb: () => void) => () => void
  openSshConfig: () => void // opens ~/.ssh/config (creating an empty one if needed)
  listShells: () => Promise<ShellOption[]>
  readSettings: () => Promise<string>
  writeSettings: (contents: string) => Promise<void>
  settingsPath: () => Promise<string>
  onSettingsChanged: (cb: () => void) => () => void
  onAgentEvents: (cb: (events: AgentEvent[]) => void) => () => void
  // A Claude pane's /color + /rename (null = claude left the pane) → the pane accent.
  onAgentMeta: (cb: (paneId: string, meta: SessionMeta | null) => void) => () => void
  agentMetaSnapshot: () => Promise<[string, SessionMeta][]> // all current (renderer reload)
  // Claude sessions to resume in restored terminals; consume = attempted/dismissed (one shot).
  resumePlan: (paneIds: string[], allowBypass: boolean) => Promise<Record<string, ResumePlan>>
  resumeConsume: (paneId: string, sessionId: string) => void
  shellIdle: (paneId: string) => void // shell prompt returned after a command (resume ledger)
  openExternal: (url: string) => void
  openPath: (p: string) => void
  // Does `path` (relative to `cwd`, or absolute) exist? Validates a detected file link.
  pathExists: (cwd: string, path: string) => Promise<boolean>
  // Open a clicked file link in the configured editor (falls back to the OS default).
  openFile: (cwd: string, file: string, line?: number, col?: number) => void
  revealPath: (p: string) => void // show the file/folder in Finder/Explorer
  editorInfo: () => Promise<EditorInfo> // can the configured editor open a file?
  notify: (title: string, body: string) => void
  clipboardWrite: (text: string) => void
  clipboardRead: () => Promise<string>
  // Lazy, one directory at a time (files browser). `wsl` translates a WSL pane's Linux
  // path to a \\wsl.localhost\ UNC so the Windows host can list it.
  readdir: (dir: string, wsl?: WslContext) => Promise<DirListing>

  // Read a file for the preview popup; `wsl` reads a WSL pane's Linux path via its UNC share.
  readFilePreview: (path: string, wsl?: WslContext) => Promise<PreviewData>
  // Native folder picker (Files root); `wsl` opens it at the distro's UNC share and returns
  // a distro-native Linux path.
  pickDirectory: (defaultPath?: string, wsl?: WslContext) => Promise<string | null>
  // Validate a typed path is a directory; `wsl` checks a WSL pane's path via the UNC share.
  pathIsDir: (p: string, wsl?: WslContext) => Promise<boolean>

  minimizeWindow: () => void
  setWindowBackground: (color: string) => void // native bg follows the theme (persisted)
  maximizeWindow: () => void
  closeWindow: () => void
  isMaximized: () => Promise<boolean>
  onMaximizeChange: (cb: (max: boolean) => void) => () => void
  platformInfo: () => Promise<PlatformInfo>
  gitStatus: (cwd: string, wsl?: WslContext) => Promise<GitStatus>
  paneGitInfo: (reqs: PaneGitRequest[]) => Promise<Record<string, PaneGitInfo>> // sidebar PRs
  gitDiff: (cwd: string, file: string, wsl?: WslContext) => Promise<DiffLine[]>
  readWorkspace: () => Promise<string>
  writeWorkspace: (contents: string) => void
  appMetrics: () => Promise<ProcMetric[]>
  perfMode: () => Promise<boolean>
  appVersion: () => Promise<string>
  checkUpdate: () => Promise<UpdateStatus>
}

export interface ProcMetric {
  type: string
  pid: number
  cpu: number // percent
  memoryKB: number
}

export interface PlatformInfo {
  platform: string
  label: string
  release: string
  home: string
  profile: string // "dev" etc. for a non-default profile; "" for the installed app's
}

export type ChangeStatus = "M" | "A" | "D" | "R" | "?"

export interface GitFile {
  path: string
  name: string
  dir: string
  status: ChangeStatus
  add: number
  del: number
}

export interface GitStatus {
  isRepo: boolean
  root: string // repo toplevel (abs); "" when not a repo
  branch: string
  ahead: number
  behind: number
  files: GitFile[]
  add: number
  del: number
}

export interface DiffLine {
  type: "add" | "del" | "context" | "hunk"
  text: string
  oldNo?: number
  newNo?: number
}

declare global {
  interface Window {
    smterm: Ipc
  }
}

export const ipc: Ipc = window.smterm
