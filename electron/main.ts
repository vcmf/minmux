import {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  Notification,
  dialog,
  powerMonitor,
  clipboard,
  nativeImage,
} from "electron"
import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { StringDecoder } from "node:string_decoder"
import * as pty from "node-pty"
import type { IPty } from "node-pty"
import { watch } from "chokidar"
import {
  listShells,
  buildInjection,
  isWslShell,
  wslCdArgs,
  buildWslInjection,
  defaultWslDistro,
  parseWslDistroArg,
  setIntegrationDirName,
} from "./shell-integration"
import { gitStatus, gitDiff } from "./git"
import { OutputCoalescer } from "./coalescer"
import { OutputBuffer } from "./output-buffer"
import { drainPtys, type Drainable } from "./pty-drain"
import { quitStep, type QuitPhase } from "./quit-plan"
import { appendDiag } from "./diagnostics"
import { applyLoginShellEnv } from "./shell-env"
import { buildEditorCommand, winQuote } from "./editor-command"
import { orderMacEditors, planEditor, type EditorPlan, type EditorInfo } from "./editor-detect"
import { checkForUpdate } from "./update-check"
import { startHookWatcher } from "./agent-hooks"
import type { AgentEvent } from "../src/lib/agent-graph"
import { buildHookSettings } from "./hook-writer"
import { toDirListing } from "../src/lib/dir-listing"
import { wslUncCandidates, winToMnt, uncToWslPath } from "./wsl-paths"
import { colorfgbg } from "./color"
import { TranscriptTokens } from "./transcript-tokens"
import { tokenEventsForBatch } from "./agent-tokens"
import { AgentMetaTracker } from "./agent-meta"
import { SessionLedger } from "./agent-sessions"
import { displayName, profileNames, resolveProfile, scrubParentInstanceEnv } from "./profile"
import { PaneGitService } from "./pane-git"
import type { PaneGitRequest } from "../src/lib/pane-git"
import type { WslContext } from "../src/lib/wsl"
import {
  classifyPreview,
  PREVIEW_READ_CAP,
  PREVIEW_MAX_SIZE,
  type PreviewData,
} from "../src/lib/file-preview"

// This process's profile (a dev build is `dev`): picked before anything reads a path. An
// invalid SMTERM_PROFILE stops here, synchronously — before any name, path or lock is set —
// so it can never fall back to (and write into) another profile's data. Then the env is
// scrubbed of what a parent smterm set for its own pane (its hook file, pane id, our profile
// choice), so nothing we spawn — shells, editors, git — inherits it.
const PROFILE_CHOICE = resolveProfile({
  flag: app.commandLine.hasSwitch("profile")
    ? app.commandLine.getSwitchValue("profile")
    : undefined,
  env: process.env.SMTERM_PROFILE,
  packaged: app.isPackaged,
})
if ("error" in PROFILE_CHOICE) {
  // macOS / Windows: a blocking error box (+ stderr for a terminal launch). Linux has no
  // dialog before ready — showErrorBox prints to stderr there itself.
  if (process.platform !== "linux") console.error(`smterm: ${PROFILE_CHOICE.error}`)
  dialog.showErrorBox("smterm can't start", PROFILE_CHOICE.error)
  process.exit(1)
}
const PROFILE_NAMES = profileNames(PROFILE_CHOICE.profile)
scrubParentInstanceEnv(process.env)
setIntegrationDirName(PROFILE_NAMES.appName)
// electron-vite's dev-server URL is for this process only: read once, then gone from the env
// every child inherits (shells, the editor openFile starts, git), and only honoured unpackaged.
const DEV_RENDERER_URL = app.isPackaged ? undefined : process.env.ELECTRON_RENDERER_URL
delete process.env.ELECTRON_RENDERER_URL

const dir = path.dirname(fileURLToPath(import.meta.url))

// Session-survival diagnostics: log rare lifecycle/power/PTY events to a file that
// survives an app kill (see electron/diagnostics.ts). Temporary — remove once the
// lid-close trigger is confirmed. Reads configDir() lazily so it lands next to settings.
const diag = (event: string, fields?: Record<string, string | number | boolean>) =>
  appendDiag(configDir(), event, fields)

// One record per live PTY. The PTY lives in the main process, so it survives a
// renderer reload (dev HMR on resume, or a GPU-process crash) — `sender` is the
// CURRENT renderer target and is rebound on reattach; `buffer` holds recent output
// so the reloaded renderer can replay history instead of respawning the shell.
interface PtySession {
  id: string
  proc: IPty
  buffer: OutputBuffer
  sender: Electron.WebContents
  coalescer?: OutputCoalescer // absent only in the SMTERM_NO_COALESCE=1 A/B baseline
  shell: string
  wslDistro?: string // for a WSL pane: the distro, so its Linux paths resolve to the right UNC share
  integrated: boolean // our shell integration (OSC 133 marks, claude wrapper) was injected
  live: Drainable // this PTY's entry in livePtys (outlives the session record until onExit)
}
const sessions = new Map<string, PtySession>()
// Every node-pty that hasn't reported its exit yet — including closed panes still winding
// down (gone from `sessions`). None may outlive Node: quitting drains this (pty-drain.ts).
const livePtys = new Set<Drainable>()
let mainWindow: BrowserWindow | null = null
// Paths to the scoped Claude Code hook-settings files the `claude` shell wrapper loads
// (set once the file-drop watcher is up). null ⇒ agents board stays empty. The WSL variant
// (Windows only) points the drop dir at a /mnt/c path an in-WSL claude can write.
let hookSettingsPath: string | null = null
let hookSettingsPathWsl: string | null = null
let hookWatcher: { close: () => Promise<void> } | null = null
// Accumulates per-transcript token totals across hook batches (session + sub-agent).
const agentTokens = new TranscriptTokens()
// Branch + GitHub PR per terminal (sidebar), via git + the user's `gh`.
const paneGit = new PaneGitService()
// Per-pane Claude `/color` + `/rename` (pane accent), read from each session's transcript.
const agentMeta = new AgentMetaTracker((paneId, meta) => {
  mainWindow?.webContents.send("agents:meta", paneId, meta)
  sessionLedger().setName(paneId, meta?.name) // the /rename, for the resume banner
})
// Which Claude session each terminal is inside (persisted) → resume on relaunch.
let ledger: SessionLedger | null = null
const sessionLedger = () =>
  (ledger ??= new SessionLedger(path.join(configDir(), "agent-sessions.json")))
