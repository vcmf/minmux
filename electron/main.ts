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
  utilityProcess,
} from "electron"
import { fileURLToPath } from "node:url"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"
import { execFile, spawn } from "node:child_process"
import { randomBytes, randomUUID } from "node:crypto"
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
  parseWslDistros,
  setIntegrationDirName,
} from "./shell-integration"
import { gitStatus, gitDiff } from "./git"
import { OutputCoalescer } from "./coalescer"
import { OutputBuffer } from "./output-buffer"
import { drainPtys, type Drainable, type DrainOptions } from "./pty-drain"
import { AgentProcs, noop, posixProcs } from "./agent-procs"
import { quitStep, type QuitPhase } from "./quit-plan"
import { appendDiag } from "./diagnostics"
import { applyLoginShellEnv } from "./shell-env"
import { buildEditorCommand, winQuote } from "./editor-command"
import { orderMacEditors, planEditor, type EditorPlan, type EditorInfo } from "./editor-detect"
import { checkForUpdate } from "./update-check"
import { startHookWatcher, type DropNormalizer } from "./agent-hooks"
import { AGENT_RULES, createAdapters, type AgentAdapter } from "./agents"
import { AgentLiveness, foldLiveness } from "./agent-liveness"
import { UserNames } from "./agent-names"
import { agentOf, type AgentEvent, type AgentKind } from "../src/lib/agent-graph"
import { disabledAgentsIn, mergeAgentSwitches } from "../src/settings/agent-switches"
import { agentPaneEnv, resumablePanes } from "./agents/arming"
import { findOnPath, pathCandidates } from "./path-lookup"
import { FsWorkerClient, type WorkerProc } from "./fs-worker-client"
import { WATCH_CAP, type DirListing } from "../src/lib/dir-listing"
import { wslUncCandidates, uncToWslPath } from "./wsl-paths"
import { colorfgbg } from "./color"
import { AgentMetaTracker, planMeta } from "./agent-meta"
import { AgentHints } from "./agent-hints"
import { SessionLedger } from "./agent-sessions"
import {
  displayName,
  LEGACY_APP_NAME,
  profileNames,
  resolveProfile,
  scrubParentInstanceEnv,
} from "./profile"
import {
  legacyInstanceRunning,
  markLegacyDirs,
  migrateLegacyDirs,
  pendingLegacyDirs,
} from "./legacy-migrate"
import { PaneGitService } from "./pane-git"
import { SshService } from "./ssh-service"
import { PendingSpawns, type PendingOutcome } from "./pending-spawns"
import {
  HelloWatch,
  handshakeReply,
  integrationFailed,
  remoteBootstrapCommand,
  INTEGRATION_FAILED_NOTE,
} from "./remote-bootstrap"
import { parseReopen } from "../src/lib/remote-reports"
import { createPathWatcher } from "./ssh-watcher"
import { nodeMiniFs, wslMiniFs } from "./ssh-config"
import type { PaneGitRequest } from "../src/lib/pane-git"
import type { WslContext } from "../src/lib/wsl"
import type { SpawnOpts as SpawnRequest } from "../src/types"
import {
  classifyPreview,
  PREVIEW_READ_CAP,
  PREVIEW_MAX_SIZE,
  type PreviewData,
} from "../src/lib/file-preview"

// This process's profile (a dev build is `dev`): picked before anything reads a path. An
// invalid MINMUX_PROFILE stops here, synchronously — before any name, path or lock is set —
// so it can never fall back to (and write into) another profile's data. Then the env is
// scrubbed of what a parent minmux set for its own pane (its hook file, pane id, our profile
// choice), so nothing we spawn — shells, editors, git — inherits it.
const PROFILE_CHOICE = resolveProfile({
  flag: app.commandLine.hasSwitch("profile")
    ? app.commandLine.getSwitchValue("profile")
    : undefined,
  env: process.env.MINMUX_PROFILE ?? process.env.SMTERM_PROFILE, // the old name still picks one
  packaged: app.isPackaged,
})
if ("error" in PROFILE_CHOICE) {
  // macOS / Windows: a blocking error box (+ stderr for a terminal launch). Linux has no
  // dialog before ready — showErrorBox prints to stderr there itself.
  if (process.platform !== "linux") console.error(`minmux: ${PROFILE_CHOICE.error}`)
  dialog.showErrorBox("minmux can't start", PROFILE_CHOICE.error)
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
  coalescer?: OutputCoalescer // absent only in the MINMUX_NO_COALESCE=1 A/B baseline
  shell: string
  wslDistro?: string // for a WSL pane: the distro, so its Linux paths resolve to the right UNC share
  integrated: boolean // our shell integration (OSC 133 marks, claude wrapper) was injected
  live: Drainable // this PTY's entry in livePtys (outlives the session record until onExit)
  hello?: HelloWatch // an integrated ssh pane, until its bootstrap's hello is answered
  pendingNonce?: string // …the nonce it was offered…
  remoteNonce?: string // …and, once the host confirmed it (ok), what its shell's reports carry
}
const sessions = new Map<string, PtySession>()
// Every node-pty that hasn't reported its exit yet — including closed panes still winding
// down (gone from `sessions`). None may outlive Node: quitting drains this (pty-drain.ts).
const livePtys = new Set<Drainable>()
const closingPanes = new Set<Promise<void>>() // closed panes whose agent may still be ending
const agentProcs = new AgentProcs(posixProcs.alive) // per pane: the agents running in it
let mainWindow: BrowserWindow | null = null
// Every coding agent minmux integrates (electron/agents), and the ones armed this launch:
// their files are installed and their hooks write into the per-launch drop root
// (`<root>/<agent>/`, passed to panes as MINMUX_AGENT_EVENTS). Empty ⇒ agents board stays
// empty. Each pane's env carries every armed agent's paths; WSLENV /p translates them for an
// agent inside WSL.
// Whose name each agent session's is (kept per session: the colour survives a resume, D3).
let userNamesStore: UserNames | null = null
const userNames = () =>
  (userNamesStore ??= new UserNames(path.join(configDir(), "agent-names.json")))
