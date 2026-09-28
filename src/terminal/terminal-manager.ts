import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { WebglAddon } from "@xterm/addon-webgl"
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search"
import type { PaneLeaf, Session } from "../types"
import { activeTheme, useStore } from "../store"
import { notify } from "../lib/notify"
import { ipc } from "../lib/ipc"
import type { Settings } from "../settings/schema"
import { ligatureRanges } from "./ligatures"
import { withAlpha } from "../settings/themes"
import { displaySessionTitle } from "../lib/session-label"
import { allPanes, visibleSessionIds } from "../lib/pane-tree"
import { webglPanes, shouldRebuildAtlas } from "../lib/renderer-policy"
import { appShortcut, keyAction } from "../lib/terminal-keys"
import { gridChanged, type Grid } from "../lib/resize"
import { findFilePaths } from "../lib/file-links"
import { isPosixShell, withCd } from "../lib/resume"
import { canType, newShellFlow, onMark, parseMark, type ShellFlow } from "../lib/resume-flow"
import { isMac, isWindows } from "../lib/platform"
import {
  afterStart,
  banner,
  cleanError,
  firstStart,
  idleMessage,
  isIdle,
  onKey,
  type RemoteIdle,
  type RemotePhase,
} from "../lib/remote-connect"

interface Entry {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  host: HTMLDivElement
  opened: boolean // xterm mounted into a DOM host (first time on-screen)
  spawned: boolean // PTY spawned/reattached + output listeners wired (may precede `opened`)
  offData?: () => void
  offExit?: () => void
  remote?: RemotePhase // ssh panes only: where the connection is (rules: lib/remote-connect)
  startSeq?: number // bumps per PTY request: a stale answer never moves `remote`
  joinerId?: number
  idleTimer?: ReturnType<typeof setTimeout>
  lastOutputSignal?: number
  lastGrid?: Grid // last cols/rows sent to the PTY — skip no-op resizes (spurious SIGWINCH)
  resumeTimer?: ReturnType<typeof setTimeout> // pending-resume fallback / confirm timeout
  flow: ShellFlow // shell marks + resume stage (pure rules: lib/resume-flow.ts)
  webgl?: WebglAddon // present only while this terminal is rendering via WebGL
  webglFailed?: boolean // context was lost — stay on DOM, don't re-acquire
}

// Output quiet for this long (while a command runs) ⇒ the task is waiting.
const IDLE_MS = 1200
// Don't spam the store with an "output" signal on every PTY chunk.
const OUTPUT_SIGNAL_THROTTLE_MS = 150

// xterm.js lives here, keyed by session id — OUTSIDE the React tree, so splitting
// a pane or switching tabs re-attaches instead of respawning the shell.
const entries = new Map<string, Entry>()

// Set while WE call term.focus() programmatically (attach/mount/reparent) so the
// textarea focus listener ignores it — only genuine user focus should change the
// active pane. Otherwise a tab-switch/split mount storm would clobber the active pane.
let suppressFocusSignal = false

// File-link existence cache: the link provider fires on hover, so cache validated
// paths briefly to avoid re-stat'ing the same line via IPC on every mouse move.
const pathExistsCache = new Map<string, { ok: boolean; ts: number }>()
const PATH_CACHE_TTL_MS = 5000
const PATH_CACHE_MAX = 1000 // bound memory over long sessions (many distinct paths)
function validatePath(cwd: string, p: string): Promise<boolean> {
  const key = `${cwd} ${p}`
  const hit = pathExistsCache.get(key)
  const now = performance.now()
  if (hit && now - hit.ts < PATH_CACHE_TTL_MS) return Promise.resolve(hit.ok)
  return ipc.pathExists(cwd, p).then((ok) => {
    pathExistsCache.set(key, { ok, ts: now })
    // Evict the oldest entry once over the cap (Map keeps insertion order) so the
    // cache can't grow unbounded as an agent prints thousands of distinct paths.
    if (pathExistsCache.size > PATH_CACHE_MAX) {
      const oldest = pathExistsCache.keys().next().value
      if (oldest !== undefined) pathExistsCache.delete(oldest)
    }
    return ok
  })
}

// Bundled FiraCode Nerd Font Mono carries text + ligatures + Nerd/Powerline icons.
const fontStack = (family: string) =>
  `"${family}", "FiraCode Nerd Font Mono", "JetBrains Mono", Menlo, monospace`

// Explicitly load the terminal font (regular + bold) so canvas — and thus the
// WebGL glyph atlas — can rasterize its Nerd/box glyphs. `document.fonts.ready`
// is not enough: it won't load an unused `font-display:block` @font-face.
function ensureFontLoaded(family: string, size: number): Promise<unknown> {
  return Promise.all(
    [`${size}px ${family}`, `bold ${size}px ${family}`].map((spec) =>
      document.fonts.load(spec).catch(() => undefined),
    ),
  )
}