let quitConfirmed = false
let quitPhase: QuitPhase = "running" // running → draining (PTYs ending) → drained (quit through)
let osEnding = false // the OS is logging out / restarting — don't hold its quit
const draining = () => quitPhase !== "running"

// PTY output batching (see electron/coalescer.ts + docs/PERF.md).
const PTY_FLUSH_MS = 4
const PTY_MAX_FLUSH_BYTES = 256 * 1024
// Recent output kept per session for replay when a reloaded renderer reattaches.
const PTY_REPLAY_BYTES = 256 * 1024

// Session lifecycle only (rare; never per-tool events or cwd changes): enough to trace resume.
const TRACED_HOOKS = new Set(["SessionStart", "SessionEnd", "WorktreeCreate"])
/** A hook event's diagnostics fields: which session, from which pane, where. */
function hookTrace(ev: AgentEvent): Record<string, string> {
  return {
    ev: ev.event,
    sid: ev.sessionId.slice(0, 8),
    pane: (ev.paneId ?? "-").slice(0, 8),
    src: ev.source ?? ev.reason ?? "",
    cwd: ev.cwd ?? "",
  }
}

// Send PTY output to the session's current renderer (skips a destroyed one).
function emit(rec: PtySession, data: string): void {
  // Quitting: the dying shells' last output (a bell, OSC 9) mustn't reach the hidden window.
  if (draining()) return
  if (!rec.sender.isDestroyed()) rec.sender.send(`pty:data:${rec.id}`, data)
}

function defaultShell(): string {
  return process.env.SHELL ?? (process.platform === "win32" ? "powershell.exe" : "/bin/zsh")
}

// Host-fs targets for a path, in try order: for a WSL pane, the distro's UNC share
// candidates (default distro resolved, both share forms); otherwise the path itself.
// Shared by fs:readdir + fs:read-preview so the WSL translation lives in one place.
function wslTargets(p: string, wsl?: WslContext): string[] {
  const candidates = wsl ? wslUncCandidates(wsl.distro ?? defaultWslDistro(), p) : []
  return candidates.length ? candidates : [p]
}

// Host-fs candidates for a transcript path a hook reported. On Windows a POSIX-absolute path
// came from a WSL `claude` → read it via that pane's distro's UNC shares (looked up by the
// event's paneId, so non-default distros resolve correctly), falling back to the default
// distro when the pane is unknown. Otherwise it's already a host path.
const transcriptTargets = (p: string, paneId?: string): string[] => {
  if (!(process.platform === "win32" && p.startsWith("/"))) return [p]
  const distro = (paneId ? sessions.get(paneId)?.wslDistro : undefined) ?? defaultWslDistro()
  const candidates = distro ? wslUncCandidates(distro, p) : []
  return candidates.length ? candidates : [p]
}

// The app icon. Packaged builds get it from the bundle (electron-builder → build/icon.*),
// but in dev Electron shows its default icon unless we set it at runtime, so point at the
// source PNG in build/ (app path = project root in dev). Returns null if not found.
// Memoised — the PNG is decoded once and reused by both the window and the dock.
let cachedIcon: Electron.NativeImage | null | undefined
function appIcon(): Electron.NativeImage | null {
  if (cachedIcon !== undefined) return cachedIcon
  const p = path.join(app.getAppPath(), "build", "icon.png")
  if (!fs.existsSync(p)) return (cachedIcon = null)
  const img = nativeImage.createFromPath(p)
  return (cachedIcon = img.isEmpty() ? null : img)
}

function createWindow() {
  const icon = appIcon()
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 640,
    minHeight: 420,
    title: displayName(PROFILE_NAMES),
    backgroundColor: readWindowBg(), // last theme's bg — a light theme mustn't open dark
    frame: false, // frameless — the app draws its own top bar + window controls
    ...(icon ? { icon } : {}), // window/taskbar icon (win/linux; macOS uses the dock icon)
    webPreferences: {
      preload: path.join(dir, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // allow the ESM preload + node-pty access in main
    },
  })

  mainWindow = win
  // Main owns the title ("smterm (dev)"): index.html's <title> would reset it on load.
  win.on("page-title-updated", (e) => e.preventDefault())
  win.on("session-end", () => sessionLedger().freeze(60_000)) // Windows logout/shutdown — see onPower
  win.on("closed", () => {
    mainWindow = null
  })

  // Tell the renderer when maximize state changes (custom controls swap icon).
  const sendMax = () => win.webContents.send("window:maximize-change", win.isMaximized())
  win.on("maximize", sendMax)
  win.on("unmaximize", sendMax)

  // Load-test mode: surface the renderer's [PERF] report lines on stdout.
  if (process.env.SMTERM_PERF === "1") {
    win.webContents.on("console-message", (_e, _l, message) => {
      if (message.startsWith("[PERF]")) console.log(message)
    })
  }

  if (DEV_RENDERER_URL) {
    void win.loadURL(DEV_RENDERER_URL)
  } else {
    void win.loadFile(path.join(dir, "../renderer/index.html"))
  }
}

// Live-reload settings.json when it changes (GUI write or hand-edit).
function startSettingsWatcher() {
  const p = settingsPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  watch(p, { ignoreInitial: true }).on("all", () => {
    mainWindow?.webContents.send("settings-changed")
  })
}