void userNames().loaded // read now, async: the first OpenCode title finds it ready
const adapters = createAdapters(process.platform, {
  userNamed: (id) => userNames().has(id),
  setUserNamed: (id, user) => userNames().set(id, user),
})
let armed: AgentAdapter[] = []
let agentEventsDir: string | null = null
let hookWatcher: { close: () => Promise<void> } | null = null
let reaper: ReturnType<typeof setInterval> | null = null // ends sessions whose process is gone
const REAP_MS = 3000
// Branch + GitHub PR per terminal (sidebar), via git + the user's `gh`.
const paneGit = new PaneGitService()
// Per pane, the lead session's name/colour (pane accent, resume banner), one tracker per
// agent that keeps them somewhere: Claude's transcript (`/color`, `/rename`), Codex's index.
const metaTrackers = new Map<AgentKind, AgentMetaTracker>()
for (const a of adapters) {
  if (!a.meta) continue
  const kind = a.kind
  const tracker = new AgentMetaTracker(
    (paneId, meta, sessionId) => {
      // An automatic name with no colour changes nothing on screen (D3): only the ledger
      // wants it — skip the IPC and the panes' re-render.
      if (!meta?.auto || meta.color !== undefined)
        mainWindow?.webContents.send("agents:meta", paneId, meta)
      // The name, for the resume banner: only onto the session it's for (a late read, or the
      // null for a session a switch left, must not rename the pane's new lead).
      const lead = sessionLedger().get(paneId)
      if (lead && agentOf(lead) === kind && (!sessionId || lead.sessionId === sessionId))
        sessionLedger().setName(paneId, meta?.name)
    },
    a.meta.watch === false ? () => null : undefined, // not a file: nothing to watch
    undefined,
    a.meta.reader(),
  )
  metaTrackers.set(kind, tracker)
}
// Whether to show an agent's "approve the hooks" hint, persisted (agent-hints.ts).
let hints: AgentHints | null = null
const agentHints = () => (hints ??= new AgentHints(path.join(configDir(), "agent-hints.json")))
/** Stop every agent's meta tracking for a pane (its shell / PTY ended). */
const untrackMeta = (paneId: string, notify = true) =>
  metaTrackers.forEach((t) => t.untrack(paneId, notify))
// Which Claude session each terminal is inside (persisted) → resume on relaunch.
let ledger: SessionLedger | null = null
const sessionLedger = () =>
  (ledger ??= new SessionLedger(path.join(configDir(), "agent-sessions.json")))
let quitConfirmed = false
let quitPhase: QuitPhase = "running" // running → draining (PTYs ending) → drained (quit through)
let osEnding = false // the OS is logging out / restarting — don't hold its quit
const draining = () => quitPhase !== "running"
// Remote spawns in flight (the ssh probe is async): a second pty:spawn for the same id waits,
// and resizes / input / a close that arrive meanwhile are held for it (pending-spawns.ts).
const pendingSpawns = new PendingSpawns<Electron.WebContents>()
let sshService: SshService | null = null

// PTY output batching (see electron/coalescer.ts + docs/PERF.md).
const PTY_FLUSH_MS = 4
const PTY_MAX_FLUSH_BYTES = 256 * 1024
// Recent output kept per session for replay when a reloaded renderer reattaches.
const PTY_REPLAY_BYTES = 256 * 1024

// Session lifecycle only (rare; never per-tool events or cwd changes): enough to trace resume.
const TRACED_HOOKS = new Set(["SessionStart", "SessionEnd", "WorktreeCreate"])
/** The armed adapter an event (or ledger entry) belongs to. */
const adapterFor = (x: { agent?: AgentKind }): AgentAdapter | undefined =>
  armed.find((a) => a.kind === agentOf(x))
