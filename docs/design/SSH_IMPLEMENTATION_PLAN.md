# SSH remotes: implementation plan (phase 1)

Build plan for phase 1 of [`SSH_REMOTES.md`](./SSH_REMOTES.md): hosts from `~/.ssh/config`
(native + WSL), one-click connect, same-host splits, keepalive, restore. The design and the
_why_ live in that doc; this one is the _how_, as four stacked PRs on `epic/ssh-remotes`.
Phases 2 (tmux) and 3 (remote shell integration) get their own plan once phase 1 ships.

Status: **A–C merged** into the epic, **D built** (2026-09-27), in review. Scope revised on 2026-09-27: no automatic
connection reuse, no settings-defined hosts (see `SSH_REMOTES.md` §4b, D1/D8).

---

## 0. Ground rules

- Four PRs, stacked: A → `epic/ssh-remotes`, B → A, C → B, D → C. Each passes `make check`
  and ships its tests.
- Per PR: plan → implement → `/code-review high` on **that PR's own diff**, at most **3**
  rounds. Another round only if the last one found something **severe** = a crash, data loss,
  a security issue, or connecting to the wrong host. Anything else left over becomes a
  follow-up issue.
- PR titles use the repo format with emoji, e.g. `✨ feat(ssh): parse ssh config into a host list`.
- Pure logic goes in pure modules with Vitest tests; main-process glue stays thin.
- `electron/preload.ts` and `src/lib/ipc.ts` change together whenever a channel is added.
- Nothing touches the PTY → renderer → xterm hot path. Host parsing and file watching run in
  main, async and cached.
- Touching terminals, spawn or focus → verify in the real app (`run-smterm` skill).

---

## 1. PR sequence