// ── agent observability (M6) ───────────────────────────────────────
// Start the file-drop watcher + write the scoped settings file(s). Best-effort: on any
// failure the board just stays empty (never blocks startup or the terminal). Claude writes
// each event as a file into `hook-events/`; the watcher reads + deletes them (agent-hooks).
// No ports/networking — so nothing can go stale, and it crosses the WSL boundary.
async function startAgentObservability(): Promise<void> {
  try {
    const cfg = configDir()
    // Per-launch nonce as the drop-dir name: a foreign local process can't guess where to
    // drop spoofed events (restores the auth boundary the old token gave), and it clears any
    // stale drops from a previous run for free. Wipe the parent so old nonces don't pile up.
    const eventsRoot = path.join(cfg, "hook-events")
    fs.rmSync(eventsRoot, { recursive: true, force: true })
    const eventsDir = path.join(eventsRoot, randomUUID())
    fs.mkdirSync(eventsDir, { recursive: true })
    hookWatcher = await startHookWatcher({
      dir: eventsDir,
      onBatch: (events: AgentEvent[]) => {
        // Fold the batch into the resume ledger (which pane is inside which Claude session,
        // + its WSL distro) and tag each event lead/nested from it, then forward it at once
        // (keeps the board live). Token totals are priced from the transcripts afterwards,
        // async and incremental — off the terminal hot path and the agent's loop.
        for (const ev of events) {
          // Session lifecycle only (never per-tool events): traceable when resume goes wrong.
          if (TRACED_HOOKS.has(ev.event)) diag("hook", hookTrace(ev))
          const r = sessionLedger().apply(
            ev,
            ev.paneId ? sessions.get(ev.paneId)?.wslDistro : undefined,
          )
          if (r.verdict) diag(`hook-cwd-${r.verdict}`, hookTrace(ev))
          // The renderer's graph takes the ledger's folder: a replaced one is rewritten, a
          // rejected one dropped (the graph keeps what it knew) — no second classifier there.
          if (r.verdict === "fallback") ev.cwd = r.cwd
          else if (r.verdict === "rejected") ev.cwd = undefined
          // One classifier for "who leads this pane": the ledger. Tag every root event so the
          // graph and the accent agree (and survive a renderer reload — the ledger lives here).
          if (ev.paneId && !ev.agentId)
            ev.nested = sessionLedger().isNested(ev.paneId, ev.sessionId)
        }
        mainWindow?.webContents.send("agents:events", events)
        // Session-level events locate each Claude pane's transcript → track its /color and
        // /rename for the pane accent (async + debounced; SessionEnd stops it).
        for (const ev of events) {
          if (!ev.paneId || !ev.transcriptPath || ev.agentId) continue
          // Only the pane's own session (this event's own verdict, not the state after the whole
          // batch): a background agent inherits the pane but mustn't take its accent.
          if (ev.nested) continue
          if (ev.event === "SessionEnd") agentMeta.untrack(ev.paneId, true, ev.transcriptPath)
          else
            agentMeta.track(
              ev.paneId,
              ev.transcriptPath,
              transcriptTargets(ev.transcriptPath, ev.paneId),
            )
        }
        void tokenEventsForBatch(agentTokens, events, transcriptTargets).then((tokenEvents) => {
          if (tokenEvents.length) mainWindow?.webContents.send("agents:events", tokenEvents)
        })
      },
    })
    // Native settings: the drop dir as a host path.
    const nativePath = path.join(cfg, "claude-hooks.json")
    fs.writeFileSync(nativePath, buildHookSettings(eventsDir))
    hookSettingsPath = nativePath
    // WSL variant (Windows only): same physical dir, addressed via /mnt/c so an in-WSL
    // `claude` can write into it. SMTERM_CLAUDE_SETTINGS is WSLENV-forwarded with /p, so
    // this file's Windows path is translated for claude to read.
    const mnt = process.platform === "win32" ? winToMnt(eventsDir) : null
    if (mnt) {
      const wslPath = path.join(cfg, "claude-hooks.wsl.json")
      fs.writeFileSync(wslPath, buildHookSettings(mnt))
      hookSettingsPathWsl = wslPath
    }
    diag("agent-hooks-up", { dir: eventsDir })
  } catch (err) {
    diag("agent-hooks-failed", { err: String(err) })
  }
}

// ── settings.json (source of truth) ────────────────────────────────
function settingsPath(): string {
  return path.join(configDir(), "settings.json")
}

/** ~/.config/smterm (%APPDATA%\smterm on Windows) — `smterm-<profile>` for another profile. */
function configDir(): string {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA ?? os.homedir(), PROFILE_NAMES.appName)
    : path.join(os.homedir(), ".config", PROFILE_NAMES.appName)
}

// The window's native background (shown before the renderer paints and in unpainted
// areas while resizing) follows the theme; persisted so the NEXT launch opens right.
const DEFAULT_WINDOW_BG = "#0b0b0d"
const isHexColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v)
function windowBgPath(): string {
  return path.join(configDir(), "window-bg")
}
function readWindowBg(): string {
  try {
    const v = fs.readFileSync(windowBgPath(), "utf8").trim()
    return isHexColor(v) ? v : DEFAULT_WINDOW_BG
  } catch {
    return DEFAULT_WINDOW_BG
  }
}

function workspacePath(): string {
  return path.join(configDir(), "workspace.json")
}

function readSettings(): string {
  try {
    return fs.readFileSync(settingsPath(), "utf8")
  } catch {
    return ""
  }
}

function writeSettings(contents: string): void {
  const p = settingsPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contents)
}

