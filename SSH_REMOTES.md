# SSH remotes: design and implementation plan

Tracking doc for saved SSH connections in smterm. Click a host, get a terminal on that
machine. Split or add a tab from that pane and the new terminal opens on the same host.
Same idea as VS Code's Remote-SSH host list, scoped to terminals.

Status: **DESIGN, accepted** (2026-09-26). All decisions agreed; no code yet. Update the checklists in §10 as work lands.
Once this ships, move the stable parts into `docs/ARCHITECTURE.md` and a ROADMAP milestone.
Companion: [`SESSION_DAEMON.md`](./SESSION_DAEMON.md) (local sessions surviving an app quit).

---

## 1. Goal and scope

**Goal.** One click from a saved host to a working shell on it, and every follow-up terminal
(split, new surface, new tab from that pane) lands on the same host without re-authenticating.
Where the host has tmux, the remote work survives quitting smterm, sleep, and network drops.

**Phases (agreed 2026-09-26)**

1. **Core:** saved hosts, one-click connect, same-host splits, connection reuse, WSL hosts.
2. **Persistence:** run each SSH pane inside tmux on the server when it's installed; offer to
   install it (a visible command the user runs) when it isn't.
3. **Remote shell integration:** remote cwd + exact status, so splits open in the same folder.

The local session daemon (surviving a quit for **all** panes) is a separate project; see
`SESSION_DAEMON.md`. It complements tmux rather than replacing it (§7).

**Out of scope for now**

- An SSH client library inside smterm. We run the system `ssh`.
- Storing passwords or keys. Auth is whatever `ssh` already does (keys, agent, 1Password,
  hardware keys). Prompts appear in the terminal.
- Installing anything on a server without the user seeing and running the command.
- Remote git diff, remote file browser, remote agents board (see §9, later).
- Port forwarding UI, SFTP, file transfer.

**Principle.** An SSH pane is an ordinary pane whose command happens to be `ssh`. No new
process model, nothing on the PTY → renderer → xterm hot path.

---

## 2. What the code already gives us

Checked against the current tree:

- A session is `{ command, args, cwd, ... }` (`src/types.ts`). `pty:spawn` in
  `electron/main.ts` spawns `command args` via node-pty. `ssh -t <host>` fits as-is.
- `splitActive` and the new-surface action in `src/store.ts` **inherit the source pane's
  shell** (command + args). An SSH pane split already produces another `ssh <host>` pane.
  We mostly need to make that deliberate and add the connection reuse flags.
- `workspace.json` (`src/lib/workspace.ts`) persists each session's **id**, `command` and
  `args`. A restored layout reconnects SSH panes, and the stable session id is what lets a
  restored pane reattach to its tmux session (§6).
- The status heuristic is output-based (output-idle), so working / needs-input dots and
  notifications work over SSH with no changes.

What goes wrong today if you just type `ssh` as a shell:

- `cwd` is local-only. A remote path passed as `cwd` fails `fs.existsSync` and falls back to
  `$HOME`, which is harmless but means the inherited cwd is meaningless for remote panes.
- `buildInjection` targets the local zsh/bash, so a remote shell gets no OSC 133 / OSC 7.
- The Changes / Files panels would read the **local** folder of whatever cwd was last known.
- Restore reconnects every SSH pane at once, which can mean a wall of passphrase/2FA prompts.
- A `wsl.exe … -- ssh …` command would break: `pty:spawn` appends `--cd …` and our WSL
  shell-integration args (`-- bash --rcfile …`) to **every** `wsl.exe` spawn (§5).

---

## 3. Host sources

### 3a. `~/.ssh/config` (primary)

Parse `Host` blocks the way VS Code does. The config stays the single source of truth for
user, port, identity file, `ProxyJump`, and so on; smterm only needs the alias.

- Follow `Include` (relative to `~/.ssh`, glob patterns allowed), with a depth cap.
- Skip patterns: any alias containing `*`, `?`, or starting with `!`.
- A `Host a b c` line yields three hosts.
- Read `HostName` and `User` only for display (subline `user@hostname`). Never pass them to
  `ssh` ourselves; `ssh <alias>` resolves them.
- `Match` blocks are ignored for listing.
- Windows: `%USERPROFILE%\.ssh\config` for native hosts; each WSL distro's own config for WSL
  hosts (§5).

Parser is a pure function in `electron/ssh-config.ts` (text in, host list out) with unit
tests. File reading, `Include` resolution, and watching sit around it.