/** A hook event's diagnostics fields: which session, from which pane, where. */
function hookTrace(ev: AgentEvent): Record<string, string> {
  return {
    ev: ev.event,
    agent: agentOf(ev),
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

// The files browser's folder reads run in a utility process (fs-worker): a read stuck on a dead
// mount ties up its threads, never main's, and it's killed and replaced when one hangs.
const fsWorker = new FsWorkerClient(
  () =>
    utilityProcess.fork(path.join(dir, "fs-worker.js"), [], {
      serviceName: "minmux fs",
      stdio: "ignore",
    }) as unknown as WorkerProc,
)
// A watched folder changed: the renderer re-reads it (through its read queue).
fsWorker.onChanged = (dirs) => mainWindow?.webContents.send("fs:changed", dirs)

/** Does the folder holding `p` still exist? Then a missing `p` was deleted — not an
 *  unmounted share (/Volumes/NAS gone) or a stopped WSL distro, whose parents are gone too.
 *  "stuck" when asking hung (a dead mount). */
async function parentExists(p: string): Promise<"yes" | "no" | "stuck"> {
  const parent = path.dirname(p)
  if (parent === p) return "no"
  try {
    await fsWorker.call({ op: "stat", path: parent })
    return "yes"
  } catch (e) {
    const code = (e as { code?: string }).code
    return code === "EHUNG" || code === "EBUSY" ? "stuck" : "no"
  }
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
  // Main owns the title ("minmux (dev)"): index.html's <title> would reset it on load.
  win.on("page-title-updated", (e) => e.preventDefault())
  win.on("session-end", () => sessionLedger().freeze(60_000)) // Windows logout/shutdown — see onPower
  win.on("closed", () => {
    mainWindow = null
    fsWorker.setWatched([])
  })
  // A reloaded or crashed renderer re-sends its watch set when its Files panel shows again.
  win.webContents.on("did-start-loading", () => fsWorker.setWatched([]))
  win.webContents.on("render-process-gone", () => fsWorker.setWatched([]))

  // Tell the renderer when maximize state changes (custom controls swap icon).
  const sendMax = () => win.webContents.send("window:maximize-change", win.isMaximized())
  win.on("maximize", sendMax)
  win.on("unmaximize", sendMax)

  // Load-test mode: surface the renderer's [PERF] report lines on stdout.
  if (process.env.MINMUX_PERF === "1") {
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
    switchesOff = null // re-read the agent switches on the next spawn
    mainWindow?.webContents.send("settings-changed")
    sshService?.settingsChanged() // reloads only if the ssh block itself changed
  })
}

// ── agent observability (M6) ───────────────────────────────────────
// Start the file-drop watcher + write the scoped settings file(s). Best-effort: on any
// failure the board just stays empty (never blocks startup or the terminal). Each agent's
// hooks write every event as a file into `hook-events/<nonce>/<agent>/`; the watcher reads +
// deletes them (agent-hooks).
// No ports/networking — so nothing can go stale, and it crosses the WSL boundary.
async function startAgentObservability(): Promise<void> {
  try {
    const cfg = configDir()
    // Per-launch nonce as the drop-dir name: a foreign local process can't guess where to
    // drop spoofed events (restores the auth boundary the old token gave), and it clears any
    // stale drops from a previous run for free. Wipe the parent so old nonces don't pile up.
    // Hooks find it via the pane env (MINMUX_AGENT_EVENTS), so an agent still carrying an
    // earlier launch's env (a tmux server started from an old pane) reports nothing; before,
    // its events arrived tagged with a pane that no longer exists.
    const eventsRoot = path.join(cfg, "hook-events")
    fs.rmSync(eventsRoot, { recursive: true, force: true })
    const eventsDir = path.join(eventsRoot, randomUUID())
    fs.mkdirSync(eventsDir, { recursive: true })
    // Arm each agent on its own: one that fails to install stays off, the others still work.
    const ready: AgentAdapter[] = []
    for (const a of adapters) {
      try {
        fs.mkdirSync(path.join(eventsDir, a.kind))
        a.install(cfg)
        ready.push(a)
      } catch (err) {
        diag("agent-install-failed", { agent: a.kind, err: String(err) })
      }
    }
    if (ready.length === 0) {
      diag("agent-hooks-none", {}) // nothing armed: plain terminals, empty board
      return
    }
    armed = ready // before the watcher: its first batch looks adapters up here
    const normalizers: Partial<Record<AgentKind, DropNormalizer>> = {}
    for (const a of ready) normalizers[a.kind] = a.normalize
    const fold = (events: AgentEvent[]) => {
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
        adapterFor(ev)?.observe?.(ev) // state an adapter keeps (OpenCode's pushed names)
        // A pushed name may come before its session leads (a resumed OpenCode's title): the
        // new entry takes it, and whether it's the user's.
        if (ev.event === "SessionStart" && ev.paneId && !ev.agentId) {
          const m = adapterFor(ev)?.metaNow?.(ev.sessionId)
          if (m?.name && sessionLedger().get(ev.paneId)?.sessionId === ev.sessionId)
            sessionLedger().setName(ev.paneId, m.name)
        }
        // One classifier for "who leads this pane": the ledger. Tag every root event so the
        // graph and the accent agree (and survive a renderer reload — the ledger lives here).
        if (ev.paneId && !ev.agentId) ev.nested = sessionLedger().isNested(ev.paneId, ev.sessionId)
      }
      // A title is main's alone (the meta tracker shows it), never a board event.
      mainWindow?.webContents.send(
        "agents:events",
        events.filter((ev) => ev.event !== "SessionTitle"),
      )
      // Session-level events locate where each pane's session keeps its name/colour → track
      // it for the pane accent (async + debounced; SessionEnd stops it).
      const plan = planMeta(events, (ev) => {
        const a = adapterFor(ev)
        return a ? { kind: a.kind, file: a.meta?.file(ev) ?? null } : null
      })
      for (const m of plan) {
        if (m.type === "clear-others") {
          for (const [k, t] of metaTrackers) if (k !== m.kind) t.untrack(m.paneId)
          continue
        }
        const t = metaTrackers.get(m.kind)
        if (m.type === "untrack") t?.untrack(m.paneId, true, m.file, m.sessionId)
        else t?.track(m.paneId, m.file, transcriptTargets(m.file, m.paneId), m.sessionId)
      }
      // Token totals per agent, from its own source (async, off the agent's loop), tagged
      // with that agent like the watcher tags hook events.
      for (const a of ready) {
        const mine = events.filter((ev) => agentOf(ev) === a.kind)
        if (!a.usage || mine.length === 0) continue
        void a
          .usage(mine, transcriptTargets)
          .then((tokenEvents) => {
            if (tokenEvents.length)
              mainWindow?.webContents.send(
                "agents:events",
                tokenEvents.map((e) => ({ ...e, agent: a.kind })),
              )
          })
          .catch(() => {}) // best-effort: no badge
      }
    }
    // Sessions that end with their process (OpenCode on quit, fish/pwsh: no prompt mark) get
    // the SessionEnd they never sent: before a batch that starts one, and every few seconds
    // while any is tracked (signal 0 per process).
    const liveness = new AgentLiveness((k) => !!AGENT_RULES[k]?.liveByPid)
    // Ticks only while something is tracked: none when no Codex/OpenCode ever ran.
    const tick = () => {
      try {
        const ends = liveness.reap()
        if (ends.length) fold(ends)
      } catch (err) {
        diag("agent-reap-failed", { err: String(err) }) // never into Electron
      }
      if (!liveness.hasProcs() && reaper) {
        clearInterval(reaper)
        reaper = null
      }
    }
    const onBatch = (batch: AgentEvent[]) => {
      const events = foldLiveness(batch, liveness)
      if (events.length) fold(events)
      if (liveness.hasProcs() && !reaper) {
        reaper = setInterval(tick, REAP_MS)
        reaper.unref()
      }
    }
    // Every drop names the process that wrote it: an agent's own (liveByPid) is noted for its
    // pane, so closing the pane ends it even if it never got to a session (agent-procs.ts).
    const onDrop = (agent: AgentKind, paneId: string, pid: number) => {
      if (AGENT_RULES[agent]?.liveByPid && process.platform !== "win32" && sessions.has(paneId))
        agentProcs.note(paneId, pid)
    }
    hookWatcher = await startHookWatcher({ dir: eventsDir, agents: normalizers, onBatch, onDrop })
    agentEventsDir = eventsDir
    diag("agent-hooks-up", { dir: eventsDir, agents: ready.map((a) => a.kind).join(",") })
  } catch (err) {
    diag("agent-hooks-failed", { err: String(err) })
  }
}