function registerIpc() {
  // PTY — one node-pty per session; stream output back over pty:data:<id>. When a
  // reloaded renderer asks to spawn a session that's already live, REATTACH: rebind
  // output to the new renderer and replay recent history, rather than respawn.
  ipcMain.handle(
    "pty:spawn",
    (
      event,
      opts: {
        id: string
        cols: number
        rows: number
        shell: string
        args: string[]
        cwd?: string
        bg?: string
      },
    ): { reattached: boolean; integrated: boolean } => {
      if (draining()) throw new Error("smterm is quitting") // nothing new may outlive the drain
      const existing = sessions.get(opts.id)
      if (existing) {
        // Reattach: point output at the new renderer, drop stale in-flight bytes
        // (they're in the buffer), resize to the new xterm, then replay history.
        existing.sender = event.sender
        existing.coalescer?.reset()
        try {
          existing.proc.resize(opts.cols || 80, opts.rows || 24)
        } catch {
          // transient 0-size during layout — a later resize settles it
        }
        emit(existing, existing.buffer.dump())
        diag("pty-reattach", { id: opts.id, pid: existing.proc.pid })
        return { reattached: true, integrated: existing.integrated }
      }

      const shellCmd = opts.shell || defaultShell()
      // WSL: the Linux shell runs inside wsl.exe. Drive the Linux start dir via wsl's
      // own --cd (home unless we have a tracked Linux path); inject our integration
      // INSIDE WSL (best-effort → OSC-133 status + OSC-7 cwd); launch wsl.exe from a
      // valid Windows dir. Local shells inject the usual way.
      const wsl = isWslShell(shellCmd)
      const inj = wsl ? buildWslInjection(opts.args ?? []) : buildInjection(shellCmd)
      const wslArgs = wsl ? wslCdArgs(opts.cwd) : []
      const startCwd = !wsl && opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir()
      // Shared-history opt-out: the injected scripts default SHARE_HISTORY on; pass
      // SMTERM_SHARE_HISTORY=0 to disable. (For WSL, wslInjection lists it in $WSLENV
      // so it crosses the boundary.)
      const spawnEnv = { ...process.env, ...(inj?.env ?? {}) } as Record<string, string>
      if (!shareHistoryEnabled()) spawnEnv.SMTERM_SHARE_HISTORY = "0"
      // Tell agents (Claude Code, vim, …) our light/dark background via COLORFGBG — the
      // fallback when the OSC-11 background query can't complete in time (notably across
      // the wsl.exe hop). WSL forwards it over $WSLENV (listed in wslInjection).
      const fgbg = opts.bg ? colorfgbg(opts.bg) : null
      if (fgbg) spawnEnv.COLORFGBG = fgbg
      // Let the injected `claude` wrapper route through our scoped hook settings, and tag
      // this pane so the agents board knows which pane each session runs in (M6). WSL panes
      // use the /mnt/c-addressed variant; wslInjection forwards both vars over WSLENV (the
      // settings path with /p so its Windows form is translated for claude inside WSL).
      if (hookSettingsPath) {
        spawnEnv.SMTERM_CLAUDE_SETTINGS = wsl
          ? (hookSettingsPathWsl ?? hookSettingsPath)
          : hookSettingsPath
        spawnEnv.SMTERM_PANE_ID = opts.id
      }
      const proc = pty.spawn(shellCmd, [...(opts.args ?? []), ...wslArgs, ...(inj?.args ?? [])], {
        name: "xterm-256color",
        cols: opts.cols || 80,
        rows: opts.rows || 24,
        cwd: startCwd,
        env: spawnEnv,
      })
      const coalesce = process.env.SMTERM_NO_COALESCE !== "1"
      let markExited!: () => void
      const exited = new Promise<void>((res) => (markExited = res))
      const live: Drainable = { kill: (sig) => proc.kill(sig), exited }
      livePtys.add(live)
      const rec: PtySession = {
        id: opts.id,
        proc,
        buffer: new OutputBuffer(PTY_REPLAY_BYTES),
        sender: event.sender,
        shell: shellCmd,
        // Remember a WSL pane's distro so a hook event tagged with this pane resolves its
        // Linux transcript path against the right distro's UNC share (not just the default).
        wslDistro: wsl ? (parseWslDistroArg(opts.args ?? []) ?? defaultWslDistro()) : undefined,
        integrated: !!inj,
        live,
      }
      if (coalesce) {
        rec.coalescer = new OutputCoalescer(PTY_FLUSH_MS, PTY_MAX_FLUSH_BYTES, (d) => emit(rec, d))
      }
      proc.onData((data) => {
        rec.buffer.push(data) // keep for replay on reattach
        if (rec.coalescer) rec.coalescer.push(data)
        else emit(rec, data) // A/B baseline: one IPC message per node-pty chunk
      })
      proc.onExit((e) => {
        diag("pty-exit", { id: opts.id, code: e.exitCode, signal: e.signal ?? 0 })
        rec.coalescer?.flush() // don't lose the final output
        sessions.delete(opts.id)
        agentMeta.untrack(opts.id) // shell (and any claude in it) gone — drop the accent
        sessionLedger().drop(opts.id) // …and nothing to resume there (no-op during a quit)
        livePtys.delete(live)
        markExited()
      })
      sessions.set(opts.id, rec)
      diag("pty-spawn", { id: opts.id, pid: proc.pid, shell: path.basename(shellCmd) })
      return { reattached: false, integrated: !!inj }
    },
  )
  ipcMain.on("pty:write", (_e, id: string, data: string) => sessions.get(id)?.proc.write(data))
  ipcMain.on("pty:resize", (_e, id: string, cols: number, rows: number) => {
    try {
      sessions.get(id)?.proc.resize(cols, rows)
    } catch {
      // ignore transient 0-size during layout
    }
  })
  // Explicit kill (pane/tab closed) — really terminate + free the replay buffer.
  ipcMain.on("pty:kill", (_e, id: string) => {
    agentMeta.untrack(id, false) // the pane is gone — nothing left to accent
    sessionLedger().drop(id) // closed on purpose — don't resume its Claude session
    const rec = sessions.get(id)
    if (!rec) return
    rec.coalescer?.dispose()
    rec.buffer.clear()
    rec.live.killed = true // hung up below: a quit waits for it without signalling again
    sessions.delete(id)
    try {
      rec.proc.kill()
    } catch {
      // already gone
    }
  })

  // Shells — per-OS defaults + WSL distro enumeration.
  ipcMain.handle("shells:list", async () => listShells())

  // Frameless window controls.
  ipcMain.on("window:minimize", () => mainWindow?.minimize())
  ipcMain.on("window:maximize", () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.on("window:close", () => app.quit()) // single-window app: close ⇒ quit (guarded)
  ipcMain.on("window:set-background", (_e, color: unknown) => {
    if (!isHexColor(color)) return
    mainWindow?.setBackgroundColor(color)
    try {
      if (readWindowBg() !== color) {
        fs.mkdirSync(configDir(), { recursive: true })
        fs.writeFileSync(windowBgPath(), color)
      }
    } catch {
      // best-effort — the next launch just opens with the default bg
    }
  })
  // Resume on relaunch: what to type into each restored terminal (live PTYs = a renderer
  // reload → skipped). Entries for panes no longer in the workspace are pruned.
  ipcMain.handle("agents:resume-plan", async (_e, paneIds: string[], allowBypass: boolean) => {
    if (!Array.isArray(paneIds)) return {}
    const l = sessionLedger()
    l.prune(new Set(paneIds))
    return l.plan(
      paneIds,
      (id) => sessions.has(id),
      // Async + host paths only; bounded. A WSL path isn't checked (a cold share could block
      // or wrongly say "gone") and a stat that times out (a hung network mount) means "can't
      // check" — claude itself reports a missing session, the banner handles that, and the
      // renderer won't use an unverified path as a spawn cwd (spawn's own check would hang).
      async (e) => {
        if (e.wslDistro || (process.platform === "win32" && e.cwd.startsWith("/"))) {
          return { unverified: true }
        }
        const within = <T>(p: Promise<T>) =>
          Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), 1500))])
        const cwdOk = await within(pathExists("/", e.cwd))
        if (cwdOk === false) return { skip: "its folder is gone" }
        if (cwdOk === undefined) return { unverified: true }
        if (e.transcriptPath && (await within(pathExists("/", e.transcriptPath))) === false) {
          return { skip: "its transcript is gone" }
        }
        return {}
      },
      allowBypass === true,
    )
  })
  // The pane's shell prompt came back after a command → its foreground program (Claude or
  // not) has exited: nothing to resume there even if Claude died without a SessionEnd.
  ipcMain.on("agents:shell-idle", (_e, paneId: string) => sessionLedger().shellIdle(paneId))
  // One shot per session: attempted (or dismissed) → forget it.
  ipcMain.on("agents:resume-consume", (_e, paneId: string, sessionId: string) =>
    sessionLedger().consume(paneId, sessionId),
  )
  // A (re)loaded renderer starts with no accents: hand it every tracked pane's current meta.
  ipcMain.handle("agents:meta-snapshot", async () => agentMeta.snapshot())
  ipcMain.handle("window:is-maximized", async () => mainWindow?.isMaximized() ?? false)

  // Git — working-tree status + per-file diff for the changes panel.
  // Branch + PR per terminal for the sidebar (cached/deduped; gh = the user's own login).
  ipcMain.handle("pane:git-info", async (_e, reqs: PaneGitRequest[]) =>
    Array.isArray(reqs) ? paneGit.lookup(reqs.slice(0, 64)) : {},
  )
  ipcMain.handle("git:status", async (_e, cwd: string, wsl?: { distro?: string }) =>
    gitStatus(cwd, wsl),
  )
  ipcMain.handle("git:diff", async (_e, cwd: string, file: string, wsl?: { distro?: string }) =>
    gitDiff(cwd, file, wsl),
  )

  // Perf: process CPU/memory metrics + whether we're in load-test mode.
  ipcMain.handle("app:metrics", async () =>
    app.getAppMetrics().map((m) => ({
      type: m.type,
      pid: m.pid,
      cpu: m.cpu?.percentCPUUsage ?? 0,
      memoryKB: m.memory?.workingSetSize ?? 0,
    })),
  )
  ipcMain.handle("app:perf-mode", async () => process.env.SMTERM_PERF === "1")

  // Version + best-effort update check for the status-bar badge (off any hot path).
  ipcMain.handle("app:version", async () => app.getVersion())
  ipcMain.handle("app:check-update", async () => checkForUpdate(app.getVersion()))

  // Platform label for the status bar (macOS / Windows / Linux).
  ipcMain.handle("platform:info", async () => {
    const label =
      process.platform === "darwin" ? "macOS" : process.platform === "win32" ? "Windows" : "Linux"
    return {
      platform: process.platform,
      label,
      release: os.release(),
      home: os.homedir(),
      profile: PROFILE_NAMES.label, // "" for the installed app's profile
    }
  })

  // Settings.
  ipcMain.handle("settings:read", async () => readSettings())
  ipcMain.handle("settings:write", async (_e, contents: string) => writeSettings(contents))
  ipcMain.handle("settings:path", async () => settingsPath())

  // Workspace (persisted layout for VS Code-style restore).
  ipcMain.handle("workspace:read", async () => {
    try {
      return fs.readFileSync(workspacePath(), "utf8")
    } catch {
      return ""
    }
  })
  ipcMain.handle("workspace:write", async (_e, contents: string) => {
    try {
      fs.mkdirSync(configDir(), { recursive: true })
      fs.writeFileSync(workspacePath(), contents)
    } catch {
      // best-effort
    }
  })

  // Clipboard (copy/paste) — main owns it; renderer never imports Electron.
  ipcMain.on("clipboard:write", (_e, text: string) => clipboard.writeText(text))
  ipcMain.handle("clipboard:read", async () => clipboard.readText())

  // Files browser: list ONE directory (lazy — never a recursive walk). Sorting /
  // .git-filter / cap live in the pure, tested lib/dir-listing; here we just gather
  // entries (resolving symlinked dirs via stat so they browse, not open as files).
  ipcMain.handle("fs:readdir", async (_e, dir: string, wsl?: WslContext) => {
    // A WSL pane's dir is a Linux path the host can't see — read it through the distro's
    // UNC share instead (wslTargets); non-WSL panes read the host path.
    for (const target of wslTargets(dir, wsl)) {
      try {
        const ents = await fs.promises.readdir(target, { withFileTypes: true })
        const raw = await Promise.all(
          ents.map(async (e) => {
            let isDir = e.isDirectory()
            if (e.isSymbolicLink()) {
              // isDirectory() is false for a symlink even when it targets a dir — stat
              // the target so a symlinked directory expands instead of opening.
              try {
                isDir = (await fs.promises.stat(path.join(target, e.name))).isDirectory()
              } catch {
                // dangling link → treat as a file
              }
            }
            return { name: e.name, isDir }
          }),
        )
        return toDirListing(raw)
      } catch {
        // this candidate didn't resolve (wrong share form, or unreadable) — try the next
      }
    }
    return { entries: [], truncated: false }
  })

  // Read a file for the preview popup: guard the size, read up to the cap, and
  // classify text vs binary. Best-effort — any failure returns an error kind.
  ipcMain.handle(
    "fs:read-preview",
    async (_e, p: string, wsl?: WslContext): Promise<PreviewData> => {
      // A WSL pane's path is a Linux path the host can't open — read it through the distro's
      // UNC share instead (wslTargets), like fs:readdir. Non-WSL reads the host path.
      let lastErr = "not found"
      for (const target of wslTargets(p, wsl)) {
        try {
          const st = await fs.promises.stat(target)
          if (!st.isFile()) return { kind: "error", message: "Not a file" }
          const size = st.size
          if (size > PREVIEW_MAX_SIZE) return { kind: "too-large", size }
          const len = Math.min(size, PREVIEW_READ_CAP)
          const buf = Buffer.alloc(len)
          let bytesRead = 0
          const fh = await fs.promises.open(target, "r")
          try {
            if (len > 0) ({ bytesRead } = await fh.read(buf, 0, len, 0))
          } finally {
            await fh.close()
          }
          // Only the bytes actually read — a short read must not leave zero-filled tail
          // (→ false 'binary'), and the decoder must not see it (→ trailing garbage).
          const chunk = buf.subarray(0, bytesRead)
          const meta = classifyPreview(size, bytesRead, chunk.includes(0))
          if (meta.kind === "binary") return { kind: "binary", size }
          // StringDecoder drops a dangling multi-byte sequence at the truncation boundary
          // (never .end()ed) instead of emitting a � replacement char.
          const text = new StringDecoder("utf8").write(chunk)
          return { kind: "text", text, truncated: meta.truncated, size }
        } catch (err) {
          lastErr = String(err) // try the next share form
        }
      }
      return { kind: "error", message: lastErr }
    },
  )

  // Native folder picker for the Files-panel root; returns null if cancelled.
  ipcMain.handle("dialog:pick-directory", async (_e, defaultPath?: string, wsl?: WslContext) => {
    try {
      // On a WSL pane the dialog can only browse host-visible paths, so open it at the
      // current root's UNC share and translate the picked UNC path back to its Linux form
      // — keeping the tree/breadcrumb/git decorations distro-native (consistent with the
      // crumb + double-click reroot paths).
      const dp = wsl && defaultPath ? (wslTargets(defaultPath, wsl)[0] ?? defaultPath) : defaultPath
      const opts: Electron.OpenDialogOptions = {
        properties: ["openDirectory"],
        ...(dp ? { defaultPath: dp } : {}),
      }
      const res = await (mainWindow
        ? dialog.showOpenDialog(mainWindow, opts)
        : dialog.showOpenDialog(opts))
      const picked = res.canceled ? null : (res.filePaths[0] ?? null)
      return picked && wsl ? (uncToWslPath(picked) ?? picked) : picked
    } catch {
      return null // e.g. window destroyed mid-dialog — never throw into Electron
    }
  })
  // Validate a typed path is an existing directory (Files-panel root entry).
  ipcMain.handle("fs:is-dir", async (_e, p: string, wsl?: WslContext) => {
    // WSL-aware (like readdir/read-preview): a WSL pane's Linux path is checked through the
    // distro's UNC share, so the typed-path reroot validates instead of always failing.
    for (const target of wslTargets(p, wsl)) {
      try {
        if ((await fs.promises.stat(target)).isDirectory()) return true
      } catch {
        // try the next share form
      }
    }
    return false
  })

  // Links + notifications.
  ipcMain.on("open-external", (_e, url: string) => void shell.openExternal(url))
  ipcMain.on("open-path", (_e, p: string) => void shell.openPath(p))
  ipcMain.on("notify", (_e, title: string, body: string) => {
    if (Notification.isSupported()) new Notification({ title, body }).show()
  })

  // Clickable file links: validate a detected path exists, and open a clicked one.
  ipcMain.handle("fs:path-exists", async (_e, cwd: string, p: string) => pathExists(cwd, p))
  ipcMain.on("file:open", (_e, cwd: string, file: string, line?: number, col?: number) =>
    openFile(cwd, file, line, col),
  )
  // Reveal a file/folder in the OS file manager (Finder/Explorer/etc.) — always works,
  // no editor/PATH dependency, so the file context menu can rely on it.
  ipcMain.on("file:reveal", (_e, p: string) => shell.showItemInFolder(p))
  // Can the configured editor actually open a file? Drives the menu label/enabled state.
  ipcMain.handle("editor:info", async (): Promise<EditorInfo> => {
    const plan = resolveEditor()
    return { available: plan.kind !== "none", name: plan.name }
  })
}

