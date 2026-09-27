# Architecture — smterm (Cross-Platform Terminal App)

> A cmux-inspired terminal app for running (and watching) multiple shell/agent sessions. No embedded
> browser — links open in the OS default browser. Native desktop notifications. Runs on **macOS,
> Linux, Windows, and WSL**.

Status: **Electron** (ported from Tauri in July 2026 for rendering fidelity + cross-platform
consistency — see §3.5). Shipping as v0.x; progress in `ROADMAP.md`, traps in `GOTCHAS.md`.

### Decisions locked

- **Purpose** (2026-07-06): coding-agent runner (cmux-like) — running/watching multiple agent
  sessions; notifications & per-session "attention" state are headline features.
- **Frontend** (2026-07-06): React + TypeScript, Zustand.
- **Layout** (2026-07-06): tabs **+ split panes**.
- **Windows/WSL** (2026-07-06): native app that spawns `wsl.exe`; never run inside WSL.
- **Shell / renderer** (2026-07-07): **Electron (Chromium) + xterm.js WebGL renderer.** Chosen over
  Tauri after Tauri's WKWebView caused recurring glyph-rendering bugs (§3.5). Chromium gives one
  consistent engine on all OSes + the fast WebGL renderer (ligatures + icons + speed).
- **Name** (2026-07-06): stays `smterm` (the `mux` design's brand label maps to `smterm`).
- **Code conventions** (2026-07-07): **kebab-case filenames** (`terminal-manager.ts`), **no
  semicolons** (Prettier `semi: false`). See §13.

---

## 1. Goals & non-goals

### Goals

- Run and **watch multiple coding-agent / shell sessions** in one window (tabs **+ split panes**).
- Per-session **status & "attention" state** (running / idle / waiting-for-input) at a glance.
- Real PTY-backed shells — full interactive programs work (vim, top, TUIs, coding agents).
- **Native OS notifications** — an agent finishes / asks for input while its tab is unfocused.
- **Clickable links open the OS default browser** (no embedded webview browsing).
- One codebase, four targets: macOS, Linux, Windows, WSL — **rendered by one Chromium everywhere**.
- Correct, fast rendering (Nerd icons, box-drawing, ligatures) via the WebGL renderer.

### Non-goals (v1)

- Embedded browser / web panel (cmux has this; we deliberately don't).
- Reconnecting to sessions after the app quits (needs a daemon or tmux — see Appendix A).
- Remote/SSH as a first-class feature (you can still `ssh` inside a shell).
- Mobile / web builds.

---

## 2. Cross-platform strategy

### 2a. One PTY abstraction for all OSes — `node-pty`

**`node-pty`** (Microsoft; what VS Code uses) presents one API and picks the OS backend:

| OS            | PTY backend used by `node-pty`                     |
| ------------- | -------------------------------------------------- |
| macOS / Linux | `forkpty` (Unix PTY)                               |
| Windows       | **ConPTY** (the modern Windows pseudo-console API) |

It runs in the Electron **main process** (Node). It's callback/`onData`-based — no threads or
mutexes needed (simpler than the previous Rust `portable-pty` bridge).

### 2b. On Windows, the app is a native app; WSL is just a _shell target_

- **Do:** run the app as a normal Windows desktop app; spawn WSL shells via `wsl.exe [-d <distro>]`
  through ConPTY.
- **Don't:** run the app _inside_ WSL (WSLg) — flaky notifications, awkward browser-open, harder packaging.

From one Windows install the user gets PowerShell, cmd, **and** full WSL terminals — with
notifications, link-open, and packaging all using native APIs.

### Cross-platform capability matrix

| Concern       | macOS                | Linux                      | Windows                | WSL                   |
| ------------- | -------------------- | -------------------------- | ---------------------- | --------------------- |
| PTY           | `node-pty` forkpty   | `node-pty` forkpty         | `node-pty` ConPTY      | `wsl.exe` via ConPTY  |
| Default shell | `$SHELL` (zsh)       | `$SHELL` (bash/zsh)        | PowerShell / cmd       | distro default (bash) |
| Open link     | `shell.openExternal` | `shell.openExternal`       | `shell.openExternal`   | (Windows host)        |
| Notifications | `Notification`       | `Notification` (libnotify) | `Notification` (toast) | (Windows host)        |
| Package       | `.dmg`               | AppImage / `.deb` / `.rpm` | `.exe` (NSIS)          | (uses Windows build)  |
| Renderer      | **Chromium/WebGL**   | **Chromium/WebGL**         | **Chromium/WebGL**     | (Windows host)        |

All provided by `node-pty` + Electron APIs + `electron-builder` — plus a small shell-selection map.

---

## 3. Tech stack

| Layer               | Choice                                          | Why                                                                        |
| ------------------- | ----------------------------------------------- | -------------------------------------------------------------------------- |
| Shell / packaging   | **Electron** + `electron-builder`               | One Chromium on all OSes; mature ecosystem; VS Code's stack                |
| Build               | **electron-vite** (Vite: main/preload/renderer) | Fast HMR; one Vite config for all three Electron layers                    |
| Terminal renderer   | **xterm.js + WebGL addon**                      | VS Code's renderer — GPU-fast, correct glyphs + ligatures in Chromium      |
| PTY backend         | **`node-pty`** (main process)                   | The most battle-tested PTY lib; ConPTY + Unix PTY; `onData` (no threads)   |
| Frontend            | **React + TypeScript + Zustand**                | Familiar; fast to build tabs/panes/state                                   |
| Renderer↔main IPC   | **preload `contextBridge`** + `ipcMain`         | Safe, typed bridge (contextIsolation on); one `ipc.ts` adapter in renderer |
| Open link           | Electron `shell.openExternal`                   | OS default browser                                                         |
| Notifications       | Electron `Notification`                         | OS-native toasts                                                           |
| File watch          | `chokidar`                                      | Watch `settings.json` for live reload                                      |
| Icons / chrome font | `@phosphor-icons/react`, bundled Geist Mono     | For the `mux` reskin (§ ROADMAP M3.5)                                      |

**Backend footprint:** the Electron main process (`node-pty` + fs + IPC handlers) is small; almost
everything is the React/TS renderer.

---

## 3.5 Rendering & the WKWebView lesson (why Electron)

Building on Tauri (macOS WKWebView) we hit a stack of glyph bugs — the reason for the pivot:

1. **System-font PUA substitution:** WebKit renders a tofu box for Private-Use-Area (Nerd/Powerline)
   glyphs from _system-installed_ fonts. Fix: **bundle the font** as `@font-face`.
2. **Fast-renderer glyph bugs:** xterm's canvas **and** WebGL addons rasterize glyphs themselves into
   an atlas; the old (xterm-5.5-era) addons mis-rendered box arcs (`╰`) and icons **in WKWebView**.
   We were forced onto the slow **DOM renderer** for correctness — which cannot do ligatures.

Root cause: **the fast renderers are developed/tested against Chromium; WKWebView is a second-class
target.** On **Chromium (Electron)** the WebGL renderer renders everything correctly _and_ fast —
exactly why VS Code (same xterm.js!) looks flawless. Chromium also renders identically on all three
OSes, eliminating the per-webview whack-a-mole Tauri would force (WKWebView / WebView2 / WebKitGTK).

**Consequences we keep from this lesson:**

- **Bundle the terminal font** (`FiraCode Nerd Font Mono`, `@font-face`) regardless — deterministic,
  portable, offline.
- Use the **WebGL renderer** (canvas/DOM fallback on context loss). Ligatures come back (character
  joiner works on WebGL).
- Cost accepted: larger bundle (~150 MB) and higher idle RAM than Tauri — the deliberate price of
  rendering correctness + cross-platform consistency.

---

## 4. High-level architecture

```
┌────────────────────── Renderer process (Chromium) ──────────────────────┐
│  React UI: tab bar · sidebar tree · terminal grid · status bar           │
│     ├── <TerminalPane> (one per session)                                 │
│     │      xterm.js  ── addons: webgl, fit, web-links, unicode11          │
│     │        ▲ bytes (WebGL render)        │ keystrokes                   │
│     └── stores (Zustand): sessions · pane tree · settings · status        │
│              │  window.smterm.*  (typed preload API)                      │
└──────────────┼────────────────────────────────────────────────────────────┘
               │  contextBridge  ↕  ipcRenderer / ipcMain
┌──────────────┴──────────────────── Main process (Node) ───────────────────┐
│  IPC handlers: pty:spawn/write/resize/kill · shells:list · settings:*      │
│  node-pty: Map<sessionId, IPty>  (onData → stream to renderer)             │
│  fs + chokidar (settings.json) · Notification · shell.openExternal          │
│  window lifecycle: kill all PTYs on close                                   │
└──────────────────────────────────────────────────────────────────────────┘
                   │ spawns
        zsh / bash / powershell.exe / cmd.exe / wsl.exe
```

---

## 5. Features & how we achieve each

| #   | Feature                           | How                                                                     | Effort |
| --- | --------------------------------- | ----------------------------------------------------------------------- | ------ |
| F1  | Real interactive terminal         | xterm.js ⇄ `node-pty` (§7)                                              | Core   |
| F2  | Multiple sessions (tabs)          | Session store in TS; one xterm + one PTY per session                    | Core   |
| F3  | Cross-platform shells             | Shell-selection map (§6) + `node-pty` (ConPTY/Unix)                     | Core   |
| F4  | WSL sessions                      | On Windows, spawn `wsl.exe [-d distro]` (§2b)                           | Core   |
| F5  | Clickable links → default browser | `@xterm/addon-web-links` → `shell.openExternal`                         | Small  |
| F6  | Native notifications              | Electron `Notification`, triggered by §9 rules                          | Small  |
| F7  | Resize handling                   | `@xterm/addon-fit` on container resize → `pty:resize`                   | Small  |
| F8  | Fast rendering                    | `@xterm/addon-webgl` (canvas/DOM fallback)                              | Small  |
| F9  | Scrollback + search               | xterm scrollback + `@xterm/addon-search`                                | Small  |
| F10 | Copy / paste                      | xterm selection + clipboard                                             | Small  |
| F11 | Persist layout                    | Save tabs/cwd/split tree to config JSON; restore (fresh PTYs) on launch | Medium |
| F12 | Session titles / rename           | OSC 0/2 title escapes + manual rename                                   | Small  |
| F13 | Themes / fonts / **ligatures**    | Token themes → xterm theme + CSS vars; bundled fonts; WebGL ligatures   | Small  |
| F14 | **Split panes**                   | Binary pane tree; resizable (react-resizable-panels) (§8)               | Core   |
| F15 | **Per-session status/attention**  | OSC 133 / OSC 9 / output-idle → badges; drives notifications (§9)       | Core   |
| F16 | Session overview                  | Sidebar tree + tab badges                                               | Medium |

---

## 6. Shell selection

- **macOS/Linux:** `$SHELL` → fallback `/bin/zsh` (mac) / `/bin/bash` (linux).
- **Windows:** `pwsh.exe` → `powershell.exe` → `cmd.exe`.
- **WSL (from Windows):** `wsl.exe` (default) or `wsl.exe -d <distro>`; enumerate via `wsl.exe -l -q`.

Resolved in the main process; exposed via `shells:list` for the "New ▾" picker. Per-shell **shell
integration** (OSC 133) is injected without editing dotfiles: zsh via a `ZDOTDIR` wrapper, bash via
`--rcfile` (the `.zsh`/`.bash` scripts are reused from the Tauri build verbatim).

---

## 7. The PTY layer (main process, `node-pty`)

Simpler than the old Rust bridge — `node-pty` is async by default:

- **State:** `Map<sessionId, IPty>` in the main process.
- **`pty:spawn(id, {cols, rows, shell, args, cwd})`** → `pty.spawn(shell, args, {name:'xterm-256color',
cols, rows, cwd, env})`; apply shell-integration env/args; `pty.onData(d => send('pty:data:'+id, d))`.
- **`pty:write(id, data)`** → `pty.write(data)`.
- **`pty:resize(id, cols, rows)`** → `pty.resize(cols, rows)`.
- **`pty:kill(id)`** → `pty.kill()`, drop from the map.
- **Cleanup:** on `window close`/`before-quit`, kill all PTYs (no orphans).

Output stream: main → renderer via `webContents.send('pty:data:'+id, Uint8Array)` (or a per-session
`MessageChannelMain` port for higher throughput). Renderer decodes with xterm's UTF-8 handling.

---

## 8. Frontend design (React + TypeScript)

- **Stores (Zustand):** `Session { id, title, cwd, shell, status, unread }`, a per-tab binary
  **pane tree**, and `settings`.
- **Layout model:** each tab holds a binary pane tree — leaf or split (`row`/`column`, two
  children). A leaf is a **pane** holding one or more terminals (**surfaces**, cmux-style) shown
  as tabs in its header (`{id, sessionIds, activeSessionId}`); only the active surface is
  mounted. Resizable dividers; each leaf resize → fit → `pty:resize`. Hidden surfaces keep
  running: their xterm is opened in an off-screen, `inert` **parking** element (xterm pauses
  rendering off-viewport, so no paint cost) and takes its pane's grid via `followSize`.
  `workspace.json` v2 persists surfaces (v1 leaves migrate; each v2 leaf also writes a legacy
  `sessionId` so older builds still restore).
- **Drag & drop:** a surface tab drags onto another pane's edge (new split on that side),
  centre (join), or a slot in any pane's header strip (reorder / join there). Pure
  `dropZone`/`insertIndex` (geometry) + `canMove`/`moveSurface` (pane-tree); a transparent
  overlay covers the terminal only while dragging (xterm's canvas swallows drag events).
- **Claude session colour:** Claude Code's `/color` / `/rename` are recorded only in its session
  transcript (`agent-color` / `custom-title` JSONL lines — no terminal escape). Main tracks each
  Claude pane's transcript (located via its hook events; `fs.watch` + debounced incremental fold,
  `electron/agent-meta.ts`) and pushes `{paneId, meta}` → a 2px top border + tab/sidebar icon in
  that colour; a renamed session without `/color` gets a stable colour from its name.
- **Theming:** each theme is a **family** with a dark and a light variant (Minimal, Tokyo Night,
  Catppuccin, Gruvbox); `settings.appearance` = `dark` | `light` | `system` (follows the OS live)
  picks the variant, resolved by `activeTheme()`. A variant is UI tokens (→ CSS vars) + an xterm
  palette; light palettes keep ANSI black dark. Launch never flashes dark: an inline
  `index.html` script applies the cached tokens pre-paint, theming waits for `settingsLoaded`,
  and the native window bg follows the theme (GOTCHAS #first-paint-theme).
- **Sidebar meta:** per terminal — Claude's last reply (from the `Stop` hook), `branch • cwd`,
  and `PR #n <state>` (`electron/pane-git.ts`: `git rev-parse` + the user's own `gh pr view`
  for the checked-out branch; cached per folder / repo+branch with state-based TTLs, deduped,
  ≤2 gh processes; branches return immediately while PRs load in the background). Polled by the
  renderer every 10 s + on `cd`, paused while the sidebar is collapsed or the window hidden.
- **`terminal-manager.ts`:** owns xterm instances **outside the React tree**, keyed by session id, so
  splits/tab-switches re-attach (never respawn). Loads addons (webgl, fit, web-links); registers the
  ligature character-joiner; wires OSC 9 / OSC 133. Off-screen terminals are **parked** (opened
  in an inert off-viewport element — GOTCHAS #hidden-terminals).
- **Agent observability** (design: `docs/design/AGENT_OBSERVABILITY.md`): Claude Code hooks are
  injected per launch and write each event as a **file** into a nonce-named drop dir
  (`agent-hooks.ts`) — no ports, crosses the WSL boundary. Events feed the Agents board, the
  sidebar snippet and, via the session transcript (read incrementally, best-effort —
  `transcript-fold.ts`), the token badge and the session colour.
- **IPC:** all backend calls go through `lib/ipc.ts` → `window.smterm.*` (preload). Components never
  touch Electron directly (keeps them testable + portable).
- **Chrome:** tab bar, sidebar tree, status bar, ⌘K palette (mux reskin — ROADMAP M3.5).

---

## 9. Notifications design

Trigger sources (progressive):

1. **OSC 9** (`ESC ] 9 ; msg BEL`) — a program/agent explicitly requests attention. Primary path.
2. **OSC 133;C/D** shell-integration marks → working/idle (auto-injected, §6).
3. **Output-idle heuristic** — streaming → working; quiet ~1–1.5s → waiting/needs-input (generic).
4. **Focus awareness** — only fire when the session's tab isn't visible; click focuses that pane.

Delivery via Electron `Notification`. On macOS/Windows a **signed/identified app** is needed for
reliable delivery — handled at packaging (§10). (This was unverifiable on the Tauri dev build; on
Electron, notifications work in dev too.)

### 9a. Agent-status state machine — current design & a known flaw ⚠️

**What's implemented** (`src/lib/session-status.ts` reducer + `terminal/terminal-manager.ts` signals):

- Three statuses per session: `idle` / `working` ("running") / `attention` ("needs input").
- A **`running`** flag tracks OSC 133 **C..D** (a command started but hasn't finished). `working`
  status is driven by it.
- **`attention`** is raised by: OSC 9 (message → the reason), the terminal **bell**, or the
  **output-idle** heuristic (a `running` session that goes quiet ~1.2 s while off-screen).
- **Visibility is per-focused-pane** (`isVisibleIn`): the heuristic never flags the pane you're
  driving. Focusing/revealing a pane runs `seen()` → clears attention (a still-`running` session
  falls back to `working`, not `idle`). OS notifications fire on the transition into attention, only
  when the window is unfocused.

**The flaw (documented 2026-07-08; fix deferred, needs many tests).** `running` = _process alive_
(C..D), which is **not** the same as _actively working_. For an interactive agent (`claude`), OSC 133
`C` fires once at launch and `D` only fires on exit — so `running` stays true the whole session,
whether it's generating or waiting. Consequences the user hit:

1. **needs-input → running on focus:** `seen()` sees `running === true` and promotes a _waiting_
   agent's `attention → working`, so it wrongly reads "running" after you look at it.
2. **re-notify on leave:** focusing a pane triggers a TUI **redraw** (re-attach/resize) → that repaint
   is **output** → re-arms the idle timer → when you switch away it fires `output-idle` → attention
   again → a fresh (duplicate) notification, even though nothing new happened.

**Intended fix** (activity-based, latched — _to build with a proper test matrix_): derive `working`
from **recent output activity** (streaming) rather than C..D process-liveness; make `attention` a
**latch** that clears on view and only **re-arms after genuinely new activity** (a new streaming burst
since you last saw it), so a stale waiting-state can't re-nag; on focus, show `working` only if it's
actually streaming, else a calm state. Needs a `lastActivityAt` + "seen-since-activity" marker and
**substantial unit tests** across the timing/visibility/latch matrix before it replaces the current
reducer. See ROADMAP M3.6.

---

## 10. Packaging & distribution

`electron-builder` produces installers per OS:

- **macOS:** `.dmg` / `.app`; **codesign + notarize** (Apple Developer, $99/yr) for Gatekeeper + notifications.
- **Windows:** `.exe` (NSIS); code-signing cert avoids SmartScreen; sets app identity for toasts.
- **Linux:** **AppImage** / `.deb` / `.rpm`; notifications via libnotify.

CI: GitHub Actions matrix (macos/ubuntu/windows). Auto-update later via `electron-updater`.

> Reality check: signing/notarization is still the most tedious part — budget for it.

---

## 11. IPC / event model

- **The seam:** every channel is declared twice — the runtime in `electron/preload.ts`
  (`window.smterm`) and the types in `src/lib/ipc.ts`; change both together. Components never
  import Electron.
- **Renderer → main** (`invoke` for answers, `send` for fire-and-forget), by family: `pty:*`
  (spawn = attach-or-spawn, write, resize, kill) · `shells:list` · `settings:*` / `workspace:*`
  (read/write the JSON files) · `git:status` / `git:diff` (changes panel) · `pane:git-info`
  (sidebar branch + PR) · `agents:meta-snapshot` · `fs:*` / `file:*` / `dialog:pick-directory` /
  `editor:info` (files panel, links, preview) · `window:*` (frameless controls, native bg) ·
  `platform:info` · `app:*` (version, update check, metrics) · `open-external` / `open-path` /
  `notify` / `clipboard:*` · `ssh:list-hosts` (invoke) / `ssh:open-config` (send).
- **Main → renderer** (`webContents.send`): `pty:data:<id>` (coalesced PTY bytes — the hot path;
  nothing else rides it) · `pty:exit:<id>` (the process ended on its own) · `ssh-hosts-changed`
  · `agents:events` (hook batches + token totals) · `agents:meta`
  (per-pane Claude colour/name) · `settings-changed` · `window:maximize-change`.
- **Security:** `contextIsolation: true`, `nodeIntegration: false`; the renderer only sees the
  typed API the preload exposes.

---

## 12. Persistence & session lifetime

Config dir: `~/.config/smterm/` (`%APPDATA%\smterm\` on Windows) — `smterm-<profile>` for a
non-default profile; a dev build is `smterm-dev` (GOTCHAS #profiles).

- **`settings.json`** — the source of truth for preferences (font, theme family + appearance,
  renderer, shell, …). A `chokidar` watcher applies hand-edits live; the settings panel writes
  the same file. `mergeSettings` validates everything and maps legacy values.
- **`workspace.json`** — the layout: tabs, pane trees with their surfaces, focus, right-panel
  width, and enough per session to respawn it (shell, args, cwd). **v2** leaves are
  `{id, sessionIds, activeSessionId}` plus a legacy `sessionId` mirror so an older build still
  restores every pane; v1 files migrate on read. A file from a **newer** build is not parsed
  and not overwritten. Restore de-duplicates / prunes broken entries.
- **`agent-sessions.json`** — which Claude session each terminal is inside, so a relaunch can
  type `claude --resume <id>` back into it (GOTCHAS #resume).
- **Small caches:** `window-bg` (native window colour for the next launch), `claude-hooks.json`
  and the per-launch `hook-events/` drop dir, and localStorage `smterm:theme-vars` (first paint).
- **Process lifetime:** PTYs live in the main process, so they **survive a renderer reload**
  (attach-or-spawn reattach + replay). They **die on a full quit** (guarded by a confirm
  dialog); relaunch respawns shells at the saved cwd. Surviving a quit needs the daemon
  (Appendix A, ROADMAP M5). Terminals start lazily per tab: after a restore only the active
  tab's panes spawn; a background tab's shells start when it's first shown.

---

## 12a. SSH remotes

Design: `docs/design/SSH_REMOTES.md`; build log: `docs/design/SSH_IMPLEMENTATION_PLAN.md`.

- **Hosts come from `~/.ssh/config` only** (plus each running WSL distro's). `electron/ssh-config.ts` reads it (Includes, conditional blocks, first value wins) into aliases;
  `ssh-service.ts` keeps the merged list, watched by one chokidar watcher, and tells the
  renderer on change. No host is defined in smterm.
- **Main trusts only its own list.** A remote session carries a `RemoteRef` (host id, label,
  target, env); on `pty:spawn` main looks the id up in its list and builds the argv itself
  (`ssh [keepalive] -t -- <alias>`, or `wsl.exe -d <distro> -e ssh …`). An unknown host is
  refused, never run as a bare alias.
- **Plain ssh.** No connection reuse, no shell integration, no local cwd: OSC 7, file links,
  git and the Files panel are off for remote panes (their paths are on the host).
- **One spawn per pane** (`pending-spawns.ts`): building the plan is async, so a reload joins
  the pending spawn, a close means it never starts, and keys typed before ssh exists are
  dropped (never echoed ahead of a password prompt).
- **Lifecycle in the renderer** (`lib/remote-connect.ts`, pure): `pty:exit:<id>` turns a pane
  `closed`, a refused spawn `failed`, a restored pane under `ssh.restore = "on-focus"`
  `waiting` (it asks main with `attachOnly`, so a reload still reattaches a live ssh). Idle
  panes drop keys; Enter or the header's Connect respawns the same session id.

---

## 13. Code conventions

- **Filenames: kebab-case** — `terminal-manager.ts`, `tab-bar.tsx`, `session-status.ts`. Component
  _exports_ stay PascalCase (`export function TabBar`); only file names are kebab. Enforced by eslint
  `unicorn/filename-case`.
- **No semicolons** — Prettier `semi: false`.
- Short one-line docstrings on non-obvious functions (see CLAUDE.md).
- Tests with the feature; push logic into pure functions and test those.

---

## 14. Risks & mitigations

| Risk                                  | Mitigation                                                            |
| ------------------------------------- | --------------------------------------------------------------------- |
| Electron bundle size / RAM            | Accepted trade for rendering + cross-platform consistency; trim later |
| WebGL context loss                    | `onContextLoss` → dispose + fall back to canvas/DOM renderer          |
| node-pty native module across OSes/CI | Prebuilt binaries; rebuild in CI matrix; test PTY on all 3 OSes       |
| Notifications need app identity       | Sign macOS build; set app identity for Windows toasts                 |
| WSL complexity                        | Treat WSL as a shell target on a native Windows app (§2b)             |
| Orphaned shells                       | Kill all PTYs on window close / before-quit                           |
| High-throughput output jank           | WebGL renderer + `MessageChannelMain`; cap scrollback                 |

---

## 15. Decisions

Resolved: purpose (agent-runner), React+TS+Zustand, tabs+splits, native-Win+`wsl.exe`, **Electron +
xterm WebGL** (2026-07-07), name `smterm`, kebab-case + no-semicolons.

Open: notification triggers to ship first (rec: OSC 9 + output-idle); whether/when to adopt
**libghostty** (native core; would need Electron-native embedding — tracked as a future core decision).

---

## 16. Milestones

- **M0–M3a (done, Tauri):** spike, multi-session + splits, agent-runner signals (notifications +
  status + shell integration), file-first settings/fonts/themes. Logic + docs carry over.
- **MΩ — Electron port (current):** re-establish M0–M3a on Electron (node-pty + IPC + WebGL); apply
  conventions; re-enable ligatures. See ROADMAP.
- **M3.5 — `mux` reskin + agent awareness:** design tokens/chrome/palette, output-idle status, git
  files-in-flight.
- **M4 — Packaging:** signed cross-platform builds via CI.
- **M5 (later):** approvals/orchestration, session reattach (Appendix A), auto-update.

---

## Appendix A — Session persistence via a detached daemon (design sketch)

> **Status: exploratory, post-v1.** Not on the v1 path — written down so the port doesn't foreclose it.
> The one actionable takeaway for now is [A.6](#a6-what-to-keep-cheap-now).

### A.1 What it buys us

Session **outlives the UI**: an agent keeps running after you close the window; you reattach to the
live screen later. ✅ close/reopen → still running; ✅ GUI crash → shells survive; ✅ (later) attach
from a second view. ❌ survive machine reboot (tmux doesn't either); ❌ our own remote daemon (wrap
existing `tmux` instead — A.5).

### A.2 The core move: split the PTY owner from the UI

Today the Electron **main process** owns the `node-pty` map _and_ the window. Persistence means moving
PTY ownership into a long-lived **detached daemon** (a separate Node process, `smterm-daemon`), with
the Electron app as a **thin client** that connects over a socket, sends keystrokes/resizes, and
paints byte streams. Same client/server split as tmux/zellij.

### A.3 The hard part: the daemon models the _screen_, not a byte pipe

A reattaching client needs the **current screen contents** to repaint, so the daemon keeps a
**headless terminal emulator** per session — grid, cursor, scrollback, modes (alt-screen), title,
status. Don't hand-roll a VT parser: use **`@xterm/headless`** (xterm.js's headless build — natural
fit, same VT semantics as our renderer) or a Rust/JS VT crate. Feed PTY output into it _and_ forward
raw bytes to attached clients.

**Attach protocol:** client sends `attach(id, cols, rows)` → daemon sends an initial paint
(snapshot or reconstructing escape sequences) → then streams live bytes → on disconnect the daemon
keeps PTY + model alive.

### A.4 Transport & lifecycle

Unix domain socket (mac/linux) / named pipe (Windows); length-prefixed framed messages
(`attach/write/resize/data/exit`); GUI auto-spawns the daemon and discovers it via pidfile/socket;
daemon refcounts sessions and auto-exits when idle; child-cleanup responsibility moves from the GUI
to the daemon.

### A.5 Remote sessions: wrap the remote's tmux, don't ship a daemon

A "remote session" is a local session whose command is `ssh <host> -t 'tmux new -A -s <name>'` (or
`mosh … tmux …`). Persistence lives in the remote's tmux; our daemon only holds the local ssh process.
No deploying our binary to every host.

### A.6 What to keep cheap now

Keep the renderer talking to a **stable IPC surface** (`ptySpawn/ptyWrite/ptyResize/ptyKill` + a
per-session data stream) via `lib/ipc.ts`. v1 backs it with the in-process `node-pty` map; the daemon
later becomes a second implementation of the same surface. **Don't build the daemon/socket/parser
now — just don't let the renderer assume the PTY is in-process.** The `lib/ipc.ts` seam (§8, §11) is
exactly this insulation.
