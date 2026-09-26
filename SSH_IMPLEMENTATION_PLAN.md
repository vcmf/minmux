# SSH remotes: implementation plan (phase 1)

Step-by-step build plan for phase 1 of [`SSH_REMOTES.md`](./SSH_REMOTES.md): saved hosts,
one-click connect, same-host splits, connection reuse, WSL hosts. The design and the _why_
live in that doc; this one is the _how_, as a sequence of steps grouped into four PRs. Phases 2 (tmux) and 3
(remote shell integration) get their own plan once phase 1 ships.

Status: **READY** (2026-09-26). Tick steps as they merge.

---

## 0. Ground rules

- Four PRs, in order (table below). Each passes `make check` and ships its tests.
- Per PR: plan → implement → `/code-review high`; repeat review rounds while it still finds
  severe issues, then open the PR.
- PR titles use the repo format with emoji, e.g. `✨ feat(ssh): parse ssh config into a host list`.
- Pure logic goes in pure modules with Vitest tests; main-process glue stays thin.
- `electron/preload.ts` and `src/lib/ipc.ts` change together whenever a channel is added.
- Nothing touches the PTY → renderer → xterm hot path. Host parsing and file watching run in
  main, cached.

---

## 1. Key implementation choices

These refine the design doc after reading the code.

**1a. Main builds the ssh argv at spawn time, not the renderer.**
The session stores _which host_ (`remote.hostId`, `target`, `env`), not a frozen argv.
`pty:spawn` receives `remote` in `SpawnOpts` and main builds the final command with a pure
builder. Reasons:

- A restored layout picks up current flags and config (a changed ControlPath, a new setting).
- WSL argv and the ControlPath dir are platform details main already owns.
- Phase 2 swaps in the tmux wrapper in one place, keyed by the session id main already has.

`Session.command` / `args` are still set (`"ssh"`, `[target]`) for labels and older builds,
but main ignores them when `remote` is present.

**1b. A host is a `ShellOption` with a `remote` field.**
`ShellOption.remote?: RemoteRef`, and `makeSession` copies it onto the session. Splits and new
surfaces already go through `inheritShell(state.shells, src)` (`src/lib/shells.ts`), so
teaching `inheritShell` to carry `src.remote` makes every split, surface and "open folder in
split" stay on the host with no other store changes.

**1c. Remote sessions never set a local cwd.**
Some distros' default bashrc emits OSC 7 (e.g. Fedora's `vte.sh`). If `setSessionCwd` accepted
it, the Changes / Files panels would read that path **on the local disk**. Phase 1 ignores OSC 7
for remote sessions. Phase 3 adds a separate, host-qualified `remoteCwd`.

**1d. File links are off for remote sessions.**
`validatePath` checks candidate paths against the local fs, so `/etc/hosts` in remote output
would become a link to the _local_ file. Disable the link provider when `session.remote` is set.

**1e. `wslContext` must not see remote sessions.**
`wslContext(command, args)` keys on `wsl.exe`. Because remote sessions carry `command: "ssh"`
(1a), a WSL-hosted SSH pane is never misread as a WSL shell by `getActiveWsl`, the git panel or
the file preview. Covered by a test.

**1f. ControlPath: `~/.config/smterm/cm/%C`.**
Kept short because ssh appends a ~17-char temp suffix while
creating the master socket, and macOS caps socket paths at 104 bytes. The builder computes the
worst-case length; if the home path is too long it falls back to `/tmp/smterm-<uid>/%C`.
(`SSH_REMOTES.md` §4b already uses this path.)

**1g. Exit events.**
The renderer never hears that a PTY exited today (no `pty:exit` channel). Phase 1 adds
`pty:exit:<id>` so a remote pane can offer Reconnect.

---

## 2. Types (shared vocabulary)

```ts
// src/types.ts
/** Which SSH host a session runs on; main builds the argv from this at spawn. */
export interface RemoteRef {
  hostId: string // "native:<alias>" | "wsl:<distro>:<alias>" | "settings:<name>"
  label: string // display name
  target: string // what `ssh` gets as destination (alias or user@host)
  env: "native" | `wsl:${string}` // which ssh runs it
  extraArgs?: string[] // settings-defined hosts only
}

export interface ShellOption { …; remote?: RemoteRef }
export interface Session { …; remote?: RemoteRef }

// electron/ssh-config.ts
export interface SshConfigHost {
  alias: string
  hostName?: string // display only
  user?: string // display only
  port?: string // display only
}

// src/lib/ipc.ts
export interface SshHost extends RemoteRef {
  source: "config" | "settings"
  detail?: string // "user@hostname:port" subline
}
export interface SpawnOpts { …; remote?: RemoteRef }
```