// Expand a leading ~ and resolve relative to cwd → absolute host path.
function resolveHostPath(cwd: string, p: string): string {
  const expanded = p.startsWith("~/") || p === "~" ? path.join(os.homedir(), p.slice(1)) : p
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded)
}

// Does a detected path exist on the host fs? (The false-positive filter for links.)
async function pathExists(cwd: string, p: string): Promise<boolean> {
  try {
    await fs.promises.stat(resolveHostPath(cwd, p))
    return true
  } catch {
    return false
  }
}

// The editor-command template for clicked links (reads settings.json live).
function openPathTemplate(): string {
  try {
    const s = JSON.parse(readSettings() || "{}") as { openPath?: string }
    return typeof s.openPath === "string" ? s.openPath : "code -g {file}:{line}:{col}"
  } catch {
    return "code -g {file}:{line}:{col}"
  }
}

// Is `cmd` an executable on the current PATH? (absolute paths checked directly).
// process.env carries the login-shell PATH imported at startup (shell-env.ts).
function commandOnPath(cmd: string): boolean {
  const test = (p: string) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  }
  if (path.isAbsolute(cmd)) return test(cmd)
  const exts =
    process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""]
  for (const d of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!d) continue
    for (const ext of exts) if (test(path.join(d, cmd + ext))) return true
  }
  return false
}