// Paste into a terminal. Text on the clipboard → bracketed paste. No text (e.g. a
// screenshot) → send Ctrl+V (0x16) so the running program (Claude Code, etc.) reads the
// clipboard itself — we never touch the image bytes, so there's NO bitmap decode (that
// decode was slow on Windows and the whole reason image paste lagged). In a plain shell
// 0x16 is quoted-insert — it arms the next keystroke as literal (recover with Ctrl+C); on
// an empty clipboard that's the only cost (the previous code sent nothing there).
function pasteInto(term: Terminal) {
  void ipc.clipboardRead().then((text) => {
    if (text) term.paste(text)
    else term.input("\x16")
  })
}

/** Give this pane a WebGL context if it doesn't have one. Returns true if a context
 *  was newly created (so the caller can rebuild the shared atlas across panes). */
function acquireWebgl(entry: Entry): boolean {
  // Only once mounted in a pane: a store change reconciles BEFORE React re-attaches the host
  // (it may still be parked), and moving a live canvas can lose its context. attach()
  // reconciles again once the host is in its pane.
  if (entry.webgl || entry.webglFailed || !entry.opened) return false
  if (!entry.host.isConnected || entry.host.parentElement === parking) return false
  try {
    const webgl = new WebglAddon()
    webgl.onContextLoss(() => {
      // Context lost — GPU pressure, another pane creating a context on split (browsers
      // cap live WebGL contexts and evict the oldest), or the host being reparented.
      // Drop to DOM and don't retry. CRUCIAL: repaint. Disposing WebGL stops it drawing
      // and the DOM renderer starts empty, so without this the pane goes BLANK (the
      // buffer is intact — it just isn't painted). Repaint next frame, once DOM is live.
      webgl.dispose()
      entry.webgl = undefined
      entry.webglFailed = true
      requestAnimationFrame(() => {
        try {
          entry.term.refresh(0, entry.term.rows - 1)
        } catch {
          // terminal disposed meanwhile
        }
      })
    })
    entry.term.loadAddon(webgl)
    entry.webgl = webgl
    // The WebGL atlas rasterizes glyphs via canvas, which only uses an @font-face
    // AFTER it's explicitly loaded — `document.fonts.ready` isn't enough. Load it,
    // then clear the atlas + repaint so early/stale glyphs re-rasterize cleanly.
    const s = useStore.getState().settings
    void ensureFontLoaded(fontStack(s.font.family), s.font.size).then(() => {
      try {
        webgl.clearTextureAtlas()
        entry.term.refresh(0, entry.term.rows - 1)
      } catch {
        // addon disposed meanwhile
      }
    })
    return true
  } catch {
    entry.webglFailed = true // no WebGL2 — stay on the DOM renderer
    return false
  }
}

/** Stop rendering via WebGL; xterm reverts to the DOM renderer (keeps the PTY). */
function releaseWebgl(entry: Entry) {
  if (!entry.webgl) return
  try {
    entry.webgl.dispose()
  } catch {
    // already gone
  }
  entry.webgl = undefined
  // Reverting to the DOM renderer stops the WebGL canvas painting; repaint so the
  // pane isn't left blank (next frame, once DOM has taken over).
  requestAnimationFrame(() => {
    try {
      entry.term.refresh(0, entry.term.rows - 1)
    } catch {
      // disposed meanwhile
    }
  })
}

/** WebGL only for the panes currently on-screen (active tab), and only when few
 *  enough share the screen (else DOM). Keeps live GPU contexts to a safe minimum
 *  — many simultaneous WebGL contexts corrupt the glyph atlas. */
function reconcileRenderers() {
  const state = useStore.getState()
  const tab = state.tabs.find((t) => t.id === state.activeTabId)
  // Each pane's active surface only — a surface hidden behind another holds no context.
  const visible = tab ? visibleSessionIds(tab.root) : []
  // Which panes get a live GPU context. Default (`auto`) is the focused pane only —
  // one context can't corrupt itself, so the multi-pane split garble is impossible
  // by construction (see GOTCHAS #renderer). `webgl` = all visible; `dom` = none.
  const webgl = webglPanes(state.settings.renderer, visible)
  let created = false
  for (const [id, entry] of entries) {
    if (!entry.opened) continue
    if (webgl.has(id)) created = acquireWebgl(entry) || created
    else releaseWebgl(entry)
  }
  // Creating a WebGL context can disturb the sibling contexts that share xterm's
  // glyph atlas (garble on split with several panes — xterm.js #4379). Once the new
  // context has settled, rebuild the atlas on ALL live WebGL panes so any corrupted
  // glyphs re-rasterize. Deferred a frame so the new context is fully initialised.
  if (shouldRebuildAtlas(created, webgl.size)) {
    requestAnimationFrame(() => repairRenderers(true))
  }
}

/** Repaint on-screen WebGL panes — mirrors what a manual scroll does, forcing
 *  xterm to re-emit rows the GPU may be showing stale. Pass `rebuildAtlas` when
 *  render metrics changed (DPR / monitor / display-scale / resize) so the glyph
 *  atlas is rebuilt at the new size, not just repainted. Cures the rare WebGL
 *  atlas/framebuffer garble after backgrounding or a display change — the "it
 *  fixes itself when I scroll" symptom. See GOTCHAS #renderer. */