// ── settings.json (source of truth) ────────────────────────────────
function settingsPath(): string {
  return path.join(configDir(), "settings.json")
}

/** ~/.config/minmux (%APPDATA%\minmux on Windows) — `minmux-<profile>` for another profile. */
function configDir(appName = PROFILE_NAMES.appName): string {
  return process.platform === "win32"
    ? path.join(process.env.APPDATA ?? os.homedir(), appName)
    : path.join(os.homedir(), ".config", appName)
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

// The renderer's spawn request (src/lib/ipc.ts), with `remote` untrusted until SshService
// rebuilds it from main's own list.
type SpawnOpts = Omit<SpawnRequest, "remote" | "reopen"> & { remote?: unknown; reopen?: unknown }
// remoteNonce: an integrated ssh pane's nonce, so the renderer trusts only its shell's reports.
type SpawnResult = {
  reattached: boolean
  integrated: boolean
  started?: boolean
  remoteNonce?: string
}

/** A reloaded renderer asking for a live session: rebind output, resize, replay history. */
function reattach(rec: PtySession, sender: Electron.WebContents, opts: SpawnOpts): SpawnResult {
  // Point output at the new renderer, drop stale in-flight bytes (they're in the buffer),
  // resize to the new xterm, then replay history.
  rec.sender = sender
  rec.coalescer?.reset()
  try {
    rec.proc.resize(opts.cols || 80, opts.rows || 24)
  } catch {
    // transient 0-size during layout — a later resize settles it
  }
  sendNonce(rec) // before the replay: its reports need it
  emit(rec, rec.buffer.dump())
  diag("pty-reattach", { id: opts.id, pid: rec.proc.pid })
  return { reattached: true, integrated: rec.integrated, remoteNonce: rec.remoteNonce }
}

/** An integrated ssh pane's confirmed nonce, to its renderer (on its own channel, not data). */
function sendNonce(rec: PtySession): void {
  if (rec.remoteNonce && !draining() && !rec.sender.isDestroyed()) {
    rec.sender.send(`pty:nonce:${rec.id}`, rec.remoteNonce)
  }
}

/** The env every spawned PTY starts from (process env + injection + our opt-outs). */
function baseSpawnEnv(opts: SpawnOpts, injEnv?: Record<string, string>): Record<string, string> {
  // Shared-history opt-out: the injected scripts default SHARE_HISTORY on; pass
  // MINMUX_SHARE_HISTORY=0 to disable. (For WSL, wslInjection lists it in $WSLENV
  // so it crosses the boundary.)
  const env = { ...process.env, ...(injEnv ?? {}) } as Record<string, string>
  if (!shareHistoryEnabled()) env.MINMUX_SHARE_HISTORY = "0"
  // Tell agents (Claude Code, vim, …) our light/dark background via COLORFGBG — the
  // fallback when the OSC-11 background query can't complete in time (notably across
  // the wsl.exe hop). WSL forwards it over $WSLENV (listed in wslInjection).
  const fgbg = opts.bg ? colorfgbg(opts.bg) : null
  if (fgbg) env.COLORFGBG = fgbg
  return env
}

interface StartSpec {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  wslDistro?: string
  integrated: boolean
  remote?: { hostId: string; hello: HelloWatch; nonce: string } // an integrated ssh pane
}

/** Spawn a node-pty for a session and wire it (buffer, coalescer, exit, drain registry). */
function startPty(sender: Electron.WebContents, opts: SpawnOpts, spec: StartSpec): SpawnResult {
  const startedAt = Date.now()
  const proc = pty.spawn(spec.file, spec.args, {
    name: "xterm-256color",
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd: spec.cwd,
    env: spec.env,
  })
  const coalesce = process.env.MINMUX_NO_COALESCE !== "1"
  let markExited!: () => void
  const exited = new Promise<void>((res) => (markExited = res))
  const live: Drainable = {
    kill: (sig) => proc.kill(sig),
    exited,
    // node-pty's unix terminal names its tty (not in its typings); none on Windows
    tty: (proc as { ptsName?: string }).ptsName,
    agentPids: () => agentProcs.pidsOf(opts.id),
  }
  livePtys.add(live)
  const rec: PtySession = {
    id: opts.id,
    proc,
    buffer: new OutputBuffer(PTY_REPLAY_BYTES),
    sender,
    shell: spec.file,
    wslDistro: spec.wslDistro,
    integrated: spec.integrated,
    live,
    hello: spec.remote?.hello,
    pendingNonce: spec.remote?.nonce,
  }
  if (coalesce) {
    rec.coalescer = new OutputCoalescer(PTY_FLUSH_MS, PTY_MAX_FLUSH_BYTES, (d) => emit(rec, d))
  }
  proc.onData((data) => {
    if (sessions.get(opts.id) !== rec) return // closed (or replaced): nobody shows it
    // An integrated ssh pane's bootstrap says hello once, right after login: answer it with
    // the nonce (its echo is off). A bounded scan — it stops for good once answered.
    if (rec.hello && !rec.hello.done) {
      const step = rec.hello.feed(data)
      if (step?.write) proc.write(step.write)
      if (step?.armed) {
        // Before this chunk's output (the coalescer sends it later): its reports need it.
        rec.remoteNonce = rec.pendingNonce
        sendNonce(rec)
      }
    }
    rec.buffer.push(data) // keep for replay on reattach
    if (rec.coalescer) rec.coalescer.push(data)
    else emit(rec, data) // A/B baseline: one IPC message per node-pty chunk
  })
  proc.onExit((e) => {
    diag("pty-exit", { id: opts.id, code: e.exitCode, signal: e.signal ?? 0 })
    rec.coalescer?.flush() // don't lose the final output
    // The host couldn't even start the bootstrap (no sh: a Windows host, a ForceCommand):
    // say so, and connect it plainly until the ssh config or settings change.
    if (
      spec.remote &&
      integrationFailed({
        booted: spec.remote.hello.booted,
        exitCode: e.exitCode,
        signal: e.signal ?? 0,
        closedByMinmux: sessions.get(opts.id) !== rec || draining(),
        livedMs: Date.now() - startedAt,
      })
    ) {
      ssh().markPlain(spec.remote.hostId)
      rec.buffer.push(INTEGRATION_FAILED_NOTE)
      emit(rec, INTEGRATION_FAILED_NOTE)
    }
    // Only a session that's still ours (not closed on purpose — pty:kill already cleaned up —
    // nor replaced by a newer PTY for the same id) tells its pane and drops its state.
    if (sessions.get(opts.id) === rec) {
      if (!draining() && !rec.sender.isDestroyed()) {
        rec.sender.send(`pty:exit:${opts.id}`, { code: e.exitCode, signal: e.signal ?? 0 })
      }
      sessions.delete(opts.id)
      untrackMeta(opts.id) // shell (and any agent in it) gone — drop the accent
      agentProcs.forget(opts.id)
      sessionLedger().drop(opts.id) // …and nothing to resume there (no-op during a quit)
    }
    livePtys.delete(live)
    markExited()
  })
  sessions.set(opts.id, rec)
  diag("pty-spawn", { id: opts.id, pid: proc.pid, shell: path.basename(spec.file) })
  return { reattached: false, integrated: spec.integrated, remoteNonce: rec.remoteNonce }
}

const SSH_PROBE_TIMEOUT_MS = 5000 // `ssh -G` reads config only, but WSL may be waking up

/** A remote (ssh) session: main rebuilds the command from its own host list. */
async function spawnRemote(
  opts: SpawnOpts,
  outcome: () => PendingOutcome<Electron.WebContents>,
): Promise<SpawnResult> {
  const plan = await ssh().spawnPlan(opts.remote)
  // What arrived while we waited: the pane may be gone, resized, typed into, or taken over
  // by a reloaded renderer.
  const meanwhile = outcome()
  if (meanwhile.killed) throw new Error("the pane was closed") // never an ssh with no pane
  if (draining()) throw new Error("minmux is quitting")
  if ("error" in plan) throw new Error(plan.error)
  // The host opted in to shell integration: its command bootstraps our hooks there, and main
  // answers its hello with a fresh nonce (never on the command line — see remote-bootstrap).
  const hostId = (opts.remote as { hostId: string }).hostId
  let remote: StartSpec["remote"]
  let args = plan.args
  if (plan.integration) {
    const challenge = randomBytes(8).toString("hex")
    const nonce = randomBytes(16).toString("hex")
    args = [...plan.args, remoteBootstrapCommand(challenge)]
    // The folder to reopen (a verified one the renderer kept), validated again here; it goes
    // hex-encoded in the answer, never in the command, and only our own shell cds to it.
    const reply = handshakeReply(nonce, parseReopen(opts.reopen))
    remote = { hostId, nonce, hello: new HelloWatch(challenge, reply) }
  }
  // No local shell integration (and no claude hook env): the shell runs on the remote host.
  const result = startPty(
    meanwhile.sender,
    { ...opts, cols: meanwhile.cols, rows: meanwhile.rows },
    {
      file: plan.file,
      args,
      cwd: os.homedir(),
      env: baseSpawnEnv(opts),
      integrated: false,
      remote,
    },
  )
  // Keys typed before ssh existed are dropped, not replayed: they'd land before ssh turns
  // echo off for its password prompt and show (and sit in the replay buffer) in clear text.
  return result
}

// ── ssh remotes ─────────────────────────────────────────────────────
interface ExecResult {
  code: number // 0 = ran fine; anything else failed (a timeout included)
  stdout: string
}

// Run a command, never rejecting: failures (a timeout included) come back as a non-zero code.
function execQuiet(
  file: string,
  args: string[],
  timeoutMs: number,
  encoding: BufferEncoding = "utf8",
) {
  return new Promise<ExecResult>((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding, windowsHide: true },
      (err, stdout) => {
        const e = err as NodeJS.ErrnoException | null
        const code = !e ? 0 : typeof e.code === "number" ? e.code : -1
        resolve({ code, stdout: String(stdout ?? "") })
      },
    )
  })
}