// macOS only: the best installed editor .app to `open -a`, checking both the
// system and per-user app folders (auto-updaters often land in ~/Applications).
function macAppFor(cmd: string): { name: string; app: string } | null {
  if (process.platform !== "darwin") return null
  const dirs = ["/Applications", path.join(os.homedir(), "Applications")]
  for (const e of orderMacEditors(cmd)) {
    if (dirs.some((d) => fs.existsSync(path.join(d, `${e.app}.app`)))) {
      return { name: e.name, app: e.app }
    }
  }
  return null
}

// Resolve the open strategy via the pure planEditor (probes injected). Memoised with
// a short TTL: bounds the synchronous PATH walk to ~once per window on rapid clicks,
// while still noticing an editor installed mid-session within a few seconds.
let editorPlanCache: { template: string; at: number; plan: EditorPlan } | null = null
const EDITOR_PLAN_TTL_MS = 3000
function resolveEditor(): EditorPlan {
  const template = openPathTemplate().trim()
  const now = Date.now()
  if (
    editorPlanCache &&
    editorPlanCache.template === template &&
    now - editorPlanCache.at < EDITOR_PLAN_TTL_MS
  ) {
    return editorPlanCache.plan
  }
  const plan = planEditor(template, { onPath: commandOnPath, macAppFor })
  editorPlanCache = { template, at: now, plan }
  return plan
}