function repairRenderers(rebuildAtlas = false) {
  for (const entry of entries.values()) {
    if (!entry.webgl || !entry.opened) continue
    try {
      if (rebuildAtlas) entry.webgl.clearTextureAtlas()
      entry.term.refresh(0, entry.term.rows - 1)
    } catch {
      // addon disposed meanwhile — ignore
    }
  }
}

function build(): Entry {
  const s = useStore.getState().settings
  const host = document.createElement("div")
  host.className = "terminal-host"
  const term = new Terminal({
    allowProposedApi: true, // for registerCharacterJoiner (ligatures)
    fontFamily: fontStack(s.font.family),
    fontSize: s.font.size,
    lineHeight: s.font.lineHeight,
    cursorBlink: s.cursorBlink,
    scrollback: s.scrollback,
    // Snappier scrollback feel (xterm defaults to 1 line/tick, no smoothing — reads as
    // sluggish vs VS Code/cmux). More lines per wheel/trackpad tick + a short glide.
    scrollSensitivity: 3,
    fastScrollSensitivity: 12, // Alt-scroll
    smoothScrollDuration: 300, // ms
    theme: activeTheme(useStore.getState()).terminal,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  const search = new SearchAddon()
  term.loadAddon(search)
  // Clicking a URL opens it in the OS default browser (no embedded browser).
  term.loadAddon(new WebLinksAddon((_event, uri) => ipc.openExternal(uri)))
  // Copy / paste / select-all. Returning false stops xterm from also processing
  // the key; preventDefault stops the browser's native copy/paste (avoids a double
  // paste). Everything else (incl. ⌃C SIGINT) passes straight through to the PTY.
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true
    // App shortcuts (⌘T / Ctrl+Shift+T) are handled by the window listener; don't also
    // let xterm send the key to the PTY (Ctrl+Shift+T would otherwise type ^T).
    if (appShortcut(e, { isMac })) return false
    const action = keyAction(e, { isMac, isWindows, hasSelection: term.hasSelection() })
    if (!action) return true
    if (action === "copy") {
      const sel = term.getSelection()
      if (sel) ipc.clipboardWrite(sel)
      // Windows/Linux plain Ctrl+C copies-when-selected; clear the selection so an
      // immediate second Ctrl+C sends SIGINT instead of re-copying.
      if (!isMac && e.ctrlKey && !e.shiftKey) term.clearSelection()
    } else if (action === "paste") {
      pasteInto(term)
    } else if (action === "newline") {
      // Gated so it can be turned off if a plain shell doesn't decode CSI-u; default
      // on (works with Claude Code & other agent CLIs). Off → let xterm submit normally.
      if (!useStore.getState().settings.shiftEnterNewline) return true
      // CSI-u encoding of Shift+Enter — apps that speak it insert a newline instead of
      // submitting. `input()` routes through onData → the PTY.
      term.input("\x1b[13;2u")
    } else {
      term.selectAll()
    }
    e.preventDefault()
    return false
  })
  return { term, fit, search, host, opened: false, spawned: false, flow: newShellFlow() }
}

// Search match highlighting from the active theme — amber for all matches, red for the
// active one (translucent so text stays readable; solid on the overview ruler). Theme-
// derived so matches stay visible on light backgrounds too.
function searchOptions(caseSensitive: boolean, incremental: boolean): ISearchOptions {
  const { amber, red } = activeTheme(useStore.getState()).ui
  return {
    caseSensitive,
    incremental, // type-as-you-go: keep the current match instead of jumping ahead
    decorations: {
      matchBackground: withAlpha(amber, 0.35),
      matchBorder: withAlpha(amber, 0.9),
      matchOverviewRuler: amber,
      activeMatchBackground: withAlpha(red, 0.45),
      activeMatchBorder: red,
      activeMatchColorOverviewRuler: red,
    },
  }
}

/** Register/deregister the ligature character joiner to match the setting. */
function applyLigatures(entry: Entry, on: boolean) {
  if (on && entry.joinerId === undefined) {
    entry.joinerId = entry.term.registerCharacterJoiner(ligatureRanges)
  } else if (!on && entry.joinerId !== undefined) {
    entry.term.deregisterCharacterJoiner(entry.joinerId)
    entry.joinerId = undefined
  }
}

/** Ask main for this pane's PTY: spawn it, or (attachOnly) only reattach a live one. The
 *  store's session is used when it has one, so a reconnect uses the pane as it is now. */