// The native ssh's full path (on Windows: PATH, else OpenSSH's standard System32 location).
// The PATH scan (async stats — never blocking main): a hit is kept a minute (re-checked with
// one stat, in case ssh is removed), a miss 30 s (ssh installed later is then found).
let sshPathCache: { path: string | null; at: number } | null = null
const SSH_MISS_TTL_MS = 30_000
const SSH_HIT_TTL_MS = 60_000
async function nativeSshPath(): Promise<string | null> {
  const c = sshPathCache
  const age = c ? Date.now() - c.at : Infinity
  // A hit is re-resolved after a minute: PATH can change (the login env import, a new ssh).
  if (c?.path && age < SSH_HIT_TTL_MS && (await isFileAsync(c.path))) return c.path
  if (c && !c.path && age < SSH_MISS_TTL_MS) return null
  const found = await resolveNativeSsh()
  sshPathCache = { path: found, at: Date.now() }
  return found
}
async function isFileAsync(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isFile()
  } catch {
    return false
  }
}
async function findOnPathAsync(cmd: string): Promise<string | null> {
  for (const candidate of pathCandidates(cmd)) if (await isFileAsync(candidate)) return candidate
  return null
}
async function resolveNativeSsh(): Promise<string | null> {
  if (process.platform !== "win32") return findOnPathAsync("ssh")
  const builtIn = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "OpenSSH",
    "ssh.exe",
  )
  return (await findOnPathAsync("ssh")) ?? ((await isFileAsync(builtIn)) ? builtIn : null)
}