| PR    | Title                                                                             | Status    |
| ----- | --------------------------------------------------------------------------------- | --------- |
| **A** | `✨ feat(ssh): parse ssh config and build ssh spawn commands` (#63)               | ✅ merged |
| **B** | `✨ feat(ssh): spawn remote sessions and keep them in the layout` (#66)           | ✅ merged |
| **C** | `✨ feat(ssh): connect to saved hosts from the sidebar, picker and palette` (#68) | ✅ merged |
| **D** | `✨ feat(ssh): reconnect on restore and after exit` (+ docs)                      | 🚧 review |

---

## 2. As built: PR A (pure logic)

- `electron/ssh-config.ts` — OpenSSH config reader for the list: `Include` with globs (sorted
  like glob(3), escapes), conditional includes under `Host`/`Match`, first value wins, `%h`,
  `Match all`/`originalhost`, argv_split quoting, case-insensitive aliases, cycles bounded +
  a hard budget, the paths to watch. `wslMiniFs` reads a distro's config via its UNC share
  in Linux paths.
- `electron/ssh-hosts.ts` — `mergeHosts` (stable ids, hidden filtered case-insensitively, WSL
  hosts only on Windows, `all` = main's trust list), `keepAliveFlags`, `buildSshSpawn`
  (`ssh [keepalive] -t -- alias`, Windows `ssh.exe`, WSL `wsl.exe -d … --cd ~ -e ssh …`),
  `trustedRemote` (main's own copy of a listed host, else null — never a guess).
- `src/lib/ssh-validate.ts` — `isSshTarget` (host/user characters only), `parseSshEnv`,
  `parseRemoteRef`, `sshLabel`, and the `ssh` settings block
  `{ hidden, keepAliveSeconds, restore }`.
- `src/lib/control-chars.ts` — shared with `agent-sessions.ts`.

## 3. As built: PR B (main + store)

- `electron/ssh-service.ts` — host list (native + running WSL distros), watched through one
  long-lived watcher (`electron/ssh-watcher.ts`; only files read or Include-glob matches
  count), WSL results re-read after 30 s; `spawnPlan` rebuilds the command from main's list
  (re-planned if the config changes meanwhile); a restored WSL pane boots only its distro.
- `electron/main.ts` — `pty:spawn` gains an async remote branch (no local shell integration);
  `electron/pending-spawns.ts` makes it one spawn per pane: a reloaded renderer joins the
  pending spawn, a close while pending means it never starts, keys typed before ssh exists
  are dropped (never echoed ahead of a password prompt). New channels: `ssh:list-hosts`,
  `ssh-hosts-changed`, `ssh:open-config`, `pty:exit:<id>`. The quit guard counts spawns
  still preparing; nothing starts once a quit is under way.
- Renderer — `Session.remote` / `ShellOption.remote`: splits and surfaces stay on the host,
  "open folder in split" uses a local shell, OSC 7 is ignored, no file links or Claude resume,
  the title falls back to the host label; `workspace.json` persists the host and restores one
  it can't read as "unavailable" (written back verbatim).

---

### Step 5 (PR C): `✨ feat(ssh): connect to saved hosts from the sidebar, picker and palette`

The visible feature.

**Files:** `src/app.tsx`, `src/store.ts`, `src/components/sidebar.tsx` (+ test),
`src/components/top-bar.tsx` (+ test), `src/components/command-palette.tsx` (+ test),
`src/components/terminal-pane.tsx`, `src/components/diff-panel.tsx`,
`src/components/files-panel.tsx`, `src/lib/use-active-cwd.ts`.

**App startup:** after shells load, `ipc.listSshHosts()` → store `sshHosts`; subscribe to
`onSshHostsChanged`. Non-blocking: the first tab never waits on it.

**Sidebar "Remote" section** (below the session tree, collapsible, remembered):

- Grouped by env when there's more than one ("This machine", "WSL: Ubuntu", …).
- Row: globe icon, label, `detail` subline, a dot when any open session has that `hostId`.
- Click → `newTab(hostShellOption)`. Hover buttons: split right, split down.
- Empty state: "No hosts in ~/.ssh/config" + "Open ssh config" button.

**Top-bar new-tab picker:** an "SSH" group after local shells, same entries.

**Command palette:** `SSH: Connect to host…` (one entry per host, fuzzy), `SSH: Open ssh
config`, and per-host "Split right on <host>".

**Pane header / tab:** globe icon + host label for remote sessions.

**Panels:** `useActiveRemote()`. Changes and Files panels render "Remote session on
`<host>` — changes and files for remote folders aren't available yet." when the focused
session is remote. Git polling already stops (remote sessions have no cwd).

**Tests:** sidebar lists hosts, groups by env, connected dot, click creates a remote tab,
empty state; picker SSH group; palette entries; panels show the remote notice.

As built: pure helpers in `src/lib/ssh-hosts-ui.ts` (`hostShellOption`, `groupHosts`,
`connectedHostIds`, `sameHosts`); store `sshHosts` + `splitWith(direction, shell)`; the
collapsed state of the Remote section is a per-window `localStorage` convenience;
`useActiveWorkCwd` returns nothing for a remote session, so no local git or file read can
target one.

- [x] Step 5 done

---

### Step 6 (PR D): `✨ feat(ssh): reconnect on restore and after exit`

**Files:** `src/terminal/terminal-manager.ts`, `src/components/terminal-pane.tsx`,
`src/store.ts`, `src/lib/remote-connect.ts` (new, pure).

**Restore.** `settings.ssh.restore`:

- `"auto"` (default): restored SSH panes connect as they're shown (the active tab at once,
  background tabs when first opened — the existing lazy start).
- `"on-focus"`: a restored remote session doesn't spawn on attach; the xterm shows
  `[smterm] gpu-box — press Enter to connect`, and Enter (or a Connect button in the pane
  header) spawns it. Other keys are dropped; the Enter isn't forwarded.

**Reconnect after exit.** `onPtyExit(id)` marks the entry exited. Remote sessions show
`[smterm] connection closed (code N) — press Enter to reconnect` (`exit` → "session ended");
Enter respawns the **same session id**: the xterm listeners stay wired (a second
`term.onData` would send every key twice); only the PTY is requested again — main dropped the
old record on exit.

**Tests:** the rules live in `remote-connect.ts` with unit tests; the xterm wiring stays thin
and is driven by `terminal-manager.test.ts` against a fake xterm.

As built: `lib/remote-connect.ts` holds the rules (`firstStart`, `afterStart`, `onKey`,
`idleMessage`, `cleanError`). A restored on-focus pane asks main with `attachOnly`, so a
renderer reload still reattaches a live ssh instead of waiting. Store `remotePhase`
(starting / live / waiting / closed / failed) drives the header's Connect / Reconnect / Retry button and keeps
the sidebar's connected dot to live connections. xterm listeners are wired once per entry; a
reconnect only re-requests the PTY. `settings-panel` gains an SSH section (restore, keepalive).
`terminal-manager.test.ts` drives the lifecycle against a fake xterm.

- [x] Step 6 done

---

### Step 7 (PR D): `📝 docs(ssh): document ssh remotes`

- README: feature bullet + "SSH hosts" section (reads `~/.ssh/config`; the ControlMaster
  snippet for prompt-free splits; keepalive; WSL).
- `docs/ARCHITECTURE.md`: SSH section (trusted host list, plain ssh, pending spawns).
- `docs/GOTCHAS.md`: `#ssh` anchor (remote sessions never set a local cwd; the WSL spawn
  path skips shell integration; one spawn per pane; typed-ahead keys dropped).
- `docs/ROADMAP.md`: milestone row. `CLAUDE.md`: structure lines + a one-line gotcha.
- Move `SSH_REMOTES.md` / this plan to `docs/design/` once phase 1 ships; tick phase 1.

- [x] Step 7 done

---

## 4. Acceptance pass (before PR D merges)

Run on macOS and Linux; Windows + WSL if a machine is available (else mark untested in README).

- [ ] Every non-pattern host in `~/.ssh/config` (incl. `Include`d files) appears; patterns don't.
- [ ] Editing `~/.ssh/config` updates the sidebar within a second; ssh writing known_hosts doesn't.
- [ ] Key auth, passphrase-protected key, ssh-agent, password auth, 2FA prompt all work in-pane.
- [ ] `ProxyJump` host connects.
- [ ] A user's own `ControlMaster` config makes the second pane instant (smterm adds nothing).
- [ ] Split, new surface from an SSH pane stay on the host; "open folder in split" is local.
- [ ] Changes / Files panels show the remote notice; no local git polling for remote panes.
- [ ] Remote output containing `/etc/hosts` is not a clickable local link.
- [ ] An idle SSH pane survives an hour (keepalive); a dead link ends in ~2 minutes, not never.
- [ ] Quit + relaunch: `auto` reconnects the visible panes; `on-focus` waits for Enter.
- [ ] Network drop (turn off Wi-Fi): "connection closed", Enter reconnects.
- [ ] `exit` on the remote: "session ended", Enter starts a new one.
- [ ] Windows native host via `ssh.exe` works.
- [ ] WSL host: runs the distro's ssh, reads the distro's config, no `-- bash --rcfile`.
- [ ] `SMTERM_PERF=1`: e2e throughput and idle CPU unchanged vs `main`.

---

## 5. Out of this plan

Phase 2 (tmux persistence + install banner) and phase 3 (remote shell integration) as designed
in `SSH_REMOTES.md` §6 and §8. Write their plans after PR D, using what phase 1 taught us.