---

## 3. PR sequence

| PR    | Steps | Title                                                                       | Status |
| ----- | ----- | --------------------------------------------------------------------------- | ------ |
| **A** | 1 + 2 | `✨ feat(ssh): parse ssh config and build ssh spawn commands`               | ⬜     |
| **B** | 3 + 4 | `✨ feat(ssh): spawn remote sessions and keep them in the layout`           | ⬜     |
| **C** | 5     | `✨ feat(ssh): connect to saved hosts from the sidebar, picker and palette` | ⬜     |
| **D** | 6 + 7 | `✨ feat(ssh): lazy reconnect on restore and after exit` (+ docs)           | ⬜     |

A is pure logic only; B makes it work end to end (from DevTools); C is the visible feature;
D finishes it. The steps below keep their original detail.

### Step 1 (PR A): `✨ feat(ssh): parse ssh config into a host list`

Pure parser + `Include` resolution. No wiring yet.

**Files:** `electron/ssh-config.ts`, `electron/ssh-config.test.ts`, fixtures under
`electron/__fixtures__/ssh/`.

**API**

```ts
/** Host entries of one config file's text; Include lines returned separately. Pure. */
export function parseSshConfig(text: string): { hosts: SshConfigHost[]; includes: string[] }

/** Resolve a config and its Includes (depth ≤ 8, cycle-safe) into a de-duplicated host list.
 *  `fs` is injected so tests use a fake. */
export async function loadSshConfig(
  path: string,
  fs: MiniFs,
  home: string,
): Promise<SshConfigHost[]>
```

**Parsing rules**

- Keywords are case-insensitive; `Key value` and `Key=value` both work; `#` comments; quoted
  values (`Host "my box"`).
- `Host a b c` → three hosts sharing that block's `HostName` / `User` / `Port`.
- Skip aliases with `*` or `?`, and negations (`!foo`).
- Ignore `Match` blocks (keywords after `Match` belong to it until the next `Host`/`Match`).
- First value wins for a keyword (OpenSSH semantics), within a block.
- `Include` paths: `~` expanded, relative paths resolve against `~/.ssh`, globs expanded
  (sorted, like OpenSSH). An `Include` inside a `Host` block still contributes hosts.
- Same alias defined twice → first definition wins.
- CRLF line endings (Windows configs).

**Tests:** each rule above; empty file; a missing Include target (skipped, no throw); an
Include cycle; depth cap; a 1 000-host file parses in < 20 ms.

- [ ] Step 1 done

---

### Step 2 (PR A): `✨ feat(ssh): build ssh spawn commands and settings`

Pure builders for host merging and argv, plus the settings block.

**Files:** `electron/ssh-hosts.ts`, `electron/ssh-hosts.test.ts`, `src/settings/schema.ts`,
`src/settings/schema.test.ts`, `src/types.ts`, `src/lib/ipc.ts` (types only).

**Settings** (`Settings.ssh`, validated in `mergeSettings`; bad entries dropped):

```ts
ssh: {
  fromSshConfig: boolean // default true
  reuseConnections: boolean // default true
  hidden: string[] // aliases hidden from the list
  hosts: { name: string; target: string; args?: string[] }[]
}
```

(`persist` and `hostOverrides` arrive with phase 2.)

**API**

```ts
/** Config hosts (per env) + settings hosts → the sidebar list, hidden filtered, ids stable. */
export function mergeHosts(input: {
  native: SshConfigHost[]
  wsl: Record<string, SshConfigHost[]> // distro → hosts
  settings: Settings["ssh"]
}): SshHost[]

/** The ControlMaster flags for a host, or [] (Windows ssh.exe / reuse off). */
export function reuseFlags(opts: {
  platform: NodeJS.Platform
  env: RemoteRef["env"]
  reuse: boolean
  controlDir: string
}): string[]

/** Worst-case ControlPath length incl. ssh's temp suffix; picks the fallback dir if needed. */
export function controlDir(home: string, uid: number): string

/** Final spawn for a remote session: { file, args } for node-pty. */
export function buildSshSpawn(
  remote: RemoteRef,
  ctx: {
    platform: NodeJS.Platform
    sshPath: string
    reuse: boolean
    controlDir: string
  },
): { file: string; args: string[] }
```