### 3b. `settings.json` (optional extras)

```jsonc
"ssh": {
  "hosts": [
    { "name": "gpu box", "target": "ubuntu@10.0.0.12", "args": ["-p", "2222"] }
  ],
  "fromSshConfig": true,     // list ~/.ssh/config hosts (default true)
  "reuseConnections": true,  // ControlMaster/ControlPersist (default true, no-op on Windows ssh.exe)
  "persist": "auto",         // "auto" = use tmux when the host has it, "off" = plain shell
  "hidden": ["github.com"]   // aliases to hide from the list
}
```

`target` is anything `ssh` accepts as a destination. `args` are extra `ssh` flags. Per-host
overrides (`persist`, later `integration`) live on the host entry, or in
`ssh.hostOverrides["<alias>"]` for config-sourced hosts. Validated in `src/settings/schema.ts`
like the rest of the settings (bad entries dropped, not fatal).

### 3c. Merged list

`ssh:list-hosts` IPC returns
`{ id, label, target, args, env: "native" | "wsl:<distro>", source: "config" | "settings", detail? }`.
`id` is stable (`config:<env>:<alias>` / `settings:<name>`) so layout restore and the sidebar
can refer to it. Parsed in main, cached, re-parsed only when chokidar sees a config (or an
included file) change. Never on the hot path.

---

## 4. Connecting

### 4a. The command

A host becomes a `ShellOption`:

```
command: "ssh"
args:    [...reuseFlags, ...host.args, "-t", host.target, <remote command>]
```

`<remote command>` is empty in phase 1 (the login shell) and becomes the tmux wrapper in
phase 2 (§6). Running the system `ssh` means every auth method the user already has keeps
working, and failures look like normal `ssh` output in the pane.

On Windows, native hosts resolve `ssh.exe` (OpenSSH ships with Windows 10+). WSL hosts run
the distro's `ssh` (§5).

### 4b. Connection reuse

For follow-up panes on the same host, add (unix `ssh` only, including inside WSL):

```
-o ControlMaster=auto
-o ControlPath=~/.config/smterm/cm/%C
-o ControlPersist=10m
```

- First pane authenticates. Later panes to the same host multiplex over that connection:
  instant, no second passphrase or 2FA prompt.
- `%C` is a 40-char hash of host/port/user. Unix sockets have a ~104 byte path limit on
  macOS, so the dir is short and space-free (`~/.config/smterm/cm`, not the macOS
  `Application Support` userData path). Created `0700`. Resolved length is unit-tested.
- `ControlPersist` keeps the master alive for 10 minutes after the last pane closes. It is a
  background process, so it also outlives an smterm quit (§6).
