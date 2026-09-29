# electron/ — main process

Node/Electron main process: frameless `BrowserWindow`, all `ipcMain` handlers, PTY
ownership, native modules. No DOM, no React here. (Renderer rules: root `CLAUDE.md`.)

## Files

- `main.ts` — window + every `ipcMain` handler (pty/settings/shells/notify/links/window-
  controls/platform/git/workspace/metrics), the `PtySession` registry, quit guard, power/
  lifecycle diagnostics.
- `preload.ts` — the **only** contextBridge; mirrors the `Ipc` shape in `src/lib/ipc.ts`.
- `shell-integration.ts` — inlined zsh/bash scripts (OSC 133 + OSC 7 cwd + mouse-reset),
  `buildInjection`, WSL `listShells`. Scripts are line-arrays, not template literals.
- `git.ts` — pure git parsers + `gitStatus`/`gitDiff` for the changes panel.
- `coalescer.ts` / `output-buffer.ts` — PTY output batching (IPC) + replay buffer (reattach).
- `diagnostics.ts` — temporary always-on event log (`diagnostics.log` in the config dir:
  `~/.config/minmux/`, or `minmux-<profile>/` for a dev build).
- `profile.ts` — which profile this process is (a dev build is `dev`); resolved first thing in
  main. Every per-instance path uses `configDir()` / the profile name, never a literal "minmux".
- `legacy-migrate.ts` — first launch after the smterm → minmux rename copies the old config /
  user-data dirs over (runs before the single-instance lock). → `../docs/GOTCHAS.md#profiles`
- `shell-env.ts` — import the login-shell PATH/env at startup (packaged GUI launches get
  a bare launchd PATH). → `../docs/GOTCHAS.md#shell-env`

## Rules

- **PTYs are owned here, keyed by session id** (`sessions: Map<id, PtySession>`). A record
  holds `{ proc, buffer, coalescer?, sender, shell }`; `sender` is the **current** renderer,
  rebound on reattach. Output flows `proc.onData → buffer.push + coalescer.push → emit(rec)`.
- **`pty:spawn` is attach-or-spawn**: an id that's already live **reattaches** (rebind sender,
  `coalescer.reset()`, resize, replay `buffer.dump()`) — it does **not** spawn a second shell.
  Only `pty:kill` (pane/tab close) truly terminates + frees the buffer. → `../docs/GOTCHAS.md#session-survival`
- **Keep logic in pure, testable modules** (`coalescer`, `output-buffer`, shell-integration &
  git parsers). Vitest **cannot load node-pty** (Electron ABI) — never write a test that spawns
  a PTY; verify the PTY path manually / via the diagnostics log.
- **`preload.ts` and `src/lib/ipc.ts` must stay in sync** — the preload is the runtime, `ipc.ts`
  the types. Change both when you add/adjust a channel.
- **`node-pty` native module**: after install / Electron upgrade, `npx electron-rebuild -o node-pty`.
- Handlers are best-effort and must never throw into Electron: wrap fs / native calls.
- Diagnostics logging is **temporary** (session-survival investigation) — gate or remove once
  the reattach fix is confirmed on-device.