/** The ssh remotes service, created on first use (so startup never pays for it). */
function ssh(): SshService {
  if (sshService) return sshService
  sshService = new SshService({
    platform: process.platform,
    home: os.homedir(),
    readSettings,
    fs: nodeMiniFs,
    // Only running distros: listing hosts must never boot a WSL VM (a restored pane boots
    // just its own, on demand).
    wslRunningDistros: async () => {
      if (process.platform !== "win32") return []
      const r = await execQuiet("wsl.exe", ["-l", "--running", "-q"], 5000, "utf16le")
      return r.code === 0 ? parseWslDistros(r.stdout) : []
    },
    wslHome: async (distro, timeoutMs) => {
      const r = await execQuiet(
        "wsl.exe",
        ["-d", distro, "-e", "sh", "-c", 'printf %s "$HOME"'],
        timeoutMs,
      )
      const home = r.stdout.trim()
      return r.code === 0 && home.startsWith("/") ? home : null
    },
    wslFs: (distro) => wslMiniFs(distro),
    wslWatchPaths: (distro, linuxPath) => wslUncCandidates(distro, linuxPath),
    sshPath: nativeSshPath,
    sshEffectiveConfig: async (file, args) => {
      const r = await execQuiet(file, args, SSH_PROBE_TIMEOUT_MS)
      return r.code === 0 ? r.stdout : null
    },
    createWatcher: (onChange) =>
      createPathWatcher(onChange, (err) => diag("ssh-watch-error", { err: String(err) })),
    onChange: () => mainWindow?.webContents.send("ssh-hosts-changed"),
  })
  return sshService
}