- If the user's own config sets `ControlMaster`, command-line `-o` wins. `reuseConnections:
false` turns ours off.
- Windows `ssh.exe` does not support ControlMaster. We omit the flags there; each pane
  authenticates separately. Documented, not worked around.

### 4c. Session identity

Add an optional `remote?: { hostId: string; label: string; env: string }` to `Session`. Set
when the session is created from a host, and inherited by splits/surfaces. It drives:

- the host badge and title fallback (`label` instead of `ssh`)
- the "remote session" state in the side panels
- not passing a remote cwd to `pty:spawn` as a local `cwd`
- the spawn path in main (skip local/WSL shell integration, §5)
- the tmux session name (§6)

`session-label.ts` gets a remote branch (pure, tested).

### 4d. Splits, surfaces, new tabs

- Split / new surface from an SSH pane: same host (already how inheritance works; keep it).
  The split menu offers "local shell" explicitly.
- New tab from the top bar: uses the picker as today; SSH hosts appear in it.
- Phase 3 adds "same remote folder" (§8).

### 4e. Exit and reconnect

When `ssh` exits (network drop, `exit`, remote reboot) the pane shows the exit line as today.
Add a small "Reconnect" affordance in the pane when a remote session's process exits non-zero,
which respawns the same session id with the same command. With tmux (§6), reconnect lands back
in the same live session.

---

## 5. WSL

On Windows, a user who works in WSL keeps their keys, `~/.ssh/config` and agent **inside the
distro**. For them an SSH pane goes into WSL first, then runs that distro's `ssh`:

```
wsl.exe -d <distro> --cd ~ -- ssh [reuse flags] -t <host> [remote command]
```

- **Connection reuse works.** It's Linux OpenSSH, so ControlMaster is available (unlike
  Windows `ssh.exe`).
- **ControlPath must live on the distro's Linux filesystem** (`~/.config/smterm/cm/%C`
  inside WSL). Unix sockets don't work on `/mnt/c` (drvfs).
- **Host list per environment.** Each distro's `~/.ssh/config` is read through
  `\\wsl$\<distro>\home\<user>\.ssh\config` (reusing `wsl-paths.ts` UNC helpers; the home
  path comes from `getent passwd`, already used by `buildWslInjection`). The sidebar groups
  hosts by environment: "Windows" (`ssh.exe`) and "WSL: Ubuntu" etc. The same alias can
  appear in both.
- **Separate spawn path.** Today `pty:spawn` treats any `wsl.exe` command as a WSL _shell_
  and appends `wslCdArgs` + `buildWslInjection` args. Remote sessions must skip that: main
  builds the full `wsl.exe` argv for a WSL host itself and marks the spawn as remote (a
  `remote` flag on `SpawnOpts`), so no `-- bash --rcfile …` gets appended.
- **Startup cost.** One `wsl.exe` hop per pane, same as WSL shells today (a few hundred ms
  on a cold distro).
- Native (non-WSL) hosts on Windows use `ssh.exe` with no reuse.

---

## 6. Persistence with tmux (phase 2)

### 6a. What happens on quit and reopen

**Phase 1 (no tmux):** quitting smterm (after the confirm dialog) kills every `ssh` client.
The remote shells get SIGHUP and everything running in them dies. The ControlMaster connection
survives for 10 minutes. On reopen the layout comes back; each SSH pane reconnects lazily when
focused (instant, no auth, if within 10 minutes) into a **fresh** shell.

**Phase 2 (tmux on the host):** each SSH pane runs inside its own tmux session on the server.
Quitting smterm kills only the local `ssh` client; the tmux session and whatever runs in it (a
`claude` mid-task, a build) keep going. Reopening runs the same command, which **reattaches**
to the live screen. Sleep, Wi-Fi changes and VPN drops are survived the same way.

### 6b. The remote command

```
tmux -L smterm -f /dev/null new-session -A -s smterm-<installId>-<sessionId> \; <options>
```

- `-L smterm`: a separate tmux server socket, so we never touch the user's own tmux sessions.
- `-f /dev/null`: ignore the user's `~/.tmux.conf`, so the pane looks and behaves like a
  plain terminal. Our options are passed on the command line after `\;`:
  `status off` (no tmux status bar), `mouse on`, `history-limit 50000`, `escape-time 0`,
  `set-titles on` (OSC title reaches our tab), `bell-action any` (bell → our attention dot),
  `allow-passthrough on` (tmux ≥ 3.3; lets phase-3 OSC 7/133 through).
- `new-session -A`: attach if the session exists, create it otherwise. Same command for first
  open and every reconnect.
- Session name uses the smterm session id, which `workspace.json` already persists, plus a
  short per-install id so two laptops using the same server never collide or reap each other.

### 6c. Detection, no separate probe

The pane's remote command is a small POSIX script (built by a pure, tested function, run via
`exec sh -c '…'` so it works whatever the user's login shell is):

```sh
if command -v tmux >/dev/null 2>&1; then exec tmux -L smterm ...
else printf '\033]<private-osc>;smterm;no-tmux;%s\007' "$(. /etc/os-release 2>/dev/null; echo "$ID")"
     exec "${SHELL:-sh}" -l
