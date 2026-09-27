import { contextBridge, ipcRenderer } from "electron"
import type { AgentEvent } from "../src/lib/agent-graph"
import type { SessionMeta } from "../src/lib/session-color"
import type { ResumePlan } from "../src/lib/resume"
import type { PaneGitInfo, PaneGitRequest } from "../src/lib/pane-git"
import type { WslContext } from "../src/lib/wsl"

const api = {
  ptySpawn: (opts: {
    id: string
    cols: number
    rows: number
    shell: string
    args: string[]
    cwd?: string
    bg?: string
    remote?: unknown
    attachOnly?: boolean
  }) => ipcRenderer.invoke("pty:spawn", opts),

  onPtyExit: (id: string, cb: (e: { code: number; signal: number }) => void) => {
    const channel = `pty:exit:${id}`
    const listener = (_e: unknown, info: { code: number; signal: number }) => cb(info)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  listSshHosts: () => ipcRenderer.invoke("ssh:list-hosts"),
  onSshHostsChanged: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on("ssh-hosts-changed", listener)
    return () => ipcRenderer.removeListener("ssh-hosts-changed", listener)
  },
  openSshConfig: () => ipcRenderer.send("ssh:open-config"),

  onPtyData: (id: string, cb: (data: string) => void) => {
    const channel = `pty:data:${id}`
    const listener = (_e: unknown, data: string) => cb(data)
    ipcRenderer.on(channel, listener)
    return () => ipcRenderer.removeListener(channel, listener)
  },

  ptyWrite: (id: string, data: string) => ipcRenderer.send("pty:write", id, data),
  ptyResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("pty:resize", id, cols, rows),
  ptyKill: (id: string) => ipcRenderer.send("pty:kill", id),

  listShells: () => ipcRenderer.invoke("shells:list"),

  readSettings: () => ipcRenderer.invoke("settings:read") as Promise<string>,
  writeSettings: (contents: string) => ipcRenderer.invoke("settings:write", contents),
  settingsPath: () => ipcRenderer.invoke("settings:path") as Promise<string>,
  onSettingsChanged: (cb: () => void) => {
    const listener = () => cb()
    ipcRenderer.on("settings-changed", listener)
    return () => ipcRenderer.removeListener("settings-changed", listener)
  },

  // Coalesced batches of agent hook events (M6 agents board).
  onAgentEvents: (cb: (events: AgentEvent[]) => void) => {
    const listener = (_e: unknown, events: AgentEvent[]) => cb(events)
    ipcRenderer.on("agents:events", listener)
    return () => ipcRenderer.removeListener("agents:events", listener)
  },
  // Per-pane Claude /color + /rename (pane accent); snapshot = all current, for a reload.
  onAgentMeta: (cb: (paneId: string, meta: SessionMeta | null) => void) => {
    const listener = (_e: unknown, paneId: string, meta: SessionMeta | null) => cb(paneId, meta)
    ipcRenderer.on("agents:meta", listener)
    return () => ipcRenderer.removeListener("agents:meta", listener)
  },
  resumePlan: (paneIds: string[], allowBypass: boolean) =>
    ipcRenderer.invoke("agents:resume-plan", paneIds, allowBypass) as Promise<
      Record<string, ResumePlan>
    >,
  resumeConsume: (paneId: string, sessionId: string) =>
    ipcRenderer.send("agents:resume-consume", paneId, sessionId),
  shellIdle: (paneId: string) => ipcRenderer.send("agents:shell-idle", paneId),
  agentMetaSnapshot: () =>
    ipcRenderer.invoke("agents:meta-snapshot") as Promise<[string, SessionMeta][]>,

  openExternal: (url: string) => ipcRenderer.send("open-external", url),
  appVersion: () => ipcRenderer.invoke("app:version") as Promise<string>,
  checkUpdate: () => ipcRenderer.invoke("app:check-update"),
  openPath: (p: string) => ipcRenderer.send("open-path", p),
  pathExists: (cwd: string, path: string) =>
    ipcRenderer.invoke("fs:path-exists", cwd, path) as Promise<boolean>,
  openFile: (cwd: string, file: string, line?: number, col?: number) =>
    ipcRenderer.send("file:open", cwd, file, line, col),
  revealPath: (p: string) => ipcRenderer.send("file:reveal", p),
  editorInfo: () => ipcRenderer.invoke("editor:info"),
  notify: (title: string, body: string) => ipcRenderer.send("notify", title, body),

  clipboardWrite: (text: string) => ipcRenderer.send("clipboard:write", text),
  clipboardRead: () => ipcRenderer.invoke("clipboard:read") as Promise<string>,
  readdir: (dir: string, wsl?: WslContext) => ipcRenderer.invoke("fs:readdir", dir, wsl),
  readFilePreview: (path: string, wsl?: WslContext) =>
    ipcRenderer.invoke("fs:read-preview", path, wsl),
  pickDirectory: (defaultPath?: string, wsl?: WslContext) =>
    ipcRenderer.invoke("dialog:pick-directory", defaultPath, wsl),
  pathIsDir: (p: string, wsl?: WslContext) => ipcRenderer.invoke("fs:is-dir", p, wsl),

  minimizeWindow: () => ipcRenderer.send("window:minimize"),
  setWindowBackground: (color: string) => ipcRenderer.send("window:set-background", color),
  maximizeWindow: () => ipcRenderer.send("window:maximize"),
  closeWindow: () => ipcRenderer.send("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:is-maximized") as Promise<boolean>,
  onMaximizeChange: (cb: (max: boolean) => void) => {
    const listener = (_e: unknown, max: boolean) => cb(max)
    ipcRenderer.on("window:maximize-change", listener)
    return () => ipcRenderer.removeListener("window:maximize-change", listener)
  },

  platformInfo: () =>
    ipcRenderer.invoke("platform:info") as Promise<{
      platform: string
      label: string
      release: string
    }>,

  paneGitInfo: (reqs: PaneGitRequest[]) =>
    ipcRenderer.invoke("pane:git-info", reqs) as Promise<Record<string, PaneGitInfo>>,
  gitStatus: (cwd: string, wsl?: { distro?: string }) => ipcRenderer.invoke("git:status", cwd, wsl),
  gitDiff: (cwd: string, file: string, wsl?: { distro?: string }) =>
    ipcRenderer.invoke("git:diff", cwd, file, wsl),

  readWorkspace: () => ipcRenderer.invoke("workspace:read") as Promise<string>,
  writeWorkspace: (contents: string) => ipcRenderer.invoke("workspace:write", contents),

  appMetrics: () => ipcRenderer.invoke("app:metrics"),
  perfMode: () => ipcRenderer.invoke("app:perf-mode") as Promise<boolean>,
}

contextBridge.exposeInMainWorld("smterm", api)

export type SmtermApi = typeof api