function registerIpc() {
  // PTY — one node-pty per session; stream output back over pty:data:<id>. When a
  // reloaded renderer asks to spawn a session that's already live, REATTACH: rebind
  // output to the new renderer and replay recent history, rather than respawn.
  ipcMain.handle("pty:spawn", async (event, opts: SpawnOpts): Promise<SpawnResult> => {
    // nothing new may outlive the drain (or start once a quit is under way)
    if (draining()) throw new Error("minmux is quitting")
    // Still preparing (a reloaded renderer asking again): join that spawn — this renderer
    // takes over its output and size, and shares its result. Never a second spawn.
    const joined = pendingSpawns.join(opts.id, event.sender, opts.cols, opts.rows)
    if (joined) return joined as Promise<SpawnResult>
    const existing = sessions.get(opts.id)
    if (existing) return reattach(existing, event.sender, opts)
    // Reattach only (a restored ssh pane waiting for Enter): nothing live → start nothing.
    if (opts.attachOnly === true) return { reattached: false, integrated: false, started: false }
    if (opts.remote !== undefined) {
      return pendingSpawns.start(opts.id, event.sender, opts.cols, opts.rows, (outcome) =>
        spawnRemote(opts, outcome),
      )
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
    const env = baseSpawnEnv(opts, inj?.env)
    // Arm every agent in this pane (Claude: the injected `claude` wrapper routes through our
    // scoped hook settings), and tag the pane so the agents board knows which pane each
    // session runs in (M6). The hooks find the drop root in MINMUX_AGENT_EVENTS. WSL:
    // wslInjection forwards the paths over WSLENV with /p, so their Windows form is
    // translated for an agent inside WSL.
    if (agentEventsDir && armed.length)
      Object.assign(env, agentPaneEnv(armed, disabledAgents(), agentEventsDir, opts.id))
    return startPty(event.sender, opts, {
      file: shellCmd,
      args: [...(opts.args ?? []), ...wslArgs, ...(inj?.args ?? [])],
      cwd: startCwd,
      env,
      // Remember a WSL pane's distro so a hook event tagged with this pane resolves its
      // Linux transcript path against the right distro's UNC share (not just the default).
      wslDistro: wsl ? (parseWslDistroArg(opts.args ?? []) ?? defaultWslDistro()) : undefined,
      integrated: !!inj,
    })
  })
  ipcMain.on("pty:write", (_e, id: string, data: string) => {
    // Still preparing: swallowed (see pending-spawns.ts), never replayed into the new ssh.
    if (typeof data !== "string" || pendingSpawns.pending(id)) return
    sessions.get(id)?.proc.write(data)
  })
  ipcMain.on("pty:resize", (_e, id: string, cols: number, rows: number) => {
    if (pendingSpawns.resize(id, cols, rows)) return // applied when it starts
    try {
      sessions.get(id)?.proc.resize(cols, rows)
    } catch {
      // ignore transient 0-size during layout
    }
  })
  // Explicit kill (pane/tab closed) — really terminate + free the replay buffer.
  // Which sessions have a live PTY here (a renderer reload restores its layout over them).
  ipcMain.handle("pty:live-ids", async () => [...sessions.keys()])
  ipcMain.on("pty:kill", (_e, id: string) => {
    untrackMeta(id, false) // the pane is gone — nothing left to accent
    sessionLedger().drop(id) // closed on purpose — don't resume its Claude session
    pendingSpawns.kill(id) // still preparing: it must not start at all
    const rec = sessions.get(id)
    if (!rec) return
    rec.coalescer?.dispose()
    rec.buffer.clear()
    sessions.delete(id)
    closePty(id, rec.live)
  })

  // Shells — per-OS defaults + WSL distro enumeration.
  ipcMain.handle("shells:list", async () => listShells())

  // SSH remotes — the saved-host list (lazy: first asked by the sidebar) + its config file.
  // null = the list couldn't be built (the renderer keeps what it has), never "no hosts".
  ipcMain.handle("ssh:list-hosts", async () => {
    try {
      return await ssh().hosts()
    } catch {
      return null
    }
  })
  ipcMain.on("ssh:open-config", () => {
    // Create an empty ~/.ssh/config (0600, in a 0700 ~/.ssh) if there's none, so it opens.
    // `wx` never writes through an existing path — a dangling symlink included.
    const dirPath = path.join(os.homedir(), ".ssh")
    const file = path.join(dirPath, "config")
    void (async () => {
      try {
        await fs.promises.mkdir(dirPath, { recursive: true, mode: 0o700 })
        await fs.promises.writeFile(file, "", { mode: 0o600, flag: "wx" }).catch(() => undefined)
        openFile(dirPath, file)
      } catch {
        // best-effort
      }
    })()
  })

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
    // A switched-off agent isn't resumed: its pane opens plain and its entry goes (no hook
    // would update it meanwhile, so re-enabling later must not resume a stale session).
    const { resume, drop } = resumablePanes(paneIds, (id) => l.get(id), disabledAgents())
    for (const id of drop) l.drop(id)
    return l.plan(
      resume,
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
  // The approval hint: show it for this agent? Only if the agent itself says our hooks aren't
  // approved (unknown → no), and the user hasn't said "Don't ask again".
  ipcMain.handle("agents:hint-wanted", async (_e, kind: AgentKind) => {
    // Not for an integration switched off in Settings (older panes still print the marker).
    const a = disabledAgents().has(kind) ? undefined : armed.find((x) => x.kind === kind)
    const approved = a?.approved ? await a.approved().catch(() => null) : null
    const s = await agentHints().get(kind)
    return { wanted: approved === false && !s.never, dismissals: s.dismissals }
  })
  ipcMain.handle("agents:hint-dismiss", async (_e, kind: AgentKind, never: boolean) =>
    armed.some((a) => a.kind === kind) ? agentHints().dismiss(kind, never === true) : 0,
  )
  // A (re)loaded renderer starts with no accents: hand it every tracked pane's current meta.
  ipcMain.handle("agents:meta-snapshot", async () =>
    [...metaTrackers.values()].flatMap((t) => t.snapshot()),
  )
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
  ipcMain.handle("app:perf-mode", async () => process.env.MINMUX_PERF === "1")

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

  // Files browser: watch these folders (the whole set; [] stops). Host paths only: the
  // renderer doesn't send WSL panes' folders (a 9p share can't be watched reliably).
  ipcMain.handle("fs:watch", (_e, dirs: unknown) => {
    const list = Array.isArray(dirs)
      ? dirs.filter((d): d is string => typeof d === "string" && path.isAbsolute(d))
      : []
    // Not on Windows: a watched folder's open handle blocks renaming / deleting it and its
    // parents there (focus and Refresh still read).
    fsWorker.setWatched(process.platform === "win32" ? [] : list.slice(0, WATCH_CAP))
  })
  ipcMain.handle("fs:watching", () => fsWorker.watchingNow())

  // Files browser: list ONE directory (lazy — never a recursive walk), bounded so a huge
  // folder can't block main (read-dir; sort / .git filter / cap in lib/dir-listing).
  ipcMain.handle("fs:readdir", async (_e, dir: string, wsl?: WslContext) => {
    // A WSL pane's dir is a Linux path the host can't see — read it through the distro's
    // UNC share instead (wslTargets); non-WSL panes read the host path.
    // The read runs in the fs worker (capped first, links stat-ed in small batches).
    // Deleted if some form says "no such folder" while its parent exists (an unsupported
    // share form, a stopped distro or an unmounted share isn't a deletion).
    let gone = false
    for (const target of wslTargets(dir, wsl)) {
      try {
        return (await fsWorker.call({ op: "readdir", path: target })) as DirListing
      } catch (e) {
        // This candidate didn't resolve (wrong share form, unreadable, hung) — try the next.
        const code = (e as { code?: string }).code
        if (code === "EHUNG" || code === "EBUSY") break // a dead mount: don't hang the next form
        if (code === "ENOENT" || code === "ENOTDIR") {
          const parent = await parentExists(target)
          if (parent === "stuck") break
          if (parent === "yes") gone = true
        }
      }
    }
    // Deleted → an empty folder. Any other failure → flagged, so the panel keeps what it had.
    return gone
      ? { entries: [], truncated: false, total: 0 }
      : { entries: [], truncated: false, error: true }
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
  return findOnPath(cmd) !== null
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
// Per profile (a dev build is `minmux-dev`): the user-data dir — and with it the
// single-instance lock and localStorage — is the profile's own, unless the caller chose one.
// The AppUserModelId stays shared: on Windows toasts only show for an id a Start Menu
// shortcut registers, and only the installer's (com.minmux.app) exists.
app.setName(displayName(PROFILE_NAMES)) // the menu / About name: "minmux (dev)", like the window
app.setAppUserModelId("com.minmux.app")
if (!app.commandLine.hasSwitch("user-data-dir")) {
  app.setPath("userData", path.join(app.getPath("appData"), PROFILE_NAMES.appName))
}

// The app was called smterm: a profile's first minmux launch copies its old state over (settings,
// layout, resume ledger, localStorage) — at ready, before anything reads it. (legacy-migrate.ts)
const LEGACY_DIR_NAME = profileNames(PROFILE_CHOICE.profile, LEGACY_APP_NAME).appName
const LEGACY_USER_DATA = path.join(app.getPath("appData"), LEGACY_DIR_NAME)
// An explicit --user-data-dir (the test driver) is fresh on purpose: carry no user data, and
// don't look for a running smterm there — on macOS appData ignores $HOME, so a fake-HOME run
// would find the real one. The config dir still follows $HOME.
const CUSTOM_USER_DATA = app.commandLine.hasSwitch("user-data-dir")
const LEGACY_PAIRS: (readonly [string, string])[] = [
  [configDir(), configDir(LEGACY_DIR_NAME)],
  ...(CUSTOM_USER_DATA ? [] : [[app.getPath("userData"), LEGACY_USER_DATA] as const]),
]

/** Carry the smterm state over once — but never from a running smterm: its live ledger would
 *  resume its Claude sessions a second time here. Asks to quit it, or to start without it. */
function migrateFromSmterm(): void {
  if (!pendingLegacyDirs(LEGACY_PAIRS).length) return
  while (!CUSTOM_USER_DATA && legacyInstanceRunning(LEGACY_USER_DATA)) {
    const choice = dialog.showMessageBoxSync({
      type: "info",
      message: "Quit smterm to bring your sessions over",
      detail:
        "smterm is now minmux. On this first launch minmux brings over your smterm layout, " +
        "settings and Claude sessions, but not while smterm is still running (its sessions " +
        "would be resumed twice). Quit smterm, then choose Try Again.",
      buttons: ["Try Again", "Start Without Them"],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice === 1) {
      markLegacyDirs(pendingLegacyDirs(LEGACY_PAIRS))
      diag("legacy-migrate-declined")
      return
    }
  }
  const r = migrateLegacyDirs(LEGACY_PAIRS)
  if (r.copied.length) diag("legacy-migrated", { copied: r.copied.join(", ") })
  if (r.failed.length) diag("legacy-migrate-failed", { failed: r.failed.join("; ") })
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
  migrateFromSmterm() // first thing: before any setting, layout or ledger is read or written
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
  // Start the hook receiver BEFORE the window so the agents are armed before the renderer
  // can request the first pty:spawn — otherwise the initial pane launches without their env
  // (MINMUX_CLAUDE_SETTINGS, MINMUX_AGENT_EVENTS) and the `claude` wrapper never arms (M6).
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
  metaTrackers.forEach((t) => t.dispose()) // close transcript / index watchers
  sshService?.dispose() // close the ssh config watchers
  void hookWatcher?.close() // stop the file-drop watcher
  if (reaper) clearInterval(reaper)
  fsWorker.dispose() // stop the fs worker process
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

/** Drain a closed pane as a quit does: its agent ends with it (GOTCHAS #session-survival). */
function closePty(id: string, live: Drainable): void {
  const closing = drainPtys([live], ptyDrainOptions({ id })).then(noop, noop)
  agentProcs.forget(id) // read above
  closingPanes.add(closing) // a quit waits for the agent in it too
  void closing.then(() => closingPanes.delete(closing))
}

/** How a PTY is drained here: Windows takes no signals; elsewhere its agents end with it. */
function ptyDrainOptions(tag: Record<string, string>): DrainOptions {
  const win32 = process.platform === "win32"
  return {
    signals: !win32,
    settleMs: win32 ? 300 : 0,
    procs: win32 ? undefined : posixProcs,
    onAgentsKilled: (pids) => diag("agents-killed", { ...tag, pids: pids.join(",") }),
    onLookupFailed: (err) => diag("agents-lookup-failed", { ...tag, err: String(err) }),
  }
}

function shutdownPtys(): Promise<void> {
  if (!shutdown) {
    // Keep every "inside Claude" entry for the relaunch BEFORE our kill makes Claude fire
    // SessionEnd (which would otherwise clear them).
    sessionLedger().freeze()
    for (const rec of sessions.values()) rec.coalescer?.dispose()
    const count = livePtys.size
    const drained = drainPtys([...livePtys], ptyDrainOptions({}))
    shutdown = Promise.all([drained, ...closingPanes]).then(([clean]) => {
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

// Agents switched off in settings (validated like the renderer's; default all on). Cached:
// read once per settings change, not on every spawn (startSettingsWatcher clears it).
let switchesOff: Set<AgentKind> | null = null
function disabledAgents(): Set<AgentKind> {
  if (switchesOff) return switchesOff
  let raw: { agents?: unknown } = {}
  try {
    raw = (JSON.parse(readSettings() || "{}") as { agents?: unknown } | null) ?? {}
  } catch {
    // unreadable → defaults
  }
  return (switchesOff = disabledAgentsIn(mergeAgentSwitches(raw.agents)))
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
    // Spawns still preparing (an ssh probe) are about to be sessions: count them too.
    needsConfirm: sessions.size + pendingSpawns.live > 0 && confirmQuitEnabled() && !!mainWindow,
    livePtys: livePtys.size + closingPanes.size, // a closed pane's agent may still be ending
    osEnding,
  })
  diag("before-quit", { ptys: livePtys.size, step })
  // Quitting with no PTY to drain (or on an OS logout): spawns still preparing are closed —
  // one resolving after this must not start an ssh in an exiting app. (No global flag: a
  // cancelled logout leaves new panes free to start.)
  if (step === "proceed") {
    pendingSpawns.killAll()
    return
  }
  if (step === "killNow") {
    pendingSpawns.killAll()
    return killNow()
  }
  e.preventDefault()
  if (step === "hold") return
  if (step === "drain") {
    // Hold the quit until every PTY has exited (≤ ~2 s; ≤ ~4 s if the agents' ps stalls).
    quitPhase = "draining"
    mainWindow?.hide() // feels instant while the shells wind down
    void shutdownPtys().finally(() => {
      quitPhase = "drained"
      app.quit()
    })
    return
  }
  if (!mainWindow) return
  const n = sessions.size + pendingSpawns.live
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
