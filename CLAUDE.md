# minmux

Cross-platform terminal app (agent-runner focus). Multiple shell sessions in tabs + split panes;
links open the OS browser; native notifications; per-session status. Docs live in `docs/` — see
`docs/ARCHITECTURE.md` (design), `docs/ROADMAP.md` (progress), `docs/TESTING.md` (quality bar);
design docs/RFCs in `docs/design/`.

## Stack

Electron (Chromium, **frameless**) · electron-vite · React + TypeScript · Zustand · xterm.js (WebGL
renderer) · node-pty · react-resizable-panels · Vitest. UI: `@phosphor-icons/react`, bundled **Geist
Mono** (chrome) + FiraCode/JetBrains Mono (terminal). Visual design = `mux` (see
`docs/mux_product_spec.md` + ROADMAP M3.5). (Migrated from Tauri/Rust — see ARCHITECTURE §3.5.)

## Structure

```
electron/                 main process (Node) — see electron/CLAUDE.md
  main.ts                 BrowserWindow + every ipcMain handler + PTY registry + quit guard
  preload.ts              contextBridge → window.minmux (mirrors src/lib/ipc.ts)
  shell-integration.ts    inlined zsh/bash OSC-133/OSC-7 scripts, listShells (WSL), injection
  git.ts · pane-git.ts    changes panel (status/diff) · per-terminal branch + gh PR (sidebar)
  agent-hooks.ts          Claude hook-event file drops → AgentEvents (hook-writer builds them)
  transcript-fold.ts      chunked incremental JSONL reader, shared by:
    transcript-tokens.ts  · token badge      transcript-meta.ts · /color + /rename
  agent-meta.ts           per-pane transcript watch → session colour (agents:meta)
  ssh-config.ts · ssh-service.ts  ~/.ssh/config → host list (watched) · spawn plans (trusted)
  pending-spawns.ts       one spawn per pane while an async (ssh) plan is built
  profile.ts              which profile this process is (dev build = `dev`): names + env scrub
  legacy-migrate.ts       smterm → minmux: copy the old config / user-data dirs on first launch
src/
  app.tsx · store.ts      compose + global effects/pollers · Zustand state + actions
  types.ts                Session, PaneLeaf/PaneNode (pane = surfaces), Tab, DropZone
  terminal/terminal-manager.ts  xterm+PTY OUTSIDE React: attach / park / followSize / WebGL
  lib/                    pure logic, unit-tested — pane-tree (split/surfaces/move), workspace
                          (persist + migrate), session-status, session-color, drop-zone,
                          pane-git, terminal-keys, …; ipc.ts = the only backend seam
  settings/               schema (merge/validate) · themes (families × dark/light) · io
  components/             top-bar, sidebar, terminal-pane (surface tabs, drag & drop),
                          pane-layout, theme-picker, close-pane-dialog, palettes/panels, …
.claude/skills/run-minmux drive the BUILT app with Playwright (real-app verification)
```

## Commands

`make run` (dev) · `make check` (lint+test) · `make test` · `make lint` · `make fmt` ·
`make build` · `make install` (deps + electron-rebuild + hooks). `make help` lists all.

## Conventions

- **Filenames: kebab-case** (`terminal-manager.ts`); component _exports_ stay PascalCase.
- **No semicolons** (Prettier `semi: false`).
- **Docstrings**: one short line on non-obvious functions/types — scannable, not verbose.
- **Commits**: Commitizen / Conventional Commits — `type(scope): subject`, imperative,
  lowercase subject, no trailing period. Types: `feat` `fix` `docs` `refactor` `perf` `test`
  `chore` `style` `ci` `build` `revert` (breaking → `!` or `BREAKING CHANGE:`). **No emoji in
  commit messages.**
- **PR titles**: the **same** Conventional-Commit format **with a leading emoji** (HuggingFace
  style) — `<emoji> type(scope): subject`. Emoji per type: ✨ `feat` · 🩹 `fix` · 📝 `docs` ·
  ♻️ `refactor` · ⚡ `perf` · ✅ `test` · 🔧 `chore` · 🎨 `style` · 👷 `ci` · 📦 `build` ·
  ⏪ `revert` · 🚨 breaking. Example: `✨ feat(diff-panel): syntax-highlight the changed file`.
- **Performance is a first-class design criterion.** Every new feature must stay **off the terminal
  hot path** (PTY → renderer → xterm). New background / IPC / hook / integration work must be async
  and must never block keystrokes, rendering, or (for agent integrations) the agent's own loop; keep
  it on a channel separate from terminal data and throttle it. When in doubt, measure with the
  `MINMUX_PERF=1` harness (`docs/PERF.md`). Weigh this in every design, not as an afterthought.
- **Tests with the feature**: push logic into pure functions (pane-tree, session-status,
  shell-integration parsers) and test those; the risky code earns real tests.