function requestPty(id: string, entry: Entry, attachOnly: boolean, given?: Session) {
  const session = useStore.getState().sessions[id] ?? given
  if (!session) return
  const { term } = entry
  const seq = (entry.startSeq ?? 0) + 1
  entry.startSeq = seq
  if (session.remote) setPhase(id, entry, "starting")
  void ipc
    .ptySpawn({
      id: session.id,
      cols: term.cols,
      rows: term.rows,
      shell: session.command,
      args: session.args,
      cwd: session.cwd, // inherited from the pane this was split/opened from
      // An ssh session: main rebuilds the command from its own host list (never ours).
      ...(session.remote ? { remote: session.remote } : {}),
      ...(attachOnly ? { attachOnly: true } : {}),
      // → COLORFGBG so agents detect light/dark (fallback when the OSC-11 bg query can't
      // complete, e.g. across the wsl.exe hop). Captured at spawn: a running shell's env
      // can't be rewritten, so a later theme switch — incl. appearance "system" following
      // the OS — only affects newly-spawned panes. On native, OSC-11 self-corrects live; on
      // WSL a pane opened before the switch keeps the stale value until it's replaced.
      // (Startup loads settings before any restore spawns, so first spawns are correct.)
      bg: activeTheme(useStore.getState()).terminal.background,
    })
    .then(({ reattached, integrated, started }) => {
      if (entries.get(id) !== entry) return // closed meanwhile
      if (entry.startSeq !== seq) {
        entry.flow.replaying = false // superseded (e.g. it exited first): nothing is replaying
        return
      }
      if (entry.remote) {
        const next = afterStart(entry.remote, started)
        if (next === "waiting") setIdle(id, entry, "waiting")
        else setPhase(id, entry, next)
      }
      // A reattach replays up to 256 KB of old output: its OSC 133 marks must not drive live
      // side effects (e.g. a replayed "command ended" would drop a running Claude's ledger
      // entry). xterm parses writes in order, so an empty write's callback = replay parsed.
      if (reattached) term.write("", () => (entry.flow.replaying = false))
      else entry.flow.replaying = false
      // Main knows whether our integration was actually injected (a cold WSL VM or an
      // unrecognised bash may run plain) — never guess from the shell's name.
      entry.flow.integrated = integrated === true
      armResumeTimer(id, entry)
    })
    .catch((e) => {
      // Closed while the spawn was still preparing (e.g. an ssh probe): nothing to report to.
      if (entries.get(id) !== entry || entry.startSeq !== seq) return
      entry.flow.replaying = false
      if (entry.remote) return setIdle(id, entry, "failed", { error: cleanError(e) })
      term.write(`\r\n\x1b[31m[spawn error] ${e}\x1b[0m\r\n`)
      const r = useStore.getState().resume[id]
      if (r?.phase === "pending") {
        entry.flow.resumeStage = undefined
        useStore.getState().setResume(id, {
          phase: "skipped",
          plan: { ...r.plan, reason: "the shell couldn't start" },
        })
      }
    })
  entry.flow.replaying = true
}

/** Record an ssh pane's phase here (keys) and in the store (header button, sidebar dot). */
function setPhase(id: string, entry: Entry, phase: RemotePhase) {
  entry.remote = phase
  useStore.getState().setRemotePhase(id, phase)
}