// Open a file in the configured editor. Falls back to revealing it in the OS file
// manager when no editor is available or the launch fails — so a click always does
// something visible (never the silent no-op of shell.openPath on a source file).
function openFile(cwd: string, file: string, line?: number, col?: number): void {
  const abs = resolveHostPath(cwd, file)
  const reveal = () => shell.showItemInFolder(abs)
  const plan = resolveEditor()
  try {
    if (plan.kind === "osDefault") {
      void shell.openPath(abs)
      return
    }
    if (plan.kind === "none") {
      reveal()
      return
    }
    // On Windows, editors are `.cmd` shims that `spawn` can't exec without a shell.
    const isWin = process.platform === "win32"
    const [cmd, args] =
      plan.kind === "macApp"
        ? (["open", ["-a", plan.app, abs]] as const)
        : (() => {
            const built = buildEditorCommand(openPathTemplate(), { file: abs, line, col })!
            return [built.cmd, isWin ? built.args.map(winQuote) : built.args] as const
          })()
    const child = spawn(cmd, args as string[], {
      detached: true,
      stdio: "ignore",
      env: process.env,
      shell: isWin && plan.kind === "template",
      windowsHide: true,
    })
    child.on("error", reveal) // launch failed → reveal instead of a silent no-op
    child.unref()
  } catch {
    reveal()
  }
}

// App identity. Packaged builds get this from the bundle (electron-builder productName),
// but in dev the app runs from Electron.app, so the dock/menu read "Electron" unless we
// set it here. AppUserModelId groups the taskbar + routes notifications on Windows.
// Per profile (a dev build is `smterm-dev`): the user-data dir — and with it the
// single-instance lock and localStorage — is the profile's own, unless the caller chose one.
// The AppUserModelId stays shared: on Windows toasts only show for an id a Start Menu
// shortcut registers, and only the installer's (com.smterm.app) exists.
app.setName(displayName(PROFILE_NAMES)) // the menu / About name: "smterm (dev)", like the window
app.setAppUserModelId("com.smterm.app")
if (!app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(app.getPath("appData"), PROFILE_NAMES.appName))
}