**`buildSshSpawn` output**

- native unix: `ssh [reuse] [extraArgs] -t <target>`
- native Windows: `<ssh.exe path> [extraArgs] -t <target>` (no reuse)
- WSL: `wsl.exe -d <distro> --cd ~ -- sh -c 'mkdir -p -m 700 "$1" && shift && exec ssh "$@"' sh <in-distro controlDir> [reuse] [extraArgs] -t <target>`
  (the `sh -c` creates the ControlPath dir inside the distro, where main can't reach it
  reliably)

**Tests:** ids per source; hidden filtering; duplicate alias across native and WSL kept
separately; settings host overriding nothing; argv for each platform/env; `extraArgs`
ordering; no reuse flags on Windows native; reuse inside WSL; ControlPath fallback when
`home` is long; quoting of a target with spaces; `wslContext("ssh", …)` returns undefined
(guard for 1e).

- [ ] Step 2 done

---

### Step 3 (PR B): `✨ feat(ssh): list hosts and spawn remote sessions in main`

Main-process wiring. Still no UI.

**Files:** `electron/main.ts`, `electron/preload.ts`, `src/lib/ipc.ts`,
`electron/ssh-hosts.ts` (small additions), `electron/wsl-paths.ts` (reuse only).

**New IPC**

| Channel             | Kind   | Payload                                |
| ------------------- | ------ | -------------------------------------- |
| `ssh:list-hosts`    | handle | → `SshHost[]` (cached)                 |
| `ssh-hosts-changed` | event  | host list changed (config or settings) |
| `ssh:open-config`   | on     | open `~/.ssh/config` in the editor     |
| `pty:exit:<id>`     | event  | `{ code, signal }` when a PTY exits    |

`ipc.ts` additions: `listSshHosts()`, `onSshHostsChanged(cb)`, `openSshConfig()`,
`onPtyExit(id, cb)`.

**Host list service** (in main, off the hot path)

- Native: `loadSshConfig(~/.ssh/config)`, then the system config (`/etc/ssh/ssh_config`;
  Windows `%ProgramData%\ssh\ssh_config`) appended after it: its `blocks` join the user's
  for `muxSetFor` / `configMux` (settings hosts), and its `watch` paths join the watcher.
- WSL (Windows only): for each distro from `listShells()`'s WSL entries, resolve the distro
  home once (`wsl.exe -d <d> -e sh -c 'printf %s "$HOME"'`, 5 s timeout, cached), then read
  `<home>/.ssh/config` through `wslUncCandidates(distro, path)`. A distro that fails is
  skipped silently.