// Undo what a program on the dropped connection left on: mouse tracking, focus events,
// bracketed paste, application cursor keys; show the cursor. Otherwise clicks type escape
// codes into the next shell.
const RESET_MODES =
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?1l\x1b[?25h\x1b[0m"
// Leave a TUI's alt screen. Only when in it: on the normal screen `?1049l` also restores a
// cursor saved long ago, so the banner would overwrite old scrollback.
const LEAVE_ALT_SCREEN = "\x1b[?1049l"

/** The resets to write after a drop, for the buffer the terminal is on now. */
export function resetAfterDrop(buffer: "normal" | "alternate"): string {
  return (buffer === "alternate" ? LEAVE_ALT_SCREEN : "") + RESET_MODES
}

/** An ssh pane stops at a prompt: say why, and show Connect in its header. */
function setIdle(
  id: string,
  entry: Entry,
  phase: RemoteIdle,
  info?: { code?: number; signal?: number; error?: string },
) {
  const label = useStore.getState().sessions[id]?.remote?.label ?? "the host"
  entry.term.write(banner(idleMessage(phase, label, info)))
  setPhase(id, entry, phase)
}

/** Enter (or Connect) on an idle ssh pane: start ssh again under the same session id. */
function connectRemote(id: string, entry: Entry) {
  if (!isIdle(entry.remote)) return
  const label = useStore.getState().sessions[id]?.remote?.label ?? "the host"
  entry.term.write(banner(`connecting to ${label}…`))
  requestPty(id, entry, false)
}

function spawn(session: Session, entry: Entry) {
  if (entry.spawned) return
  entry.spawned = true
  const { term } = entry
  const store = useStore.getState()

  entry.offData = ipc.onPtyData(session.id, (bytes) => {
    term.write(bytes)
    // Generic agent-status heuristic: throttled "output" signal + an idle timer.
    // While a command runs, streaming keeps it "working"; when output goes quiet
    // for IDLE_MS the timer flips it to "attention" (agent waiting for input).
    const now = performance.now()
    if (now - (entry.lastOutputSignal ?? 0) > OUTPUT_SIGNAL_THROTTLE_MS) {
      entry.lastOutputSignal = now
      store.signalSession(session.id, { type: "output" })
    }
    clearTimeout(entry.idleTimer)
    entry.idleTimer = setTimeout(() => {
      useStore.getState().signalSession(session.id, { type: "output-idle" })
    }, IDLE_MS)
  })

  if (session.remote) {
    // A dropped link or `exit` on the host: say so, and let Enter (or Connect) reconnect.
    entry.offExit = ipc.onPtyExit(session.id, (e) => {
      if (entries.get(session.id) !== entry) return
      entry.startSeq = (entry.startSeq ?? 0) + 1 // an answer still in flight is stale now
      clearTimeout(entry.idleTimer)
      useStore.getState().signalSession(session.id, { type: "command-end" }) // nothing runs now
      entry.term.write(resetAfterDrop(entry.term.buffer.active.type))
      setIdle(session.id, entry, "closed", e)
    })
    const restore = useStore.getState().settings.ssh.restore
    requestPty(session.id, entry, firstStart(!!session.restored, restore) === "attach", session)
  } else requestPty(session.id, entry, false, session)

  // This pane was inside a Claude session when smterm quit/crashed: resume it once the shell
  // is ready. Shells with our integration (zsh/bash, incl. inside WSL) announce their first
  // prompt (OSC 133 D) — wait for it and never type blind: a slow rc may be sitting on its own
  // prompt ("update? [Y/n]") that the keystrokes would answer. If it never comes, fall back to
  // offering [Resume]. Shells without integration (pwsh, cmd, fish) get a short grace period.
  // (Never for a remote session: its shell and any Claude in it run on the host.)
  if (!session.remote && useStore.getState().resume[session.id]?.phase === "pending") {
    entry.flow.resumeStage = "await-prompt" // a first prompt typing it can arrive any time now
  }

  term.onData((data) => {
    // An ssh pane that isn't connected: Enter connects, anything else goes nowhere.
    if (entry.remote) {
      const k = onKey(entry.remote, data)
      if (k === "connect") return connectRemote(session.id, entry)
      if (k === "drop") return
    }
    ipc.ptyWrite(session.id, data)
  })

  // OSC 0/2 (window title) → live session title (shells set it to cmd/cwd;
  // agents like Claude Code can set it to the task). Manual rename still wins
  // at the tab level (store keeps tab.title as the pin).
  term.onTitleChange((title) => store.setSessionOscTitle(session.id, title))

  // OSC 7 — the shell reports its working directory (file://host/path).
  term.parser.registerOscHandler(7, (data) => {
    try {
      const path = decodeURIComponent(new URL(data).pathname)
      if (path) store.setSessionCwd(session.id, path)
    } catch {
      // malformed URL — ignore
    }
    return true
  })

  // A program asks for attention (OSC 9 message, or the terminal bell). Notify
  // only on the transition into attention (de-noise) and only when off-screen.
  const raiseAttention = (detail?: string) => {
    const wasAttention = useStore.getState().sessions[session.id]?.status === "attention"
    store.signalSession(session.id, { type: "attention", detail })
    // OS notification only when you're away from the app (the dot/bell cover the
    // in-app case), and only on the transition into attention (de-noise).
    if (!useStore.getState().windowFocused && !wasAttention) {
      const s = useStore.getState().sessions[session.id]
      const home = useStore.getState().home
      void notify(displaySessionTitle(s, home), detail || "wants your attention")
    }
  }

  // OSC 9 — desktop-notification escape (its text is the reason).
  term.parser.registerOscHandler(9, (data) => {
    raiseAttention(data || undefined)
    return true
  })
  // Terminal bell — a generic "waiting on you" from readline/prompts/agents.
  term.onBell(() => raiseAttention())

  // OSC 133;C/D — command start/finish.
  term.parser.registerOscHandler(133, (data) => {
    const kind = data.charAt(0)
    if (kind === "C") store.signalSession(session.id, { type: "command-start" })
    else if (kind === "D") {
      // Command finished at the prompt — precise idle; cancel the heuristic timer
      // so it can't later mis-flip this settled session to "attention".
      clearTimeout(entry.idleTimer)
      store.signalSession(session.id, { type: "command-end" })
    }
    const mark = parseMark(data)
    if (mark) {
      const resuming = useStore.getState().resume[session.id]?.phase === "resuming"
      const { next, actions } = onMark(entry.flow, mark, resuming)
      entry.flow = next
      for (const a of actions) {
        if (a.type === "shell-idle") {
          ipc.shellIdle(session.id)
          useStore.getState().claudeExited(session.id)
        } else if (a.type === "type-resume") typeResume(session.id, entry)
        else failResume(session.id, entry, a.exitCode)
      }
    }
    return true
  })

  // Clickable file links: detect path-like tokens on the hovered row, validate they
  // exist against the session cwd (kills false positives — versions, domains, etc.
  // that don't resolve to a file), and open on click (Cmd/Ctrl-click while a TUI holds
  // mouse mode, so a bare click still reaches the app). Single-row for now.
  // Not for remote sessions: their paths are on the host, and validating them locally
  // would turn e.g. /etc/hosts in remote output into a link to the LOCAL file.
  if (useStore.getState().settings.fileLinks && !session.remote) {
    term.registerLinkProvider({
      provideLinks(y, cb) {
        const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ""
        const cwd = useStore.getState().sessions[session.id]?.cwd
        const matches = cwd ? findFilePaths(text) : []
        if (!cwd || matches.length === 0) return cb(undefined)
        void Promise.all(matches.map((m) => validatePath(cwd, m.path)))
          .then((oks) => {
            const links = matches
              .filter((_, i) => oks[i])
              .map((m) => ({
                text: text.slice(m.start, m.start + m.length),
                range: { start: { x: m.start + 1, y }, end: { x: m.start + m.length, y } },
                decorations: { pointerCursor: true, underline: true },
                activate: (e: MouseEvent) => {
                  if (e.button !== 0) return // left-click only
                  // In plain output a bare click opens (like cmux). But when the app has
                  // mouse tracking on (Claude's live TUI, vim), a bare click belongs to the
                  // app — require Cmd/Ctrl there so we don't hijack it (VS Code does the same).
                  const mouseMode = term.modes.mouseTrackingMode !== "none"
                  if (mouseMode && !e.metaKey && !e.ctrlKey) return
                  ipc.openFile(cwd, m.path, m.line, m.col)
                },
              }))
            cb(links.length ? links : undefined)
          })
          .catch(() => cb(undefined))
      },
    })
  }
}

// Resume timings: shells without integration — a grace period before typing; with it — how
// long to wait for the first prompt before offering [Resume] instead; and how long to wait
// for Claude's SessionStart before calling the attempt failed.
const RESUME_PROMPT_GRACE_MS = 3000
const RESUME_PROMPT_WAIT_MS = 20_000
const RESUME_CONFIRM_MS = 25_000

/** Once we know whether the shell is integrated: arm the fallback for a pending resume. */
function armResumeTimer(id: string, entry: Entry) {
  if (entry.flow.resumeStage !== "await-prompt") return // already typed (the prompt came first)
  clearTimeout(entry.resumeTimer)
  entry.resumeTimer = setTimeout(
    () => (entry.flow.integrated ? offerResume(id, entry) : typeResume(id, entry)),
    entry.flow.integrated ? RESUME_PROMPT_WAIT_MS : RESUME_PROMPT_GRACE_MS,
  )
}

/** The integrated shell never showed a prompt: don't type into the unknown — offer it. */
function offerResume(id: string, entry: Entry) {
  entry.flow.resumeStage = undefined
  const r = useStore.getState().resume[id]
  if (r?.phase === "pending") useStore.getState().setResume(id, { phase: "offer", plan: r.plan })
}

/** Safe to type into this terminal (rules: canType in lib/resume-flow.ts). */
function atPrompt(entry: Entry | undefined): boolean {
  return !!entry?.spawned && canType(entry.flow)
}

/** Type the pane's resume command (one shot: main forgets the ledger entry) and arm the
 *  confirmation timeout. Success is flagged by App when Claude's SessionStart arrives. */
function typeResume(id: string, entry: Entry) {
  const r = useStore.getState().resume[id]
  clearTimeout(entry.resumeTimer)
  if (
    !r ||
    !r.plan.command ||
    (r.phase !== "pending" && r.phase !== "offer" && r.phase !== "failed")
  ) {
    entry.flow.resumeStage = undefined
    return
  }
  entry.flow.resumeStage = "typed"
  entry.flow.resumeSawStart = false
  // ^U first (POSIX line editors): drops anything typed into the line before the prompt was
  // ready, so it can't get glued onto the command.
  const posix = isPosixShell(useStore.getState().sessions[id]?.command ?? "")
  // POSIX shells: always `cd` into the session's project dir first — `claude --resume` only
  // finds that project's transcripts, and a Retry may come after the user cd'd elsewhere.
  const command = posix ? withCd(r.plan.cwd, r.plan.command) : r.plan.command
  entry.flow.claudeSeen = true
  ipc.ptyWrite(id, `${posix ? "\x15" : ""}${command}\r`)
  // The ledger entry is NOT consumed here: a quit/crash during the confirmation window must
  // still resume next time. It's consumed on failure/dismiss; success re-records it anyway.
  useStore.getState().setResume(id, { phase: "resuming", plan: r.plan })
  entry.resumeTimer = setTimeout(() => {
    if (useStore.getState().resume[id]?.phase !== "resuming") return
    if (entry.flow.integrated) failResume(id, entry)
    else {
      // No integration = no hooks and no OSC 133: Claude can't confirm it resumed, and we
      // can't tell whether it's running now. Never call it failed (and never offer buttons
      // that would type into it) — just say what was sent. The entry is kept.
      entry.flow.resumeStage = undefined
      const plan = useStore.getState().resume[id]!.plan
      useStore.getState().setResume(id, { phase: "sent", plan })
    }
  }, RESUME_CONFIRM_MS)
}

function failResume(id: string, entry: Entry, exitCode?: number) {
  clearTimeout(entry.resumeTimer)
  entry.flow.resumeStage = undefined
  // One shot: never retry a failing session on the next launch (main only drops the exact
  // carried-over entry — a late success that re-recorded it this run is kept).
  const plan = useStore.getState().resume[id]?.plan
  if (plan) ipc.resumeConsume(id, plan.sessionId)
  const r = useStore.getState().resume[id]
  if (r) useStore.getState().setResume(id, { phase: "failed", plan: r.plan, exitCode })
}

function syncSize(id: string, entry: Entry) {
  try {
    entry.fit.fit()
    const { cols, rows } = entry.term
    // Only resize the PTY when the character grid actually changed. A split/layout
    // reflow can fire ResizeObserver without changing a pane's grid; resizing anyway
    // would SIGWINCH the running program and make it redraw for nothing.
    if (gridChanged(entry.lastGrid, cols, rows)) {
      entry.lastGrid = { cols, rows }
      ipc.ptyResize(id, cols, rows)
    }
  } catch {
    // Container not measurable yet; a later fit() call will settle it.
  }
}

// Off-screen parking for every terminal that isn't on screen (hidden surfaces, background
// tabs). In the document, so xterm can open + measure (themes, OSC 10/11 colour replies,
// ligatures all need an opened terminal), but outside the viewport — xterm pauses rendering
// for a non-intersecting terminal, so parked output costs no paint — and `inert`, so Tab
// can't focus a parked terminal's textarea.
let parking: HTMLDivElement | null = null
function parkingLot(): HTMLDivElement {
  if (!parking) {
    parking = document.createElement("div")
    parking.inert = true
    parking.style.cssText =
      "position:fixed;left:-100000px;top:0;width:1000px;height:600px;overflow:hidden;pointer-events:none"
    document.body.appendChild(parking)
  }
  return parking
}

/** Open an entry's xterm into its (already connected) host + wire its focus signal. */
function openEntry(session: Session, entry: Entry) {
  entry.term.open(entry.host) // DOM renderer by default; WebGL added by reconcile
  entry.opened = true
  // Make this pane active whenever its terminal actually gains focus (click or
  // keyboard). This is the reliable signal: a mousedown handler on the pane
  // container misses clicks inside an agent TUI (mouse-tracking on), because
  // xterm's selection service stopPropagation()s those mousedowns — which left
  // the active pane stuck on the last-added one, so splits targeted the wrong pane.
  entry.term.textarea?.addEventListener("focus", () => {
    if (suppressFocusSignal) return
    useStore.getState().focusSession(session.id)
  })
  applyLigatures(entry, useStore.getState().settings.font.ligatures)
}

function entryFor(id: string): Entry {
  let entry = entries.get(id)
  if (!entry) {
    entry = build()
    entries.set(id, entry)
  }
  return entry
}

export const TerminalManager = {
  /** Run a hidden surface off-screen (PTY + status/cwd wiring), sized like `sizeLike`. */
  ensureRunning(session: Session, sizeLike?: string) {
    const entry = entryFor(session.id)
    if (entry.spawned) return
    if (!entry.opened) {
      parkingLot().appendChild(entry.host)
      openEntry(session, entry)
    }
    if (sizeLike) TerminalManager.followSize(session.id, sizeLike)
    spawn(session, entry)
  },

  /** Hidden surfaces of `pane` (all panes if omitted) take their pane's visible grid. */
  syncHiddenSizes(pane?: PaneLeaf) {
    const panes = pane ? [pane] : useStore.getState().tabs.flatMap((t) => allPanes(t.root))
    for (const p of panes) {
      for (const id of p.sessionIds) {
        if (id !== p.activeSessionId) TerminalManager.followSize(id, p.activeSessionId)
      }
    }
  },

  /** Give a hidden surface its pane's grid (it can't self-fit); PTY resized only on change. */
  followSize(id: string, likeId: string) {
    const entry = entries.get(id)
    const like = entries.get(likeId)
    if (!entry || !like?.opened) return
    const { cols, rows } = like.term
    if (!gridChanged(entry.lastGrid, cols, rows)) return
    try {
      entry.term.resize(cols, rows)
    } catch {
      return // invalid size — keep the current grid
    }
    entry.lastGrid = { cols, rows }
    if (entry.spawned) ipc.ptyResize(id, cols, rows) // else spawn() sends this size
  },

  /** Mount a session's terminal into `container`, creating + spawning on first use. */
  attach(session: Session, container: HTMLElement) {
    const entry = entryFor(session.id)
    container.appendChild(entry.host)
    if (!entry.opened) {
      openEntry(session, entry)
      syncSize(session.id, entry)
      spawn(session, entry)
    } else {
      syncSize(session.id, entry) // re-attach (incl. a parked surface): fit + resize its PTY
      spawn(session, entry) // no-op when already running
    }
    reconcileRenderers() // this pane is now on-screen — (re)acquire WebGL if apt
    // Keyboard focus follows the STORE's focus: only the tab's focused session takes it on
    // (re)attach — a split/tab-switch mount storm, or a surface revealed in an unfocused
    // pane, must not pull keystrokes away from the pane the user is driving.
    const st = useStore.getState()
    if (st.tabs.find((t) => t.id === st.activeTabId)?.activeSessionId === session.id) {
      suppressFocusSignal = true
      entry.term.focus()
      suppressFocusSignal = false
    }
    // Reparenting the host (e.g. on split) moves the live WebGL canvas, which then
    // shows stale/garbled pixels until the next draw. Repaint on the next frame,
    // once the moved canvas has laid out. (This is the trigger PR #3's repair missed.)
    requestAnimationFrame(() => repairRenderers())
  },

  /** Resume banner actions: (re)type the pane's resume command now (offer / retry) — only
   *  at a shell prompt; returns whether it typed. */
  resumeNow(id: string): boolean {
    const entry = entries.get(id)
    if (!entry || !atPrompt(entry)) return false
    typeResume(id, entry)
    return true
  },

  /** A Claude session started in this terminal (its SessionStart hook): a returning prompt
   *  now means Claude exited; and any earlier Ctrl-Z'd job no longer masks that. */
  /** A hook event came from this pane: Claude runs (or ran) here. */
  claudeActive(id: string) {
    const entry = entries.get(id)
    if (entry) entry.flow.claudeSeen = true
  },

  claudeStarted(id: string) {
    const entry = entries.get(id)
    if (!entry) return
    entry.flow.claudeSeen = true
    entry.flow.suspendedJob = false
  },

  /** Claude confirmed the resume (its SessionStart arrived) — stop watching for failure. */
  resumeSettled(id: string) {
    const entry = entries.get(id)
    if (!entry) return
    clearTimeout(entry.resumeTimer)
    entry.flow.resumeStage = undefined
  },

  /** Type a command into a terminal's shell (banner actions: pick a session, start Claude) —
   *  only at a prompt; returns whether it typed. */
  runCommand(id: string, command: string): boolean {
    if (!atPrompt(entries.get(id))) return false
    // ^U first (POSIX line editors): a half-typed line must not get glued onto the command.
    const posix = isPosixShell(useStore.getState().sessions[id]?.command ?? "")
    ipc.ptyWrite(id, `${posix ? "\x15" : ""}${command}\r`)
    return true
  },

  /** Park a terminal off-screen, unless it has since been attached to another container. */
  detach(id: string, container: HTMLElement) {
    const entry = entries.get(id)
    if (entry && entry.host.parentElement === container) parkingLot().appendChild(entry.host)
  },

  reconcileRenderers,
  repairRenderers,

  fit(id: string) {
    const entry = entries.get(id)
    if (entry?.opened) syncSize(id, entry)
  },

  focus(id: string) {
    entries.get(id)?.term.focus()
  },

  // Clipboard actions for the pane context menu (keyboard is handled in build()).
  hasSelection(id: string): boolean {
    return entries.get(id)?.term.hasSelection() ?? false
  },
  copySelection(id: string) {
    const sel = entries.get(id)?.term.getSelection()
    if (sel) ipc.clipboardWrite(sel)
  },
  paste(id: string) {
    const entry = entries.get(id)
    if (entry) pasteInto(entry.term)
  },
  selectAll(id: string) {
    entries.get(id)?.term.selectAll()
  },

  // Find-in-scrollback (drives @xterm/addon-search on the focused pane).
  // `incremental` (type-as-you-go) keeps the current match rather than advancing.
  searchNext(id: string, query: string, caseSensitive: boolean, incremental = false) {
    entries.get(id)?.search.findNext(query, searchOptions(caseSensitive, incremental))
  },
  searchPrevious(id: string, query: string, caseSensitive: boolean) {
    entries.get(id)?.search.findPrevious(query, searchOptions(caseSensitive, false))
  },
  clearSearch(id: string) {
    entries.get(id)?.search.clearDecorations()
  },
  /** Subscribe to result counts ({resultIndex, resultCount}); returns an unsubscribe. */
  onSearchResults(id: string, cb: (r: { resultIndex: number; resultCount: number }) => void) {
    const entry = entries.get(id)
    if (!entry) return () => {}
    const d = entry.search.onDidChangeResults(cb)
    return () => d.dispose()
  },

  /** Apply settings (font/theme/etc.) to every live terminal. */
  applySettings(settings: Settings) {
    // The resolved variant (dark/light, or the OS's for "system") — not just the family name.
    const theme = activeTheme({ settings, systemDark: useStore.getState().systemDark }).terminal
    for (const [id, entry] of entries) {
      const o = entry.term.options
      o.fontFamily = fontStack(settings.font.family)
      o.fontSize = settings.font.size
      o.lineHeight = settings.font.lineHeight
      o.cursorBlink = settings.cursorBlink
      o.scrollback = settings.scrollback
      o.theme = theme
      if (!entry.opened) continue // joiner registration throws on an unopened xterm
      applyLigatures(entry, settings.font.ligatures)
      if (entry.host.parentElement !== parking) syncSize(id, entry)
    }
    // Hidden surfaces can't refit off-screen — give them their pane's new grid.
    TerminalManager.syncHiddenSizes()
    // A `renderer` change (webgl ↔ dom) takes effect live: acquire/release WebGL to
    // match, on the current visible panes.
    reconcileRenderers()
  },

  /** The pane header's Connect: same as Enter on an idle ssh pane. */
  connect(id: string) {
    const entry = entries.get(id)
    if (entry) connectRemote(id, entry)
  },

  dispose(id: string) {
    const entry = entries.get(id)
    if (entry) clearTimeout(entry.resumeTimer)
    // No entry = never started in this renderer (e.g. a hidden surface after a reload), but
    // main may still hold its PTY — always kill (an unknown id is a no-op there).
    if (!entry) return ipc.ptyKill(id)
    clearTimeout(entry.idleTimer)
    releaseWebgl(entry)
    entry.offData?.()
    entry.offExit?.()
    ipc.ptyKill(id)
    entry.term.dispose()
    entry.host.remove()
    entries.delete(id)
  },
}
