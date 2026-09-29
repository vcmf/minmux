# Gotchas — minmux

The non-obvious traps, with the _why_. CLAUDE.md carries a one-line flag for each of
these; this file is the detail you read when one bites. See also `ARCHITECTURE.md`
(design) and `TESTING.md` (quality bar).

## Renderer ↔ main seam {#seam}

Renderer talks to main **only via `src/lib/ipc.ts`** (preload exposes it as
`window.minmux`). Don't import Electron in React. This one seam is also the insulation
point for the out-of-process session daemon (ARCHITECTURE Appendix A).

Terminals live in **`terminal/terminal-manager.ts`, OUTSIDE the React tree**, keyed by
session id — so splitting a pane or switching tabs **re-attaches** instead of respawning
the shell. Dispose a terminal only when its session leaves the store.

## Fonts & ligatures {#fonts}

Terminal fonts must be **bundled `@font-face`** (`public/fonts/`): the WebGL renderer
needs the primary font to carry Nerd/Powerline icons (no per-glyph fallback). The WebGL
atlas rasterizes glyphs via canvas, which only uses an `@font-face` **after it's
explicitly loaded** — `document.fonts.ready` is not enough (see `ensureFontLoaded`).

Ligatures need `allowProposedApi` + the character joiner (works on WebGL, not the DOM
renderer). Default is **off** (`font.ligatures: false`) — WebGL + the ligature joiner
can leave paint remnants (xterm.js #3303), worse with multiple panes.

## Renderer policy: WebGL only for on-screen panes {#renderer}

Many simultaneous WebGL contexts **corrupt the glyph atlas** (garbled text — xterm.js
#4379/#3303, still unsolved upstream; browsers also cap live contexts and evict the oldest).
Creating a context disturbs the siblings that share xterm's atlas — that's the garble that hit
the untouched panes when you split a tab full of agent TUIs. **The cure is an atlas rebuild after
the pane set changes:** when `reconcileRenderers` creates a context **and** >1 will coexist, it
schedules `repairRenderers(true)` on the next frame (`clearTextureAtlas()` + repaint on **all**
live WebGL panes), so any glyphs the new context disturbed re-rasterize cleanly. With that in
place, every visible pane can run WebGL crisply — the same shared-atlas approach VS Code uses.
`acquireWebgl` returns whether it created a context so the reconcile knows when to rebuild.

The `renderer` setting (`lib/renderer-policy.ts` `webglPanes`, pure + tested):

- **`webgl`** (default) — WebGL on every visible pane.
- **`dom`** — no GPU anywhere; always correct, a bit slower. The fallback for GPUs/drivers that
  can't hold multiple contexts cleanly (VS Code keeps `gpuAcceleration: off` for the same reason;
  it still ships occasional multi-terminal glitches — vscode#237688).

`reconcileRenderers` runs on tab-switch / split / close (app.tsx) + attach + settings change.

**Keep `customGlyphs` on (the default).** It makes the WebGL renderer draw box-drawing/Powerline
glyphs with its own crisp, grid-aligned geometry rather than from the font. Turning it off makes
those glyphs look plainer (that's all the DOM renderer can ever do — it has no custom-glyph path,
which is why `dom` mode looks less sharp).

**Compositing changes on the `.terminal-pane` container can garble the child WebGL canvas**
(`box-shadow`/`transform`/opacity, animated _or_ just toggled). The focus/attention rail
toggles `box-shadow` on `.terminal-pane` (`App.css` `.focused`/`.waiting`) — including on
split and on every agent status flip — so we **isolate the canvas into its own layer** via
`contain: paint; isolation: isolate;` on `.terminal-mount`, which stops the parent recomposite
from touching it. If you add new per-pane cues, still prefer a non-compositing indicator over
new effects on `.terminal-pane`. Renderer stays WebGL (VS Code's choice; xterm's canvas addon
is deprecated).

**Reparenting the canvas needs a repaint.** Splitting a pane remounts its `TerminalPane`, so
`attach()` moves the live WebGL host into the new container — which shows stale pixels until the
next draw. `attach()` ends with `requestAnimationFrame(() => repairRenderers())` to repaint the
moved canvas.

**The atlas/framebuffer can also go stale on its own** — after the app is backgrounded,
a display-scale/monitor (DPR) change, or a resize — showing garble until a scroll forces a
repaint. `terminal-manager.repairRenderers(rebuildAtlas?)` automates that scroll: `app.tsx`
calls it on window focus and `visibilitychange` (cheap repaint), and on a DPR change or a
debounced resize (`rebuildAtlas=true` → `clearTextureAtlas()`, since glyph metrics moved).
True _context loss_ is separate (see `acquireWebgl`): it disposes and stays on the DOM.

## Self-heal a crashed TUI's mouse mode {#mouse-reset}

A full-screen TUI killed abnormally (classic case: an agent dying on lid-close/sleep)
never restores the mouse-tracking modes it enabled, so afterwards every mouse move
floods the prompt with raw SGR reports (`35;70;25M…`). Our zsh/bash `precmd`
(`electron/shell-integration.ts`) emits the mouse-mode disables (`\e[?1000/1002/1003/
1006 l`) every prompt, so the terminal self-heals the instant control returns to the
shell — safe there since no full-screen program is running. Only heals in shells with
our integration (zsh/bash); plain PowerShell/cmd/fish won't self-heal.

## Sessions, cwd & PTY lifetime {#session-survival}

**cwd tracking is OSC-7-based.** `session.cwd` is set only when the shell emits OSC 7
(our zsh/bash integration does, from `precmd`). It drives the **git diff panel** and
**cwd inheritance** (splits + new tabs open in the focused terminal's dir). Shells that
don't emit OSC 7 (plain PowerShell/cmd, or before the first prompt) have no cwd → the
diff panel is empty and new panes fall back to `$HOME`. Not a bug — graceful degradation.

**Layout is persisted, processes are not — across a full quit.** The tab/pane tree +
each pane's `{command,args,cwd}` are saved (debounced) to `~/.config/minmux/
workspace.json` and restored on launch (VS Code-style: fresh shells respawn in the saved
cwds; scrollback/running programs are gone).

**But PTYs survive a renderer reload (sleep/dev-HMR/GPU-crash).** PTYs live in the main
process, which outlives a renderer reload. `pty:spawn` is **attach-or-spawn**: a spawn
for an already-live session id **reattaches** — main rebinds output to the new renderer,
resizes, and replays recent history from a bounded per-session `OutputBuffer` — instead
of respawning and orphaning the live shell. Diagnosed via `electron/diagnostics.ts`
(a lid-close showed suspend→resume with no app reboot, only a renderer reload). Explicit
`pty:kill` (pane/tab close) still truly terminates + frees the buffer.

**True reattach across a full app quit** (live processes surviving a quit, via a detached
daemon) is still **ROADMAP M5** — a full quit kills PTYs (they're children of main +
`killAllPtys()`). See ARCHITECTURE Appendix A.

**Quit is guarded.** `before-quit` shows a native confirm dialog when PTYs are live
(unless `settings.confirmQuit` is false); the frameless close button routes through
`app.quit()` too. The dialog's "don't warn again" writes `confirmQuit:false` to
settings.json.

## zsh/bash history is shared across panes (cmux-like) {#history}

**Fixed 2026-07-10.** Symptom was: unlike cmux, minmux panes didn't share command history
live (type in pane A, reuse in pane B) and history often didn't survive closing the app —
even with the user's `HISTFILE`/`HISTSIZE`/`SAVEHIST` set (so `.zshrc` **was** loading;
never an rc-loading problem). Root cause: our injected integration didn't enable shared
history, while cmux does (confirmed — `setopt | grep -i sharehistory` returns `sharehistory`
in a cmux pane with the user's `.zshrc` having it off, so cmux enables it itself).

**Fix (in `electron/shell-integration.ts`):**

- **zsh:** after sourcing the user's `.zshrc` (so it wins), `setopt SHARE_HISTORY` + sane
  `HISTFILE`/`SAVEHIST`/`HISTSIZE` fallbacks **only when unset**.
- **bash:** `shopt -s histappend` + `history -a; history -n` in `__minmux_precmd` (after
  `local ret=$?` so it can't clobber the reported exit code).
- **Why it also fixes persistence:** `SHARE_HISTORY`/`histappend` write each command to
  `HISTFILE` **immediately**, so history survives even the hard `proc.kill()` on close — we
  did **not** need to touch the PTY kill/reattach lifecycle (which session-survival depends
  on). Graceful shutdown would be a nice-to-have but is unnecessary for history.
- **Opt-out:** it's an opinionated semantics change (cross-pane chronological interleave vs
  per-session order), so it's gated on `MINMUX_SHARE_HISTORY` (default on). The
  `shareHistory` setting (schema, default `true`) → `main.ts` sets `MINMUX_SHARE_HISTORY=0`
  in the spawn env when off; `wslInjection` lists the var in `$WSLENV` so the opt-out
  crosses into WSL.
- **Invariant:** all panes must keep the **same `HISTFILE`** — the injection must never set
  a per-pane histfile, or sharing breaks.
- **ZDOTDIR poisons `HISTFILE` (fixed 2026-07-15).** We inject `ZDOTDIR=<temp>` to load our
  rc, but a **system zshrc runs before our rc** and (macOS `/etc/zshrc`, some Linux) does
  `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history` — pointing `HISTFILE` into our **temp** dir.
  Result: minmux panes shared history **with each other** (same temp file) but were **siloed
  from every other terminal** (vscode/cmux/Terminal, which use `$HOME/.zsh_history`). Fix: our
  rc repoints `HISTFILE` whenever it landed **inside** our injected dir (`"$HISTFILE" ==
"$MINMUX_ZDOTDIR"/*`, guarded by `-n "$MINMUX_ZDOTDIR"`), keeping the basename →
  `${MINMUX_USER_ZDOTDIR:-$HOME}/${HISTFILE:t}` (so it matches whatever file other terminals
  use; never a `HISTFILE` the user set elsewhere on purpose). Runs even when shared-history is
  opted out — a file-location correctness fix, not a sharing opt-in. **Cross-platform:** local
  zsh (macOS/Linux) sets `MINMUX_ZDOTDIR` via `buildInjection`; **WSL** sets it in
  `wslInjection` and forwards it over `$WSLENV`, so the repoint fires there too. bash is
  unaffected (no ZDOTDIR).

## Profiles: a dev build is its own app {#profiles}

An unpackaged build (`make run`) runs as the **`dev` profile**; the installed app keeps the
plain `minmux` names. A profile owns every piece of per-instance state:

- **Electron user-data dir** (`~/Library/Application Support/minmux-dev`, `%APPDATA%\minmux-dev`,
  `~/.config/minmux-dev` on Linux): the **single-instance lock** and localStorage.
- **Config dir** (`~/.config/minmux-dev`, `%APPDATA%\minmux-dev`): settings, workspace,
  Claude hook files and ledger, diagnostics.
- **Shell-integration dir** (`$TMPDIR/minmux-dev/shell-integration`): rewritten on every
  spawn, so a shared one would feed an installed app's new shells another branch's scripts
  (or a half-written `.zshrc`).

Without this, `make run` found the installed app's lock, focused that window and quit — and
had it started, it would have overwritten the installed app's workspace and
`claude-hooks.json` (the ECONNREFUSED hook spam the lock exists to prevent).

- `--profile=<name>` (lowercase, digits, `-`; the `=` is required — Chromium's switch syntax)
  picks a profile for either build. **`MINMUX_PROFILE` works for a dev build only**: an
  installed app ignores ambient env, so an export meant for dev runs can never move it.
  `default` / `prod` is the installed app's. An **invalid** name stops main synchronously
  (stderr + an error box on macOS/Windows; Linux has no dialog before ready) before any name,
  path or lock is set, so it never falls back to some profile's real data. Resolved once, first thing in
  `main.ts` (`electron/profile.ts`), before any path is read.
- **A parent minmux's per-pane env is scrubbed at startup** (`MINMUX_CLAUDE_SETTINGS`,
  `MINMUX_PANE_ID`, `MINMUX_PROFILE`, …): a dev build launched from an installed pane must
  not report Claude events into the installed app's hook dir, and nothing we spawn (shells,
  editors, git) inherits our profile.
- **The app was called smterm** (renamed after v0.1.41). A profile's first minmux launch copies
  its old `smterm[-<profile>]` config and user-data dirs to the new names
  (`electron/legacy-migrate.ts`, before the single-instance lock creates them), skipping
  Chromium caches, the lock and per-launch hook state; the old dirs stay for an older build.
  `index.html`'s pre-paint script carries `smterm*` localStorage keys over once, and the env
  scrub also drops the old `SMTERM_*` per-pane vars.
- The Windows AppUserModelId stays `com.minmux.app` for every profile: toasts only show for
  an id a Start Menu shortcut registers.
- An explicit `--user-data-dir` (the `run-minmux` driver) still wins; the driver sets
  `MINMUX_PROFILE=default` (its HOME is throwaway) unless given `profile`, **and a scratch
  `TMPDIR`**: the shell-integration dir lives there, and the real one is the installed app's.
- The login-shell env import (packaged builds) re-adds any var we lack, so the scrub runs
  again after it. `ELECTRON_RENDERER_URL` is read once (honoured only unpackaged) and
  deleted from `process.env`, so no child — shell, editor, git — inherits it.
- On macOS Electron's `appData` is the real `~/Library/Application Support` even under a
  fake `$HOME`: a test that fakes HOME must still pass `--user-data-dir`.

## node-pty is a native module {#node-pty}

After install / Electron upgrades run `npx electron-rebuild -o node-pty` (in
`make install`). Vitest can't load it (Electron ABI), so PTY spawning isn't unit-tested
there — push logic into pure modules (`output-buffer`, `coalescer`, shell-integration
parsers) and test those; verify the PTY path manually / via the diagnostics log.

**Quit must wait for every PTY's exit.** node-pty reports a child's exit from a background
thread back into JS; if that lands while Electron is tearing Node down, node-pty throws a C++
exception nobody catches → `abort()` (a SIGABRT crash report on ⌘Q). `before-quit` holds the
quit and drains `livePtys` — every node-pty not yet exited, closed panes still winding down
included (`pty-drain.ts`: SIGHUP, SIGKILL after 1.5 s; Windows: no signals + a 300 ms settle;
always resolves), refusing new spawns meanwhile. The decision is the pure, tested
`quit-plan.ts`. Two exceptions: an OS logout/restart (powerMonitor `shutdown`) is **not** held
— macOS would report "minmux cancelled restart" — so it kills without waiting; and the shutdown
event itself never drains (it can be cancelled; the app must stay usable). Known gap: a
Windows logoff that skips `before-quit`.

## GUI launch has a bare PATH — import the login-shell env {#shell-env}

A macOS/Linux app launched from Finder/Dock inherits a minimal `launchd` PATH
(`/usr/bin:/bin:/usr/sbin:/sbin`), **not** the user's shell PATH — so Homebrew/cargo
tools (`starship`, etc.) are missing and `.zshrc` lines like `starship init` fail with
"command not found". Only bites the **packaged** app; `npm run dev` is launched from a
terminal that already has the full env. Fix (`electron/shell-env.ts`, VS Code's approach):
on startup, when `app.isPackaged` and not Windows, run the login+interactive shell once,
capture its env, and import PATH (+ missing vars) into `process.env` before any PTY
spawns. Parser is pure + tested; the shell probe is best-effort (returns `{}` on failure).

## Windows {#windows}

The app spawns `wsl.exe` as a shell — it never runs _inside_ WSL.

**Git for a WSL session runs _inside_ the distro, not on the host.** A WSL pane's cwd
(from OSC 7) is a Linux path (`/home/you/repo`) the Windows host can't see, so host `git`
reports "not a git repo" and the diff panel is empty. Fix: the renderer passes the session's
WSL context (`lib/wsl.ts` `wslContext` → `{ distro }`, parsed from the `wsl.exe -d <distro>`
command) with `git:status`/`git:diff`; `electron/git.ts` then runs `wsl.exe [-d <distro>]
--cd <cwd> -- git …` (see `wslGitArgs`). The untracked-file line-count fallback (`countLines`,
host fs) and the diff null-device (`NUL` vs `/dev/null`) are also WSL-aware.

## Clickable file links {#file-links}

Path-like tokens in output are made clickable (click → open in editor / reveal). A **plain click**
opens in normal output, but while a full-screen TUI holds **mouse tracking** (Claude's live UI, vim
— `term.modes.mouseTrackingMode`) a bare click belongs to the app, so there it needs **Cmd/Ctrl-click**
(same as VS Code) — otherwise clicks inside the agent's UI would get hijacked into opening files.
Detection is a **permissive regex on purpose** (`lib/file-links.ts`, pure + tested) — the real false-positive
filter is **existence validation** (`fs:path-exists`, `main`) against the session cwd, so a version
string like `1.2.3` or a domain that doesn't resolve to a file never underlines. Validation is
cached in `terminal-manager` (the link provider fires on hover, not per render). Clicking runs the
`openPath` template (default `code -g {file}:{line}:{col}`, found via the login-shell PATH from
`shell-env` so a packaged app can locate `code`); it falls back to the OS default (`shell.openPath`)
when the template is empty or the editor binary isn't found. **Known limits (follow-ups):** single
row only (a path wrapped across rows isn't matched); forward-slash paths (no Windows-native
backslash); extensionless files (`Makefile`) unless they contain a slash; **WSL** panes don't open
links yet (needs the WSL cwd context — see `#windows` / the WSL git PR).

## Hidden terminals are parked, not hidden {#hidden-terminals}

A pane holds several terminals (surfaces) but mounts only the visible one. Every other
**started** terminal — a hidden surface, a background tab you've visited — is **parked**: its
xterm is opened inside an off-screen, `inert` element in the document (`parkingLot()` in
`terminal-manager.ts`). `detach()` parks; `attach()` moves the host back; `ensureRunning()`
starts a pane's hidden surfaces straight into the lot. The invariant: **once started, a
terminal is mounted or parked — never unopened**, and never disposed on unmount (only when its
session leaves the store).

Starting is **lazy per tab**: only the active tab's `PaneLayout` renders, so after a restore or
a renderer reload a background tab's terminals have no xterm entry (and, after a full quit, no
PTY) until the tab is first shown — no status, notifications or cwd from them before that.
Code must tolerate a missing entry (e.g. `dispose()` still kills the PTY by id).

Why not the obvious alternatives:

- **Unopened until shown** (the first design): an unopened xterm has no theme service, so it
  never answers OSC 10/11 colour queries (agents pick the wrong light/dark), and
  `registerCharacterJoiner` throws "Terminal must be opened first" — with ligatures on, any
  settings change crashed the app.
- **`visibility:hidden` inside the pane:** xterm pauses rendering via an IntersectionObserver,
  which ignores `visibility`, so every hidden terminal would keep painting its output — a
  hot-path cost per surface. Off-viewport parking gets the pause for free.

Parked terminals can't measure themselves: they take their pane's grid via `followSize`
(`syncHiddenSizes` on pane resize / font change), resizing the PTY only when the grid really
changes. WebGL is never acquired while parked (`acquireWebgl` checks the host's parent) — a live
canvas that gets reparented can lose its context. Keyboard focus follows the store's focus:
`attach()` only focuses the tab's focused session, never whatever just mounted.

## Theme on first paint {#first-paint-theme}

`settings.json` loads asynchronously, but a light theme must not flash the dark CSS defaults.
Three pieces, all needed:

1. **`index.html` inline script** applies the last theme's CSS vars (localStorage
   `minmux:theme-vars`, written by `applyThemeVars`) before first paint. Doing it in
   `main.tsx` is too late — module scripts are deferred.
2. **The theme effect waits for `settingsLoaded`** — running once with defaults would
   overwrite the cache with dark. Settings also load _before_ the workspace restore, so
   restored panes spawn with the right `COLORFGBG`.
3. **The native window background** (`window:set-background`) follows the theme and is saved to
   `window-bg` in the config dir, so the next launch's `BrowserWindow` opens light.

A running shell's env can't change, so `COLORFGBG` is stale for panes opened before a
light/dark switch (incl. `appearance: "system"` following the OS); native shells get the live
answer via xterm's OSC 11 reply.

## Claude Code integration reads internal formats {#claude-transcript}

Hook payloads and the session transcript JSONL are **undocumented Claude internals** — parse
best-effort and ignore what you don't recognize; never throw (`transcript-fold.ts` and friends).

- `/color` and `/rename` are recorded **only** in the transcript
  (`{"type":"agent-color","agentColor":"orange"}`, `{"type":"custom-title","customTitle":"…"}`,
  latest wins, `default` = reset). Claude sends no terminal escape for either, and **slash
  commands fire no hook** — `agent-meta.ts` finds the transcript via the pane's hook events,
  then `fs.watch`es that one file. `/rename` never sets a colour in Claude itself; the
  name-derived colour is minmux's (cmux does the same).
- The transcript is read incrementally in bounded chunks (`TranscriptFold`) — a resumed session
  can be 90 MB+, and a synchronous parse would stall PTY forwarding.
- Hook-event drops are ingested **unordered**: a late `SessionEnd` of the previous session in a
  pane must not stop tracking the new one (compare the transcript path).

## Resuming Claude sessions on relaunch {#resume}

`electron/agent-sessions.ts` keeps a ledger (`agent-sessions.json`) of which Claude session
each terminal is inside, from the `SessionStart` / `SessionEnd` hooks. On relaunch the
renderer asks for a plan **before** restoring the workspace (so the shell spawns in the
session's own cwd — `claude --resume <id>` only finds transcripts of the current project dir),
and `terminal-manager` types `claude --resume <id> [--permission-mode m]` at the first prompt.

- **Any `SessionEnd` while minmux runs clears the entry** — double Ctrl-C can report reason
  `other`, so reasons can't tell "user quit Claude" from anything else. Only a quit (the ledger
  is **frozen and flushed before** `killAllPtys`, whose kills would fire SessionEnds) or a
  crash (no SessionEnd at all; the ledger is write-through) leaves entries to resume.
- **Live PTYs are skipped** — after a renderer reload Claude is still running.
- **One shot:** the entry is consumed on **failure or dismiss** — not when typed (a quit or
  crash during the confirmation window must still resume next time); a failure shows the
  banner, never a retry loop. Main only consumes the exact carried-over entry, so a late
  success that re-recorded it this run is kept. Failure = a `D` that follows our command's own `C` (it exited — the code is in the
  `D` payload; a `D` without a `C` is just the shell's first prompt arriving late) before
  Claude's `SessionStart`, or 25 s passing. A later success still wins.
- The command is typed from **validated** parts only (UUID id, one-word mode):
  bypassPermissions is dropped unless `resumeBypassPermissions` is on.
- Background tabs start lazily, so their entries wait (across quits) until first shown.
- Only shells that take POSIX quoting get the typed `cd -- '…' &&` (zsh/bash/sh/dash/ksh, WSL);
  fish, pwsh, cmd and others spawn in the session's dir instead. Typing waits for a real
  prompt on shells main reports as integrated (never guessed from the name).
- Known limit: Ctrl-Z a Claude, then start a second one in the same pane — the second is
  treated as nested (not recorded), so a relaunch offers the first. When the second exits, the
  returning prompt also drops the suspended one from the agents board + Claude icon (a prompt
  can't tell which Claude ended); its next hook event brings it back.
- A shell **without** integration (e.g. a cold WSL VM whose injection timed out) can't confirm
  a resume — no hooks, no OSC 133 — so after typing the banner only says it was **sent**; it
  never reports failure or offers buttons that would type into a possibly-running Claude.
- **The resume folder must be where Claude filed the session.** Claude files a session under
  `~/.claude/projects/<cwd with every non-alphanumeric → "-">/`, and `claude --resume` only finds
  it from that folder. A `SessionStart` whose folder doesn't encode to its transcript's project
  dir falls back to the pane's last verified folder that fits (a stray event from an agent's
  scratchpad; `/clear` while Claude sits in a subfolder); with none, the session is still
  recorded as the pane's lead but never resumed — logged as
  `hook-cwd-fallback` / `hook-cwd-rejected`. A later event whose folder does match is followed
  (a session re-filed under a worktree); `plan()` skips a mismatching entry instead of
  `cd`-ing into it (`src/lib/claude-project.ts`).
- **Background agents inherit the pane.** Claude's named agents run as separate `claude`
  processes with our `MINMUX_PANE_ID` + hooks. **One classifier decides the pane's lead: the
  ledger** — while a live lead exists, any other session's `SessionStart` (startup, compact,
  resume) is nested, and stays nested until it ends (an agent outlives its lead); a real switch
  ends the old session first, and `/clear` / `fork` count as one regardless. Main rewrites a
  replaced/rejected folder and tags every root event `nested` before forwarding, so the
  renderer's graph (`in`, status bar, panels) and the pane accent follow only the lead — no
  second classifier. Known limits: a lead killed with no `SessionEnd` in a shell without our
  integration (no prompt mark to notice it) keeps leading until the pane closes; and after the
  lead exits, a surviving agent that runs `claude -p` itself looks exactly like the user starting
  a new `claude` there, so it can lead.
  Session lifecycle hooks are traced as `hook …` lines in `diagnostics.log`.
- Known limit: vi-mode users in **normal** mode — ^U doesn't clear the line there, so a banner
  button's keystrokes are read as vi commands. Stay in insert mode (the default) to use them.
- **rc-time commands are fine** (`conda activate`, nvm, direnv in `.zshrc`): the first `D` only
  comes after the whole rc ran, so the resume runs inside that environment. Two known limits:
  an rc that hands the terminal over (`exec tmux`, `exec fish`, auto-ssh) never shows our
  prompt, so after 20 s the banner only offers Resume (it won't type into tmux); and only the
  session's **folder** is restored, not its **environment** — a hand-run `conda activate ml` /
  venv comes back as whatever the rc activates (could record `CONDA_DEFAULT_ENV` /
  `VIRTUAL_ENV` from the hook process's env, if it ever matters).
- **Delivery by typing is deliberate — revisit only if a shell becomes a pain point.**
  Alternatives weighed (2026-09): (a) the integration runs `MINMUX_RESUME_ID` at the first
  prompt — nothing typed, but native only on zsh; (b) spawn the pane as
  `$SHELL -ic 'claude --resume X; exec $SHELL -i'` — no typing, fixes fish/pwsh quoting, but
  the rc runs twice, no history entry, weaker job control, and no prompt marks to detect a
  failed resume; (c) `claude --continue` — picks the wrong session when two panes share a
  repo. None handles an rc that execs tmux. If fish/pwsh users hit problems, (b) per shell
  is the candidate.

## SSH panes {#ssh}

- **A remote session never has a local cwd.** Its OSC 7 path is on the host, so the store
  ignores it and `useActiveWorkCwd` returns nothing for it; the Changes/Files panels show a
  notice instead of reading a local folder with the same name. Don't "fix" an SSH pane's
  missing cwd — that would point git or readdir at the wrong machine.
- **Main rebuilds the command.** Never trust `remote.target` from the renderer (or
  workspace.json); `trustedRemote` looks the host id up in main's list. A saved host this
  build can't read restores as "unavailable" and is written back unchanged.
- **The WSL path skips our shell integration** (`wsl.exe … -e ssh`, no `--rcfile`).
- **One spawn per pane; typed-ahead keys are dropped** while the plan is built, and while a
  pane is waiting/closed/failed only a bare Enter does anything (it reconnects).
- **`remoteCwd` is display only, and per connection.** It comes from what the host prints
  (OSC 7, else the Ubuntu-style title) and is never `cwd`, so no local panel reads a remote
  path; a new connection clears it. **Nothing derived from it is ever sent to the host**: an
  automatic `cd` on reconnect was built and removed, because anything printed in a pane can
  fake an OSC 7 or a title (reviews found injections under fish and cmd.exe, and a trust issue
  with `.envrc`-style hooks). Reopening a folder waits for a trustworthy source (phase 3 shell
  integration) or tmux (phase 2).
- **An integrated ssh pane trusts only nonce-tagged reports** (`OSC 6973;<nonce>;…`, parsed by
  `lib/remote-reports.ts`; the folder is hex of `$PWD`, never a URL). Main pushes the nonce
  (`pty:nonce:<id>`) only after the host's `ok`, and before a reattach's replay. Once a tagged
  report has come, untagged OSC 7 / 133 and titles are ignored at our shell's prompt, and shown
  but never verified while a command it started runs (`exec zsh`, `sudo -i`: see `untrusted()`
  in terminal-manager). `remoteCwdVerified` marks a folder from a tagged report: the only kind
  that may ever be reopened.
- **Only a verified folder is ever reopened, and never through the command line.** A pane's
  `reopenCwd` (a split's source's verified folder, a relaunch's saved one; `lib/remote-reports`
  `reopenFor`) goes to main in `pty:spawn`, is validated again there, and travels hex-encoded
  in the handshake answer (`minmux:<nonce>:<host label>:<hex>`). The host's `sh` decodes it
  with arithmetic, drops it on another machine (`uname -n`), and the user's shell `builtin cd`s
  after its own startup files. A plain host never gets it: the "nothing derived from a
  display-only folder is sent" rule above still holds for everything unverified.
- **Reconnect reuses the session id.** terminal-manager wires xterm listeners once per
  entry and only re-requests the PTY; a second `term.onData` would send every key twice.
- **`attachOnly`** exists for `restore: "on-focus"`: reattach a live PTY after a reload, but
  start nothing. Without it a reload would either dial every host again or strand a live one.
  Under `auto` a restored pane always spawns, so a renderer reload also redials a pane that
  was sitting at a closed/failed prompt (main has no PTY for it to reattach) — by design.
- **The sidebar's connected dot means `remotePhase === "live"`**: a pane still dialing, at a
  Connect prompt, or in a background tab that hasn't started doesn't light it.
- **A dropped connection resets xterm's modes** (alt screen, mouse, focus, bracketed paste,
  cursor keys) before the banner: the remote `precmd` mouse reset never runs locally.

## Agent-status reducer has a known flaw {#agent-status}

`lib/session-status.ts`: `running` = OSC-133 C..D (process alive) ≠ actively working, so
interactive agents read "running" while waiting, and revisiting a pane can re-notify.
Don't quick-patch it — the planned activity-based + latched rewrite needs a real test
matrix. See ARCHITECTURE §9a + ROADMAP M3.6 Track C.