// Single-instance guard. A second launch — an update-relaunch racing the old process, or
// a stray double-click — would start a SECOND hook receiver on a different ephemeral port
// and overwrite the shared claude-hooks.json. When the port-owning instance quits, the
// survivor's Claude sessions keep POSTing to the now-dead port → `connect ECONNREFUSED`
// on every hook, spamming the agent's output. Hold a lock: the second instance just focuses
// the running window and quits, so there's always exactly one receiver / one config writer.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()
app.on("second-instance", () => {
  if (!mainWindow || draining()) return // quitting: don't resurface a window whose shells are ending
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return // second instance — it's quitting; start nothing
  // GUI-launched apps (Finder/Dock) inherit a bare launchd PATH, so shells can't find
  // Homebrew/cargo tools (starship, etc.). Import the login shell's real env before any
  // PTY spawns. Only when packaged — in dev the app is launched from a terminal that
  // already has the full env, so this cost (~one shell invocation) is skipped.
  if (process.platform !== "win32" && app.isPackaged) {
    applyLoginShellEnv(defaultShell())
    scrubParentInstanceEnv(process.env) // the import adds any var we lack — these too
  }
  // macOS dock icon: packaged builds get it from the .app bundle, but `make run` (dev)
  // shows the default Electron icon unless we set it here.
  if (process.platform === "darwin") {
    const icon = appIcon()
    if (icon) app.dock?.setIcon(icon)
  }
  registerIpc()
  // Start the hook receiver BEFORE the window so hookSettingsPath is set before the
  // renderer can request the first pty:spawn — otherwise the initial pane launches
  // without SMTERM_CLAUDE_SETTINGS and the `claude` wrapper never arms (M6).
  await startAgentObservability()
  createWindow()
  startSettingsWatcher()
  diag("boot", { pid: process.pid, version: app.getVersion() })
  // Power events tell us whether a lid-close SUSPENDS the app (suspend→resume with
  // PTYs intact) or the OS TERMINATES it (suspend, then a fresh boot with no quit).
  // `.on` is overloaded per event-name literal; cast to a plain-string signature so
  // we can register them in a loop.
  const onPower = powerMonitor.on.bind(powerMonitor) as (e: string, cb: () => void) => void
  for (const ev of ["suspend", "resume", "lock-screen", "unlock-screen", "shutdown"]) {
    onPower(ev, () => diag(`power-${ev}`, { ptys: sessions.size }))
  }
  // OS shutdown / restart / logout: Electron skips before-quit (notably on Windows), so freeze
  // the resume ledger here too — else the dying children's SessionEnds/exits would clear it,
  // and a reboot is exactly when resuming matters.
  // No PTY drain here: a shutdown can be cancelled, and the app must stay usable then. A real
  // quit (macOS logout sends terminate → before-quit) drains.
  onPower("shutdown", () => {
    sessionLedger().freeze(60_000) // thaws if the shutdown is cancelled
    osEnding = true // its quit mustn't be held (see quit-plan.ts)…
    setTimeout(() => (osEnding = false), 60_000) // …unless it was cancelled
  })
  app.on("activate", () => {
    if (draining()) return // quitting: a fresh window's panes couldn't spawn
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  diag("window-all-closed", { platform: process.platform })
  if (process.platform !== "darwin") app.quit()
})

app.on("will-quit", () => {
  diag("will-quit", { ptys: sessions.size })
  agentMeta.dispose() // close transcript watchers
  void hookWatcher?.close() // stop the file-drop watcher
})
app.on("quit", () => diag("quit"))

/** Quit only: end every live PTY and wait for its exit (bounded) — see pty-drain.ts. */
/** OS logout/restart: end every PTY without holding the quit (a hold reads as "cancelled"). */
function killNow(): void {
  sessionLedger().freeze()
  for (const rec of sessions.values()) rec.coalescer?.dispose()
  for (const p of livePtys) {
    try {
      if (!p.killed) p.kill()
    } catch {
      // already gone
    }
  }
}

function shutdownPtys(): Promise<void> {
  if (!shutdown) {
    // Keep every "inside Claude" entry for the relaunch BEFORE our kill makes Claude fire
    // SessionEnd (which would otherwise clear them).
    sessionLedger().freeze()
    for (const rec of sessions.values()) rec.coalescer?.dispose()
    const count = livePtys.size
    const win32 = process.platform === "win32"
    shutdown = drainPtys([...livePtys], {
      signals: !win32,
      settleMs: win32 ? 300 : 0,
    }).then((clean) => {
      diag("ptys-drained", { count, clean })
      sessions.clear()
    })
  }
  return shutdown
}
let shutdown: Promise<void> | null = null

// Is the quit-confirmation prompt enabled? (reads settings.json live)
function confirmQuitEnabled(): boolean {
  try {
    return (JSON.parse(readSettings() || "{}") as { confirmQuit?: boolean }).confirmQuit !== false
  } catch {
    return true
  }
}

// Is cmux-like shared history enabled? (reads settings.json live; default on)
function shareHistoryEnabled(): boolean {
  try {
    return (JSON.parse(readSettings() || "{}") as { shareHistory?: boolean }).shareHistory !== false
  } catch {
    return true
  }
}

// Persist "don't warn again" back into settings.json (merge, best-effort).
function disableConfirmQuit() {
  try {
    const s = JSON.parse(readSettings() || "{}") as Record<string, unknown>
    s.confirmQuit = false
    writeSettings(`${JSON.stringify(s, null, 2)}\n`)
  } catch {
    // best-effort
  }
}

// Guard quit (⌘Q or the close button) when live sessions would be killed.
app.on("before-quit", (e) => {
  const step = quitStep({
    phase: quitPhase,
    confirmed: quitConfirmed,
    needsConfirm: sessions.size > 0 && confirmQuitEnabled() && !!mainWindow,
    livePtys: livePtys.size,
    osEnding,
  })
  diag("before-quit", { ptys: livePtys.size, step })
  if (step === "proceed") return
  if (step === "killNow") return killNow()
  e.preventDefault()
  if (step === "hold") return
  if (step === "drain") {
    // Hold the quit until every PTY has exited (≤ ~2 s), then quit for real.
    quitPhase = "draining"
    mainWindow?.hide() // feels instant while the shells wind down
    void shutdownPtys().finally(() => {
      quitPhase = "drained"
      app.quit()
    })
    return
  }
  if (!mainWindow) return
  const n = sessions.size
  void dialog
    .showMessageBox(mainWindow, {
      type: "warning",
      buttons: ["Cancel", "Quit"],
      defaultId: 1,
      cancelId: 0,
      message: `Quit ${displayName(PROFILE_NAMES)}?`,
      detail: `This closes ${n} running session${n === 1 ? "" : "s"} and their processes.`,
      checkboxLabel: "Don't warn again",
      checkboxChecked: false,
      noLink: true,
    })
    .then(({ response, checkboxChecked }) => {
      if (response !== 1) return // Cancel
      if (checkboxChecked) disableConfirmQuit()
      quitConfirmed = true
      app.quit()
    })
})