fi
```

No extra round trip, and it works on Windows `ssh.exe` too (no ControlMaster needed). The
renderer catches the private OSC and records "no tmux" for that host.

### 6d. Suggest the install (option 1, agreed)

When a host reports no tmux, the pane header shows:

> ⚠ Sessions on `gpu-box` won't survive disconnects. **[Install tmux]** · Not now · Don't ask for this host

- **[Install tmux]** types the install command into that pane **without pressing Enter**. The
  user sees it, presses Enter, and `sudo` prompts in the terminal as usual.
- The command comes from a **local whitelist** keyed by the reported distro id, never from a
  string the remote sent: `apt-get install -y tmux` (debian/ubuntu), `dnf install -y tmux`
  (fedora/rhel/rocky/alma), `yum install -y tmux`, `apk add tmux` (alpine),
  `pacman -S --noconfirm tmux` (arch), `zypper install -y tmux` (suse), `brew install tmux`
  (macOS host). Unknown distro → the banner links to instructions instead of typing anything.
- After install, the banner offers "Restart pane in tmux". New panes to the host use tmux.
- "Don't ask" is remembered per host in `settings.json` (`persist: "off"`).
- No silent installs, ever. A no-sudo static-binary install and `dtach` as a lighter backend
  are possible later (§9).

### 6e. Closing, cleanup, quit

- **Closing a pane** ends its tmux session: main runs
  `ssh <host> tmux -L smterm kill-session -t <name>` over the ControlMaster (async, best-effort,
  off the hot path). Quitting the app does **not**, which is the point.
- **Orphans** (pane closed while offline): on the next connect to a host, main lists
  `tmux -L smterm ls` and kills sessions with **this install's** prefix that no longer exist
  in the workspace. Other installs' sessions are never touched.
- **Quit dialog** counts only sessions that will die. Persistent SSH panes are listed as
  "keep running on `<host>`" instead of adding to the warning.
- **Known trade-off:** scrollback lives in tmux, so smterm's own scrollback/⌘F only sees the
  current screen for these panes. `mouse on` makes wheel scrolling enter tmux copy mode. The
  pane header gets a hint the first time.

---

## 7. tmux vs the local daemon

|                                        | tmux on the server | `SESSION_DAEMON.md` |
| -------------------------------------- | ------------------ | ------------------- |
| smterm quit / crash / update           | ✅                 | ✅                  |
| Laptop sleep, network drop, VPN change | ✅                 | ❌ ssh client dies  |
| Laptop reboot                          | ✅                 | ❌                  |
| Local (non-SSH) panes                  | ❌                 | ✅                  |
| Needs anything on the server           | tmux               | nothing             |
| Native smterm scrollback / ⌘F          | ❌ tmux owns it    | ✅                  |

Both are planned. With the daemon in place, an SSH pane on a host without tmux still survives
an smterm quit (but not a network drop).

---

## 8. Remote shell integration (phase 3)

Goal: OSC 7 cwd and OSC 133 marks from the remote shell, so splits open in the same remote
folder and status is exact.

Approach: send our zsh/bash integration over the connection at start, without touching the
remote dotfiles.

- The bootstrap detects the login shell and starts it with our script (bash: `--rcfile` via a
  temp file; zsh: a temp `ZDOTDIR` that sources the user's real `.zshrc`, same trick as local).
- Script is sent inline (base64) so nothing is installed permanently; temp files go in
  `${TMPDIR:-/tmp}` and are removed on exit.
- Inside tmux, the scripts wrap OSC 7/133 in tmux passthrough (`allow-passthrough on`, §6b).
- On split with a known remote cwd: the new pane starts with `cd <quoted cwd>` before the shell.
- Opt-in per host at first (`"integration": true`) because remote environments vary (busybox,
  restricted shells, `ForceCommand`). If the bootstrap fails, fall back to a plain shell.
- Reuses the scripts in `electron/shell-integration.ts`; the bootstrap builder is pure and tested.

---

## 9. Later

- No-sudo tmux install: upload a static tmux we build in CI (x86_64/arm64, checksummed) to
  `~/.local/share/smterm/bin`. Explicit button only.
- `dtach` / `abduco` as a persistence backend that keeps native scrollback.
- Remote Changes panel: `git status` / `git diff` over the ControlMaster connection
  (`ssh <host> git -C <cwd> ...`), throttled, reusing the `git.ts` parsers.
- Remote Files panel: `ls`-style listing over the same connection.
- Remote agents board: hook drops need a return channel (reverse forward or polling); own design.
- Add / edit hosts in the settings panel (writes `settings.json` only).
- Per-host colour, grouping, and folders.

---

## 10. Implementation plan

Each step lands with its tests and passes `make check`. Keep `electron/preload.ts` and
`src/lib/ipc.ts` in sync for every new channel.

### Phase 1: saved hosts + one-click connect

| #    | Step                                                                                                                       | Files                                                                        | Status |
| ---- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| 1.1  | Pure `~/.ssh/config` parser (Host blocks, multi-alias, patterns skipped, HostName/User for display) + tests                | `electron/ssh-config.ts`, `.test.ts`                                         | ⬜     |
| 1.2  | `Include` resolution (relative paths, globs, depth cap) + tests with fixture dirs                                          | `electron/ssh-config.ts`                                                     | ⬜     |
| 1.3  | `ssh` settings block in schema (hosts, fromSshConfig, reuseConnections, persist, hidden, overrides) + validation tests     | `src/settings/schema.ts`                                                     | ⬜     |
| 1.4  | Pure host → `ShellOption` builder (reuse flags per platform/env, ControlPath length check, `-t`, extra args) + tests       | `electron/ssh-hosts.ts`, `.test.ts`                                          | ⬜     |
| 1.5  | `ssh:list-hosts` IPC: merge config + settings, cache, chokidar watch → `ssh-hosts-changed` event                           | `electron/main.ts`, `preload.ts`, `src/lib/ipc.ts`                           | ⬜     |
| 1.6  | ControlPath dir (`0700`); resolve `ssh` / `ssh.exe`                                                                        | `electron/main.ts`                                                           | ⬜     |
| 1.7  | `SpawnOpts.remote`: remote spawns skip local + WSL shell integration and don't use a remote cwd locally                    | `electron/main.ts`, `src/lib/ipc.ts`, `terminal-manager.ts`                  | ⬜     |
| 1.8  | WSL hosts: read each distro's ssh config via UNC; build `wsl.exe -d … --cd ~ -- ssh …`; in-distro ControlPath              | `electron/ssh-config.ts`, `ssh-hosts.ts`, `wsl-paths.ts`                     | ⬜     |
| 1.9  | `Session.remote` field; set on create from a host; inherited on split/surface                                              | `src/types.ts`, `src/store.ts`, `store.test.ts`                              | ⬜     |
| 1.10 | Labels: host badge + title fallback for remote sessions                                                                    | `src/lib/session-label.ts`, `.test.ts`                                       | ⬜     |
| 1.11 | Sidebar "Remote" section grouped by environment (list, connected dot, connect / split menu)                                | `src/components/sidebar.tsx`, `.test.tsx`                                    | ⬜     |
| 1.12 | Hosts in the new-tab shell picker + palette `SSH: Connect to host…`, `SSH: Open ~/.ssh/config`                             | `top-bar.tsx`, `command-palette.tsx`                                         | ⬜     |
| 1.13 | Globe icon + host on pane header and tab                                                                                   | `terminal-pane.tsx`, `top-bar.tsx`                                           | ⬜     |
| 1.14 | Remote state in Changes / Files / Agents panels (skip local reads)                                                         | `diff-panel.tsx`, `files-panel.tsx`, `agents-panel.tsx`, `use-active-cwd.ts` | ⬜     |
| 1.15 | Workspace: persist `remote`; restore SSH panes lazily (connect on first focus, "Connect" placeholder until then)           | `src/lib/workspace.ts`, `.test.ts`, `terminal-manager.ts`                    | ⬜     |
| 1.16 | Reconnect affordance when a remote session exits non-zero                                                                  | `terminal-pane.tsx`                                                          | ⬜     |
| 1.17 | Manual acceptance: key auth, passphrase, 2FA, ProxyJump, reuse (second pane instant), network drop, restore, ssh.exe, WSL  | —                                                                            | ⬜     |
| 1.18 | Docs: README feature bullet, ARCHITECTURE section, ROADMAP milestone, GOTCHAS entry (ControlPath length, Windows no-reuse) | `README.md`, `docs/*`                                                        | ⬜     |

**Exit criteria:** every `~/.ssh/config` host (native and per WSL distro) shows in the sidebar;
one click opens a working shell; a split from it opens on the same host in under a second
without an auth prompt (macOS/Linux/WSL); panels don't show local data for remote panes; quit
and relaunch restores SSH panes without a burst of prompts; lint + tests green.

### Phase 2: tmux persistence

| #   | Step                                                                                                          | Files                                          | Status |
| --- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------ |
| 2.1 | Pure remote-command builder: POSIX detect script, tmux argv + options, session naming, quoting + tests        | `electron/ssh-hosts.ts`, `.test.ts`            | ⬜     |
| 2.2 | Per-install id (generated once, stored in config dir)                                                         | `electron/main.ts`                             | ⬜     |
| 2.3 | Private OSC handler → per-host `tmux: present / missing (distro)` state                                       | `terminal-manager.ts`, `store.ts`              | ⬜     |
| 2.4 | Install banner: local whitelist of install commands (pure + tests), type-without-Enter, "don't ask" persisted | `src/lib/tmux-install.ts`, `terminal-pane.tsx` | ⬜     |
| 2.5 | Pane close → async `kill-session` over the master; orphan sweep on connect (own prefix only)                  | `electron/main.ts`, `ssh-hosts.ts`             | ⬜     |
| 2.6 | Quit dialog: exclude persistent panes, list them as "keep running"                                            | `electron/main.ts`                             | ⬜     |
| 2.7 | First-use hint about tmux scrollback / copy mode                                                              | `terminal-pane.tsx`                            | ⬜     |
| 2.8 | Acceptance: quit + reopen reattaches, lid close, Wi-Fi switch, tmux 2.x vs 3.3+, two laptops on one server    | —                                              | ⬜     |

**Exit criteria:** on a host with tmux, a running `claude` survives quitting smterm and closing
the lid, and the pane reattaches to it on reopen; on a host without tmux the banner appears once
with the right command; closing a pane leaves no tmux session behind.

### Phase 3: remote shell integration

| #   | Step                                                                                       | Files                               | Status |
| --- | ------------------------------------------------------------------------------------------ | ----------------------------------- | ------ |
| 3.1 | Pure bootstrap builder (detect shell, inline base64 script, temp rc, cleanup trap) + tests | `electron/shell-integration.ts`     | ⬜     |
| 3.2 | tmux passthrough wrapping for OSC 7/133 when `$TMUX` is set                                | `electron/shell-integration.ts`     | ⬜     |
| 3.3 | Per-host `integration` opt-in; fallback to a plain shell on bootstrap failure              | `electron/ssh-hosts.ts`, schema     | ⬜     |
| 3.4 | Track remote cwd from OSC 7 (host-qualified, kept separate from local cwd)                 | `terminal-manager.ts`, `store.ts`   | ⬜     |
| 3.5 | Split / surface starts in the same remote cwd                                              | `electron/ssh-hosts.ts`, `store.ts` | ⬜     |
| 3.6 | Acceptance on bash, zsh, busybox sh, a `ForceCommand` host, with and without tmux          | —                                   | ⬜     |

### Performance checklist

- Config parsing, `Include` resolution, and file watching run in main, cached, off the PTY path.
- No per-keystroke or per-output work added for remote panes (the private OSC is one parser hook).
- tmux cleanup and orphan sweeps are async, over the existing master connection.
- Remote panel features (later) are polled and throttled over the master connection.

---

## 11. Decisions

| #   | Question                 | Decision                                                                                    | Status |
| --- | ------------------------ | ------------------------------------------------------------------------------------------- | ------ |
| D1  | Host source              | `~/.ssh/config` (+ per-WSL-distro configs) + `settings.json` extras; never write ssh config | agreed |
| D2  | Split from an SSH pane   | Always same host; split menu offers "local shell" explicitly                                | agreed |
| D3  | Restore on launch        | Lazy: connect when the pane is first focused                                                | agreed |
| D4  | Windows                  | Hosts grouped by environment: `ssh.exe` for Windows hosts, distro `ssh` for WSL hosts       | agreed |
| D5  | Remote shell integration | Phase 3, opt-in per host                                                                    | agreed |
| D6  | Persistence              | tmux when present (`persist: "auto"`); detect + suggest install, never silent               | agreed |
| D7  | Ordering vs the daemon   | SSH core → tmux persistence → daemon (separate project)                                     | agreed |

---

## 12. Risks

| Risk                                                 | Mitigation                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| ControlPath too long (unix socket limit)             | `%C` hash + short `~/.config/smterm/cm` dir; length unit-tested                    |
| Stale master after network change blocks new panes   | `ControlPersist` timeout; on connect failure retry once with `-o ControlMaster=no` |
| User's own `ControlMaster` config conflicts          | Our `-o` flags win; `reuseConnections: false` opts out                             |
| Restore triggers many auth prompts                   | Lazy connect (D3)                                                                  |
| WSL spawn path appends shell-integration args        | `SpawnOpts.remote` skips it (1.7)                                                  |
| tmux options missing on old tmux (< 3.3)             | Options are best-effort; passthrough only needed for phase 3                       |
| Remote spoofs the "no tmux" OSC                      | Worst case a banner; install command comes from a local whitelist only             |
| Orphaned tmux sessions pile up on servers            | Close → kill-session; orphan sweep on connect; per-install prefix                  |
| Remote bootstrap breaks odd shells                   | Opt-in, fallback to plain shell, acceptance matrix (3.6)                           |
| Panels silently showing local data for a remote pane | `Session.remote` checked in `use-active-cwd` and each panel (1.14)                 |