- Merge with `mergeHosts` (pass `configMux` from each env's blocks); cache; recompute on
  chokidar changes to any path in `watch` (files tried, glob dirs — so new files show up) and on `settings-changed`; emit `ssh-hosts-changed` (debounced 200 ms).
- First call is lazy (on `ssh:list-hosts`), so startup cost is zero until the sidebar asks.

**`pty:spawn` remote branch**

- If `opts.remote`: `remote = trustedRemote(opts.remote, trustList)` where `trustList =
mergeHosts(…, { all: true })` (hidden hosts included, so a restored pane keeps its args).
  null → write an error into the pane, don't spawn.
- Connection reuse: run `buildSshProbe(remote)` (`ssh -G`, async, 2 s timeout, cached per
  hostId until the host list changes); `reuse = settings.reuseConnections &&
wantOurMux(parseSshG(out) | null, remote)`. A failed probe means no reuse (safe side).
- Then `{ file, args } = buildSshSpawn(remote, { …ctx, reuse })`. Skip `buildInjection`,
  `buildWslInjection`, `wslCdArgs`; start cwd = `os.homedir()`; keep the env as today
  (COLORFGBG etc. don't cross ssh, which is fine).
- Record `remote` on the `PtySession` (for diagnostics and phase 2's kill-session).
- Native unix: `fs.mkdirSync(controlDir, { recursive: true, mode: 0o700 })` once.
- Windows: resolve `ssh.exe` with the existing `commandOnPath` (fallback
  `%SystemRoot%\System32\OpenSSH\ssh.exe`). Missing → write a clear error into the pane
  instead of spawning.
- `proc.onExit` also sends `pty:exit:<id>` to the current sender.

**Tests:** host-list service logic lives in `ssh-hosts.ts` with injected fs / exec (debounce,
cache invalidation, failed distro skipped). `pty:spawn` itself stays manual (node-pty can't
load in Vitest).

**Manual check:** from DevTools, `window.smterm.listSshHosts()` returns the config hosts;
`ptySpawn({ …, remote })` opens a working ssh session.

- [ ] Step 3 done

---

### Step 4 (PR B): `✨ feat(ssh): remote sessions in the store and layout`

Renderer state, persistence, labels, and the local-data guards. Still no new UI.

**Files:** `src/types.ts`, `src/store.ts`, `src/store.test.ts`, `src/lib/shells.ts`,
`src/lib/shells.test.ts`, `src/lib/workspace.ts`, `src/lib/workspace.test.ts`,
`src/lib/session-label.ts`, `src/lib/session-label.test.ts`,
`src/terminal/terminal-manager.ts`.

**Changes**

- `makeSession(shell, cwd)` copies `shell.remote`; remote sessions get no `cwd`.
- `inheritShell(shells, src)` returns a `ShellOption` carrying `src.remote` (label = host label).
- Store: `sshHosts: SshHost[]` + `setSshHosts`; `setSessionCwd` is a no-op for remote sessions
  (1c).
- `terminal-manager.ts` `spawn()`: pass `remote: session.remote` in `ptySpawn`; skip the file
  link provider for remote sessions (1d); ignore OSC 7 for them.
- Workspace: persist `remote` on `PersistedSession`; `deserializeWorkspace` validates it (bad
  shape → drop the field, keep the session as a local shell rather than failing restore).
  Version stays 2: the field is additive, and older builds ignore it and run `ssh <target>`
  from `command`/`args`, which still works.
- Labels: `shellType` → `"ssh"`; `displaySessionTitle` falls back to the host label for remote
  sessions (custom OSC title still wins); new `remoteSubline(remote)` → `user@host` or target.

**Tests**

- store: split / new surface / open-folder-in-split from a remote pane stay remote with the
  same `hostId`; `setSessionCwd` ignored for remote; closing drops it like any session.
- shells: `inheritShell` carries `remote`; a local source stays local.
- workspace: round-trip with `remote`; malformed `remote` dropped without losing the session;
  a v2 file without `remote` still restores.
- labels: title fallbacks, custom OSC title precedence, subline.

- [ ] Step 4 done

---

### Step 5 (PR C): `✨ feat(ssh): connect to saved hosts from the sidebar, picker and palette`

The visible feature.

**Files:** `src/app.tsx`, `src/components/sidebar.tsx` (+ test), `src/components/top-bar.tsx`
(+ test), `src/components/command-palette.tsx` (+ test), `src/components/terminal-pane.tsx`,
`src/components/diff-panel.tsx`, `src/components/files-panel.tsx`,
`src/lib/use-active-cwd.ts`.

**App startup:** after shells load, `ipc.listSshHosts()` → `setSshHosts`; subscribe to
`onSshHostsChanged`. Non-blocking: the first tab never waits on it.

**Sidebar "Remote" section** (below the session tree, collapsible, remembered in the
per-viewer UI state like other collapse state):

- Grouped by env when there's more than one ("This machine", "WSL: Ubuntu", …).
- Row: globe icon, label, `detail` subline, a dot when any open session has that `hostId`.
- Click → `newTab(hostShellOption)`. Hover buttons: split right, split down (split the active
  pane with that host).
- Empty state: "No hosts in ~/.ssh/config" + "Open ssh config" button.

**Top-bar new-tab picker:** an "SSH" group after local shells, same entries.

**Command palette:** `SSH: Connect to host…` (one entry per host, fuzzy), `SSH: Open ssh
config`, and per-host "Split right on <host>".

**Pane header / tab:** globe icon + host label for remote sessions (`terminal-pane.tsx` header,
top-bar tab).

**Panels:** `useActiveRemote()` hook (next to `useActiveCwd`). Changes and Files panels
render "Remote session on `<host>`. Changes and files for remote folders aren't available yet."
when the focused session is remote. The Agents panel is global and needs no change. Git
polling in `app.tsx` already stops because remote sessions have no cwd.

**Tests:** sidebar lists hosts, groups by env, connected dot, click creates a remote tab,
empty state; picker shows the SSH group; palette entries; panels show the remote notice.

- [ ] Step 5 done

---

### Step 6 (PR D): `✨ feat(ssh): lazy reconnect on restore and after exit`

**Files:** `src/terminal/terminal-manager.ts`, `src/components/terminal-pane.tsx`,
`src/store.ts`.

**Lazy restore.** A remote session restored from `workspace.json` doesn't spawn on attach.
`spawn()` checks a per-entry `deferred` flag (set for remote sessions coming from
`restoreWorkspace`) and instead writes a one-line placeholder into the xterm:

```
[smterm] gpu-box: press Enter to connect
```

The first keystroke (or a Connect button in the pane header) clears `deferred` and runs the
real `ptySpawn`. The keystroke that triggered it is not forwarded. Hidden surfaces
(`ensureRunning`) stay deferred too. Local sessions are unaffected.

**Reconnect after exit.** `onPtyExit(id)` marks the entry exited. For remote sessions with a
non-zero code, write `[smterm] connection closed (code N). Press Enter to reconnect.` Enter
respawns with the **same session id**: reset `entry.spawned`, drop the old data listener, call
`ptySpawn` again (main deleted the old record on exit, so this spawns fresh). Exit code 0
(user typed `exit`) shows "session ended" with the same option.

**Tests:** the defer/exit state transitions are pulled into a small pure helper
(`src/lib/remote-connect.ts`: `initial(session, restored)`, `onKey`, `onExit`) with unit tests.
The xterm wiring stays thin.

- [ ] Step 6 done

---

### Step 7 (PR D): `📝 docs(ssh): document ssh remotes`

- README: feature bullet + short "SSH hosts" section (reads `~/.ssh/config`, reuse, WSL).
- `docs/ARCHITECTURE.md`: SSH section (1a–1g in short form).
- `docs/GOTCHAS.md`: `#ssh` anchor (ControlPath length, no reuse on Windows `ssh.exe`, remote
  sessions never set a local cwd, WSL spawn path).
- `docs/ROADMAP.md`: milestone row.
- `CLAUDE.md`: structure lines for `electron/ssh-config.ts`, `electron/ssh-hosts.ts`, and a
  one-line gotcha.
- `SSH_REMOTES.md`: tick phase 1.

- [ ] Step 7 done

---

## 4. Acceptance pass (before PR D)

Run on macOS and Linux; Windows + WSL if a machine is available (else mark untested in README).

- [ ] Every non-pattern host in `~/.ssh/config` (incl. `Include`d files) appears; patterns don't.
- [ ] Editing `~/.ssh/config` updates the sidebar within a second.
- [ ] Key auth, passphrase-protected key, ssh-agent, password auth, 2FA prompt all work in-pane.
- [ ] `ProxyJump` host connects.
- [ ] Split from an SSH pane opens on the same host in < 1 s with no auth prompt (reuse).
- [ ] New surface and "open folder in split" from an SSH pane also stay on the host.
- [ ] Changes / Files panels show the remote notice; no local git polling for remote panes.
- [ ] Remote output containing `/etc/hosts` is not a clickable local link.
- [ ] Quit + relaunch: SSH panes show "press Enter to connect"; no auth prompts until you do.
- [ ] Network drop (turn off Wi-Fi): pane shows "connection closed", Enter reconnects.
- [ ] `exit` on the remote: "session ended", Enter starts a new one.
- [ ] Windows native host via `ssh.exe` works (each pane authenticates).
- [ ] WSL host: runs the distro's ssh, reads the distro's config, reuse works, no
      `-- bash --rcfile` appended.
- [ ] `SMTERM_PERF=1`: e2e throughput and idle CPU unchanged vs `main`.

---

## 5. Out of this plan

Phase 2 (tmux persistence + install banner) and phase 3 (remote shell integration) as designed
in `SSH_REMOTES.md` §6 and §8. Write their plans after PR D, using what phase 1 taught us.