- **Lint is a gate** (pre-commit hook): `tsc` (renderer + electron), eslint, prettier. Run `make fmt` first.
- **Verify in the real app** when a change touches terminals, focus, rendering, or Claude
  integration (Vitest can't load node-pty/WebGL): the `run-minmux` skill. Never run the app
  against the user's real `HOME` — it overwrites their saved layout and hook settings.

## Invariants

Rules the code relies on but can't enforce — most past review findings broke one of these.

- **Once started, a terminal is mounted in its pane or parked — never unopened**, and never
  disposed on unmount (only when its session leaves the store). Starting is lazy per tab:
  after a restore/reload only the active tab's terminals start (incl. its hidden surfaces);
  a background tab starts when first shown. → GOTCHAS #hidden-terminals
- **`Tab.activeSessionId` is the focus.** Focusing a terminal also makes it its pane's visible
  surface (`focusIn`); keyboard focus follows the store, never "whatever just mounted".
- **Store actions return the same reference when nothing changed** — `tabs`/`sessions`
  subscribers trigger WebGL reconcile and a workspace save (`replaceTab`, `markSeen`, …).
- **`useShallow` selectors return primitives** (flatten to `[id, value, …]`); new objects per
  call never compare equal → endless re-renders.
- **Settings change via `store.updateSettings`** (validate + apply + persist); the theme to
  render is `activeTheme(state)` (family × appearance), never `settings.theme` directly.
- **Persisted files stay readable by older builds** (workspace v2 keeps a legacy `sessionId`
  per leaf), and a file written by a **newer** build is never overwritten.
- **Claude hook payloads + transcripts are internal formats** — parse best-effort, never throw,
  read incrementally off the hot path. → GOTCHAS #claude-transcript

## Gotchas

One-line landmine flags; full _why_ + fixes in **`docs/GOTCHAS.md`** (anchors below). Main-process
rules also in `electron/CLAUDE.md` (loaded on demand). Design detail in `docs/ARCHITECTURE.md`.

- **Renderer ↔ main only via `src/lib/ipc.ts`** (preload `window.minmux`); no Electron in React.
  Terminals live in `terminal-manager.ts`, outside React (re-attach, don't respawn). → GOTCHAS #seam
- **Terminal fonts must be bundled `@font-face`**; load explicitly before the WebGL atlas builds.
  Ligatures (WebGL-only) default **off**. → GOTCHAS #fonts
- **WebGL on every visible pane** (`webgl`, default); rebuild the shared atlas after the pane set
  changes or splits garble. `renderer` = `webgl`|`dom` (`lib/renderer-policy.ts`). **Don't animate compositing on a WebGL pane.** → GOTCHAS #renderer
- **cwd is OSC-7-based** (drives diff panel + split/new-tab inheritance); no OSC 7 → `$HOME`. → GOTCHAS #session-survival
- **Layout persisted, processes not across a full quit** (workspace.json restore). **But PTYs
  survive a renderer reload** via attach-or-spawn reattach. Full-quit survival = ROADMAP M5. → GOTCHAS #session-survival
- **Quit is guarded** (`before-quit` confirm dialog when PTYs live). → GOTCHAS #session-survival
- **A crashed TUI's mouse mode self-heals** via the zsh/bash `precmd` reset. → GOTCHAS #mouse-reset
- **zsh/bash history is shared across panes** — integration sets `SHARE_HISTORY`/`histappend`
  (incremental write → also survives close); opt-out via `shareHistory` setting. → GOTCHAS #history
- **A dev build is the `dev` profile**: own user-data dir (the lock), config dir
  (`~/.config/minmux-dev`) and shell-integration dir, so it runs beside the installed app;
  `MINMUX_PROFILE=<name>` picks another (dev builds only; `--profile=<name>` for either).
  Paths come from `configDir()`, never "minmux". → GOTCHAS #profiles
- **`node-pty` is a native module** — `npx electron-rebuild -o node-pty`; not unit-testable in Vitest. → GOTCHAS #node-pty
- **On Windows the app spawns `wsl.exe`** — never runs _inside_ WSL. → GOTCHAS #windows
- **Hidden surfaces (and visited background tabs) are parked** — opened off-screen,
  render-paused — not `visibility:hidden`. Unvisited background tabs aren't started at all. → GOTCHAS #hidden-terminals
- **No dark flash on launch** needs the `index.html` pre-paint script + `settingsLoaded` gate +
  saved window bg. → GOTCHAS #first-paint-theme
- **`/color` + `/rename` live only in Claude's transcript**; slash commands fire no hook. → GOTCHAS #claude-transcript
- **Relaunch resumes Claude sessions** from a hook-fed ledger: any SessionEnd while running
  clears an entry; a quit freezes it first; one shot per session. → GOTCHAS #resume
- **SSH panes have no local cwd; main rebuilds their ssh command** from its own host list;
  reconnect reuses the session id (xterm listeners wired once). → GOTCHAS #ssh
- **Agent-status reducer has a known flaw** — don't quick-patch (needs a test matrix). → GOTCHAS #agent-status, ARCHITECTURE §9a
