# SSH remotes: design and implementation plan

Tracking doc for saved SSH connections in minmux. Click a host, get a terminal on that
machine. Split or add a tab from that pane and the new terminal opens on the same host.
Same idea as VS Code's Remote-SSH host list, scoped to terminals.

Status: **phase 1 in review** (PRs #63 → B → C → D on `epic/ssh-remotes`). Revised 2026-09-27: hosts from `~/.ssh/config` only, no automatic connection reuse, keepalive added. Update the checklists in §10 as work lands.
Once this ships, move the stable parts into `docs/ARCHITECTURE.md` and a ROADMAP milestone.
Companion: [`SESSION_DAEMON.md`](./SESSION_DAEMON.md) (local sessions surviving an app quit).

---

## 1. Goal and scope

**Goal.** One click from a host in `~/.ssh/config` to a working shell on it, and every
follow-up terminal (split, new surface, new tab from that pane) lands on the same host.
Where the host has tmux, the remote work survives quitting minmux, sleep, and network drops.

**Phases (agreed 2026-09-26)**

1. **Core:** hosts from `~/.ssh/config` (native + WSL), one-click connect, same-host splits,
   keepalive, restore after relaunch.
2. **Persistence:** run each SSH pane inside tmux on the server when it's installed; offer to
   install it (a visible command the user runs) when it isn't.
3. **Remote shell integration:** remote cwd + exact status, so splits open in the same folder.

The local session daemon (surviving a quit for **all** panes) is a separate project; see
`SESSION_DAEMON.md`. It complements tmux rather than replacing it (§7).

**Out of scope for now**

- An SSH client library inside minmux. We run the system `ssh`.
- Defining hosts inside minmux. `~/.ssh/config` is the only source (§3).
- Silent connection reuse (ControlMaster). Tried and dropped (§4b); users who want instant,
  prompt-free splits add it to their own ssh config.
- Storing passwords or keys. Auth is whatever `ssh` already does (keys, agent, 1Password,
  hardware keys). Prompts appear in the terminal.
- Installing anything on a server without the user seeing and running the command.
- Remote git diff, remote file browser, remote agents board (see §9, later).
- Port forwarding UI, SFTP, file transfer.

**Principle.** An SSH pane is an ordinary pane whose command happens to be `ssh`, and that
`ssh` behaves exactly as it would in any other terminal. No new process model, nothing on
the PTY → renderer → xterm hot path.

---

## 2. What the code already gives us

Checked against the current tree:

- A session is `{ command, args, cwd, ... }` (`src/types.ts`). `pty:spawn` in
  `electron/main.ts` spawns `command args` via node-pty. `ssh -t <host>` fits as-is.
- `splitActive` and the new-surface action in `src/store.ts` **inherit the source pane's
  shell** (command + args). An SSH pane split already produces another `ssh <host>` pane.
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

## 3. Hosts: `~/.ssh/config` only

The user's ssh config is the single source of truth: user, port, identity file, `ProxyJump`,
multiplexing, everything. minmux only reads the aliases to list them, and runs
`ssh <alias>`, which resolves the rest. A host defined there also works in VS Code, scripts,
`scp` and `git`.

- Follow `Include` (relative to `~/.ssh`, glob patterns allowed), with a depth cap; an
  Include under a `Host`/`Match` line only lists hosts that block applies to.
- Skip patterns: any alias containing `*`, `?`, or starting with `!`.
- A `Host a b c` line yields three hosts.
- Read `HostName`, `User` and `Port` only for display (subline `user@hostname:port`), with
  ssh's first-match-wins rules. Never passed to `ssh`.
- Windows: `%USERPROFILE%\.ssh\config` for native hosts; each WSL distro's own config for WSL
  hosts (§5).
- "Open ssh config" (sidebar/palette) opens it in the editor, creating an empty one (0600 in a
  0700 `~/.ssh`) if there's none. A later "Add host" form would append a `Host` block there,
  showing exactly what it writes.

Parser: `electron/ssh-config.ts` (pure, unit-tested). Host list: `electron/ssh-hosts.ts`
`mergeHosts`. `ssh:list-hosts` returns `{ hostId, label, target, env, detail? }` with stable
ids (`native:<alias>`, `wsl:<distro>:<alias>`). Parsed in main, cached, re-read only when a
config file it read (or an Include glob's dir) changes. Never on the hot path.

**Settings** (`settings.json` → `ssh`) are presentation and session-keeping only:

```jsonc
"ssh": {
  "hidden": ["github.com"],  // aliases hidden from the list
  "keepAliveSeconds": 30,    // ServerAliveInterval minmux adds (0 = none, the config decides)
  "restore": "auto"          // after a relaunch: "auto" reconnects, "on-focus" waits for Enter
}
```

---

## 4. Connecting

### 4a. The command

```
ssh -o ServerAliveInterval=30 -o ServerAliveCountMax=4 -t -- <alias> [remote command]
```

`<remote command>` is empty in phase 1 (the login shell) and becomes the tmux wrapper in
phase 2 (§6). Running the system `ssh` means every auth method the user already has keeps
working, and failures look like normal `ssh` output in the pane. `--` ends ssh's options, so
an alias can never be read as one.

main builds it (`buildSshSpawn`) from **its own** host list: the renderer only sends which
host (`RemoteRef.hostId`), and an unknown id is refused (`trustedRemote`). A host just
removed from the config is never run as a bare alias that DNS might resolve elsewhere.

On Windows, native hosts resolve `ssh.exe` (OpenSSH ships with Windows 10+). WSL hosts run
the distro's `ssh` (§5).

### 4b. Keepalive — and why there is no automatic connection reuse

**Keepalive.** `ServerAliveInterval` makes ssh send a keepalive inside the encrypted channel
after that many idle seconds: idle NAT / VPN / firewall state stays open (the "session died
over lunch" case), and after `ServerAliveCountMax` (4) missed replies ssh exits cleanly
instead of hanging, so the pane can offer Reconnect. It runs inside ssh itself: no timer in
minmux. On the command line it overrides the user's own value, which is harmless (a
keepalive interval, not a behaviour change); `keepAliveSeconds: 0` leaves it to the config.

**Connection reuse (dropped).** Phase 1 first tried to turn on OpenSSH multiplexing
(`ControlMaster`) silently, so later panes to a host skip re-authenticating. Doing that
without overriding what the user set themselves means predicting ssh's config precedence
(`Match`, `Include`, the system file, permissions, `ProxyJump` quoting, WSL) from outside —
nine review rounds kept finding cases where our model and ssh's disagreed, and the probing
made every spawn slow and async. Removed (2026-09-27). With key + agent auth nothing is
lost but a second of handshake per pane; for password/2FA hosts, the user adds it to their
own config, which minmux's plain `ssh` then honours:

```
Host *
  ControlMaster auto
  ControlPath ~/.ssh/cm-%C
  ControlPersist 10m
```

A visible, opt-in "share connections for this host" that writes such a block (after showing
it) is possible later.

### 4c. Session identity

`Session.remote?: RemoteRef` (`{ hostId, label, target, env }`), set when a session is
created from a host and inherited by splits/surfaces. It drives:

- the host badge and title fallback (the host label, unless a program sets a custom title)
- the "remote session" state in the side panels, and no local cwd (OSC 7 is ignored), no
  file links, no Claude resume
- the spawn path in main (skip local/WSL shell integration, §5)
- the tmux session name (§6)

A saved remote this build can't read (e.g. from a newer build) is restored as "unavailable"
(main refuses it with a message — never run as a local `ssh <target>`) and written back
verbatim on save.

### 4d. Splits, surfaces, new tabs

- Split / new surface from an SSH pane: same host. "Open folder in split" (a local folder)
  uses a local shell.
- New tab from the top bar: uses the picker as today; SSH hosts appear in it.
- Phase 3 adds "same remote folder" (§8).

### 4e. Exit, reconnect, restore

- When `ssh` exits (network drop, `exit`, remote reboot) the pane shows the exit line and a
  Reconnect affordance that respawns the same session id (main emits `pty:exit:<id>`).
- After a relaunch, SSH panes reconnect (a **fresh** remote shell unless tmux, §6).
  `restore: "on-focus"` shows `press Enter to connect` instead — for password/2FA hosts, so a
  restored layout doesn't open a wall of prompts. Background tabs start when first shown.
- Keys typed before the ssh process exists are dropped, not replayed: they would land before
  ssh turns echo off for a password prompt.

---

## 5. WSL

On Windows, a user who works in WSL keeps their keys, `~/.ssh/config` and agent **inside the
distro**. For them an SSH pane goes into WSL first, then runs that distro's `ssh`:

```
wsl.exe -d <distro> --cd ~ -e ssh [keepalive] -t -- <alias> [remote command]
```

- **Host list per environment.** Each running distro's `~/.ssh/config` is read through
  `\\wsl.localhost\<distro>\…` (`wslMiniFs`, Linux paths mapped onto the UNC share); the home
  comes from the distro. The sidebar groups hosts by environment: "Windows" and "WSL: Ubuntu"
  etc. The same alias can appear in both.
- **Never boots a VM to list hosts:** only running distros are read (`wsl -l --running`).
  A restored pane boots just its own distro (up to 20 s), and says so if it doesn't answer.
  Watching `\\wsl$` shares is unreliable, so a distro's config is also re-read after 30 s.
- **Separate spawn path.** `pty:spawn` treats any `wsl.exe` command as a WSL _shell_ and
  appends `wslCdArgs` + `buildWslInjection` args. Remote sessions skip that: main builds the
  full `wsl.exe` argv itself (`-e` execs ssh directly, no shell re-parse).
- **Startup cost.** One `wsl.exe` hop per pane, same as WSL shells today.

---

## 6. Persistence with tmux (phase 2)

### 6a. What happens on quit and reopen

**Phase 1 (no tmux):** quitting minmux (after the confirm dialog) kills every `ssh` client.
The remote shells get SIGHUP and everything running in them dies. On reopen the layout comes
back and each SSH pane reconnects (or waits for Enter, `restore: "on-focus"`) into a
**fresh** shell.

**Phase 2 (tmux on the host):** each SSH pane runs inside its own tmux session on the server.
Quitting minmux kills only the local `ssh` client; the tmux session and whatever runs in it (a
`claude` mid-task, a build) keep going. Reopening runs the same command, which **reattaches**
to the live screen. Sleep, Wi-Fi changes and VPN drops are survived the same way.

### 6b. The remote command

```
tmux -L minmux -f /dev/null new-session -A -s minmux-<installId>-<sessionId> \; <options>
```

- `-L minmux`: a separate tmux server socket, so we never touch the user's own tmux sessions.
- `-f /dev/null`: ignore the user's `~/.tmux.conf`, so the pane looks and behaves like a
  plain terminal. Our options are passed on the command line after `\;`:
  `status off` (no tmux status bar), `mouse on`, `history-limit 50000`, `escape-time 0`,
  `set-titles on` (OSC title reaches our tab), `bell-action any` (bell → our attention dot),
  `allow-passthrough on` (tmux ≥ 3.3; lets phase-3 OSC 7/133 through).
- `new-session -A`: attach if the session exists, create it otherwise. Same command for first
  open and every reconnect.
- Session name uses the minmux session id, which `workspace.json` already persists, plus a
  short per-install id so two laptops using the same server never collide or reap each other.

### 6c. Detection, no separate probe

The pane's remote command is a small POSIX script (built by a pure, tested function, run via
`exec sh -c '…'` so it works whatever the user's login shell is):

```sh
if command -v tmux >/dev/null 2>&1; then exec tmux -L minmux ...
else printf '\033]<private-osc>;minmux;no-tmux;%s\007' "$(. /etc/os-release 2>/dev/null; echo "$ID")"
     exec "${SHELL:-sh}" -l
fi
```

No extra round trip, and it works on Windows `ssh.exe` and inside WSL alike. The
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
  `ssh <host> tmux -L minmux kill-session -t <name>` (async, best-effort, off the hot path;
  it reuses the user's own ControlMaster connection if they set one up). Quitting the app does **not**, which is the point.
- **Orphans** (pane closed while offline): on the next connect to a host, main lists
  `tmux -L minmux ls` and kills sessions with **this install's** prefix that no longer exist
  in the workspace. Other installs' sessions are never touched.
- **Quit dialog** counts only sessions that will die. Persistent SSH panes are listed as
  "keep running on `<host>`" instead of adding to the warning.
- **Known trade-off:** scrollback lives in tmux, so minmux's own scrollback/⌘F only sees the
  current screen for these panes. `mouse on` makes wheel scrolling enter tmux copy mode. The
  pane header gets a hint the first time.

---

## 7. tmux vs the local daemon

|                                        | tmux on the server | `SESSION_DAEMON.md` |
| -------------------------------------- | ------------------ | ------------------- |
| minmux quit / crash / update           | ✅                 | ✅                  |
| Laptop sleep, network drop, VPN change | ✅                 | ❌ ssh client dies  |
| Laptop reboot                          | ✅                 | ❌                  |
| Local (non-SSH) panes                  | ❌                 | ✅                  |
| Needs anything on the server           | tmux               | nothing             |
| Native minmux scrollback / ⌘F          | ❌ tmux owns it    | ✅                  |

Both are planned. With the daemon in place, an SSH pane on a host without tmux still survives
an minmux quit (but not a network drop).

---

## 8. Remote shell integration (phase 3)

Goal: OSC 7 cwd and OSC 133 marks from the remote shell, so splits can open in the same remote
folder and status is exact. Built on the `epic/ssh-integration` branch in three steps:
**P3a** the bootstrap and handshake, **P3b** trusting only nonce-tagged reports (folder,
status), **P3c** reopening a verified folder on split, reconnect and restore.

**Which hosts** (`lib/ssh-integration.ts`): `ssh.integrationMode` is `ask` (default), `all` or
`off`, and `ssh.integration` holds ssh-style patterns inside it (a host's own `alias` / `!alias`
entry beats any pattern). `ask`: only the hosts listed; `all`: every host but `!alias` ones;
`off`: none. It's never simply on for everyone by default: it runs our script on every host
you reach (audit logs and session recorders see it, the MOTD goes, network gear and git-only
hosts error once), so the user chooses. To make that choice easy to find, in `ask` mode the
first split (or new terminal) of an ssh pane on a host no entry mentions shows a one-line
hint on the new pane: **Turn on** (writes `alias`; applies from its next connection) /
**Never** (writes `!alias`) / × (not now: not asked again for that host this run).
The host menu's toggle and Settings → SSH → Shell integration change the same two keys. The hint
stays on the split it was offered on (a second split doesn't move it and resize that pane),
goes when that pane closes, and hides as soon as the host is decided elsewhere. An older build
ignores `integrationMode`: after a downgrade, "Off" falls back to the list alone (and "All
hosts" to the list only, the safe way).

**Two channels** (`electron/remote-bootstrap.ts`, pure and tested). #78 showed that nothing
variable may travel in text the host's login shell parses (fish `\'`, cmd.exe `%VAR%`), and
other users on the host can read a command line with `ps`:

- **The command is fixed**: `exec sh -c '<challenge> <base64 of the bootstrap>'`. Inside the
  quotes: no quote, backslash, `!` or newline, so bash, zsh, fish and csh pass it to `sh`
  unchanged. The only variable part is a hex challenge. It holds no secret and no folder.
- **The nonce goes through the terminal**: the bootstrap prints `OSC 6973;boot;<challenge>`,
  turns echo off (raw, `-isig`: ^C is just data meanwhile), prints `OSC 6973;hello;<challenge>`
  and reads lines, 5 s each. Main answers straight from the pty output (`HelloWatch`, a bounded
  scan that stops once answered, skipped, or 64 KB after boot): `minmux:<nonce>:-`. A pre-login
  banner can't trigger it: it doesn't know the challenge. Lines typed during the login (an
  Enter while the banner scrolls) are read past: only the line with the `minmux:` marker and a
  32-hex nonce counts. With no answer at all, it waits out a late one (until 2 s of quiet) so
  it can never be typed into the shell, then prints `skip` and runs the plain shell.

**On the host** the bootstrap (POSIX sh) takes the login shell from `$SHELL`:

- bash: `--rcfile` a temp file that reads what a login bash would (`/etc/profile`, then the
  first of `.bash_profile` / `.bash_login` / `.profile`), then our hooks; `logout` and
  `~/.bash_logout` work as in a login shell. (`$0` isn't `-bash`, and `shopt login_shell` is
  off.)
- zsh: `zsh -l` with a temp `ZDOTDIR` holding only a `.zshenv`. It puts the user's own
  `ZDOTDIR` back first (as sshd's `zsh -c` left it, so an XDG `~/.config/zsh` works), removes
  the temp dir, sources the user's `.zshenv` and adds the hooks; zsh then reads the user's
  `.zprofile` / `.zshrc` / `.zlogin` itself. Nothing started from them (tmux…) inherits our
  `ZDOTDIR`.
- The temp dir (`mktemp -d`, 0700, in `$TMPDIR`) is gone as soon as the shell has read it. The
  nonce is assigned before any user file runs and explicitly unexported (`allexport` can't leak
  it). The host's history settings are left alone, and no `claude` wrapper is set up.
- Anything else (fish, dash, no `mktemp` / `stty`, no answer) → `exec $SHELL -l`, the plain
  login shell.
- Known gaps: a `/etc/zsh/zshenv` that forces `ZDOTDIR` skips our file (no integration, and the
  0700 temp dir stays until the host clears `$TMPDIR`). sshd prints no MOTD / "Last login"
  when a command is given, so opted-in hosts don't show them.

**The hooks** are the local ones with every report tagged: `OSC 6973;<nonce>;C`, `;D;<exit>`
and `;P;<host>;<hex of $PWD's bytes>`, and no standard OSC 7 / 133 at all, so nothing untagged
can pass for them. The folder is hex, not a `file://` URL: a URL is re-parsed on the way (`#`
and `?` cut it, `\` and `..` are normalised, `%2F` is decoded), so a crafted directory name
could make a report name a different, real directory. Hex arrives exactly as the shell has it;
the renderer refuses (never repairs) non-UTF-8, relative paths, `.` / `..` segments, control or
format characters. At a prompt the hooks use `printf` and builtins only (a test checks for
`$(` or backticks): the hex loop costs ~0.3 ms (zsh) to ~1 ms (macOS bash 3.2) for a long path.

**When it can't run**:

- A `RemoteCommand` in the config (ssh refuses a command beside it, and the user's wins):
  main asks `ssh -G` with the same options (Match and Include count), for opted-in hosts only,
  cached until the config or settings change. Any doubt → a plain connection.
- The host has no `sh` (a Windows host, a `ForceCommand`): the pane ends on its own before
  `boot`, within two minutes, not by a signal (closing a pane or ^C at a password prompt
  doesn't count) and not with ssh's own 255. It prints a note, and main connects that host
  plainly until its integration setting or the ssh config changes.

**Cost** (local, stub host): the first prompt comes about 30 ms later (bash 9 → 37 ms, zsh
17 → 51 ms), plus one round trip on a real link; nothing per keystroke or per output byte.

**In the renderer (P3b)**: the bootstrap prints `OSC 6973;ok;<challenge>` once it has taken
a valid answer. Only then does main hand the renderer the nonce (`pty:nonce:<id>`, sent before
the output that follows; on a reattach, before the replay, and in the spawn result). A nonce the
host didn't take (a late answer typed into the plain shell, a `skip`) is never trusted.
`lib/remote-reports.ts` parses the reports; only this connection's nonce counts (a nested
integrated shell has its own). The first tagged report makes the pane _verified_:

- At our shell's prompt (after a tagged `D`), untagged OSC 7 / 133 and titles are ignored —
  they're PS1 (Ubuntu's `user@host: dir` title), a prompt framework, or something printed.
- While a command it started runs (a tagged `C`, no `D` yet: `exec zsh`, `sudo -i`, a nested
  shell with no hooks), untagged folder reports are shown again, but never verified: the
  sidebar follows the nested shell, and P3c has nothing to reopen until our shell reports.
- A tagged folder the renderer refuses clears the old one (it moved; where is unknown).
- Tagged `C` / `D` drive the same status as local OSC 133 (not the local-only Claude resume
  flow). A tagged folder is stored with `remoteCwdVerified`, the only kind P3c will reopen.
- A new connection forgets the nonce and the folder.

Known gaps: `exec zsh` leaves the pane "running" (its `C` never gets a `D`) until the
connection ends. With `set -x` / `setopt xtrace` on the host, the hooks' `printf` lines trace
the nonce. Anything that replays raw pane output on the host (`script` logs, tmux
`capture-pane -e`) replays valid reports of that connection. A server `ForceCommand` that goes
on to an interactive session (a bastion) exposes the challenge in `$SSH_ORIGINAL_COMMAND`, so a
program there could answer our hello itself; the effect stays on that host.

Measured: a 300k-line firehose takes the same time on an integrated and a plain pane (~615 ms),
and the local `MINMUX_PERF` suite shows no change against v0.1.39 (e2e ~22–24 MB/s either way,
renderer ~50 MB/s).

**Reopening the folder (P3c)**: only a verified folder, and only on an integrated host.

- Where it comes from: `reopenFor(session)` — the folder the pane's shell verifiably reported
  (a reconnect), else the pane's `reopenCwd`: its split source's verified folder (split, new
  terminal in the pane) or the one saved in `workspace.json` (a relaunch; validated on load, as
  the file is only as trusted as its writer). A host picked by hand opens at home. Any report
  of where the shell is (tagged or not, e.g. a plain connection's own OSC 7) replaces it, and
  one no report confirms within 60 s (a hung mount, a shell that never reports) is dropped, so
  it can't hang every later reconnect and relaunch.
- How it travels: in `pty:spawn` to main, which validates it again (`parseReopen`, at most
  1024 UTF-8 bytes) and puts it in the handshake answer: `minmux:<nonce>:<host's first
label>:<hex bytes, dot-separated>`. Never on the command line, and never read by the login
  shell.
- On the host: kept only if `uname -n` matches the reporting host's first label (one alias can
  reach several machines: round-robin logins), else a dim note — checked before decoding. The
  bootstrap's `sh` then decodes one byte per field (`IFS=.`, `$((0x$b))` → octal escapes → one
  `printf`): linear, ~10 ms for 1 KB. The user's shell `builtin cd`s after its own startup
  files (bash: the end of our rc; zsh: a one-shot first `precmd`, ahead of our hooks so the
  reported folder is the new one). A folder that's gone gets a dim note, and the shell stays
  where its files put it.
- A plain host never gets it (the rule from #78 stands for anything unverified).
- Known gaps: on a hard NFS mount (no `intr`) a hung `cd` can't be interrupted with ^C; the
  pane has to be closed (the reopen is dropped after 60 s, so it won't happen again). Machines
  behind one alias that share a default hostname (`ubuntu`, `localhost`) pass the check. An
  answer that arrives after the fallback (a very slow link) is typed into the plain shell,
  where it's an inert "command not found" that lands in that shell's history with the folder's
  hex.

Still to come: inside tmux (phase 2) the scripts wrap their reports in tmux passthrough
(`allow-passthrough on`, §6b).

---

## 9. Later

- No-sudo tmux install: upload a static tmux we build in CI (x86_64/arm64, checksummed) to
  `~/.local/share/minmux/bin`. Explicit button only.
- `dtach` / `abduco` as a persistence backend that keeps native scrollback.
- Remote Changes panel: `git status` / `git diff` over a short ssh call
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

| #    | Step                                                                                                                                                             | Files                                                                        | Status |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------ |
| 1.1  | Pure `~/.ssh/config` parser (Host blocks, multi-alias, patterns skipped, HostName/User for display) + tests                                                      | `electron/ssh-config.ts`, `.test.ts`                                         | ⬜     |
| 1.2  | `Include` resolution (relative paths, globs, depth cap) + tests with fixture dirs                                                                                | `electron/ssh-config.ts`                                                     | ⬜     |
| 1.3  | `ssh` settings block (hidden, keepAliveSeconds, restore) + validation tests                                                                                      | `src/lib/ssh-validate.ts`, `src/settings/schema.ts`                          | ⬜     |
| 1.4  | Pure host list + spawn builder (`-t -- alias`, keepalive, WSL argv) + `trustedRemote` + tests                                                                    | `electron/ssh-hosts.ts`, `.test.ts`                                          | ⬜     |
| 1.5  | `ssh:list-hosts` IPC: merge config + settings, cache, chokidar watch → `ssh-hosts-changed` event                                                                 | `electron/main.ts`, `preload.ts`, `src/lib/ipc.ts`                           | ⬜     |
| 1.6  | Resolve the ssh binary (PATH / ssh.exe), async                                                                                                                   | `electron/main.ts`                                                           | ⬜     |
| 1.7  | `SpawnOpts.remote`: remote spawns skip local + WSL shell integration and don't use a remote cwd locally                                                          | `electron/main.ts`, `src/lib/ipc.ts`, `terminal-manager.ts`                  | ⬜     |
| 1.8  | WSL hosts: read each running distro's ssh config via UNC; build `wsl.exe -d … --cd ~ -e ssh …`                                                                   | `electron/ssh-config.ts`, `ssh-hosts.ts`, `ssh-service.ts`                   | ⬜     |
| 1.9  | `Session.remote` field; set on create from a host; inherited on split/surface                                                                                    | `src/types.ts`, `src/store.ts`, `store.test.ts`                              | ⬜     |
| 1.10 | Labels: host badge + title fallback for remote sessions                                                                                                          | `src/lib/session-label.ts`, `.test.ts`                                       | ⬜     |
| 1.11 | Sidebar "Remote" section grouped by environment (list, connected dot, connect / split menu)                                                                      | `src/components/sidebar.tsx`, `.test.tsx`                                    | ⬜     |
| 1.12 | Hosts in the new-tab shell picker + palette `SSH: Connect to host…`, `SSH: Open ~/.ssh/config`                                                                   | `top-bar.tsx`, `command-palette.tsx`                                         | ⬜     |
| 1.13 | Globe icon + host on pane header and tab                                                                                                                         | `terminal-pane.tsx`, `top-bar.tsx`                                           | ⬜     |
| 1.14 | Remote state in Changes / Files / Agents panels (skip local reads)                                                                                               | `diff-panel.tsx`, `files-panel.tsx`, `agents-panel.tsx`, `use-active-cwd.ts` | ⬜     |
| 1.15 | Workspace: persist `remote`; restore SSH panes lazily (connect on first focus, "Connect" placeholder until then)                                                 | `src/lib/workspace.ts`, `.test.ts`, `terminal-manager.ts`                    | ⬜     |
| 1.16 | Reconnect affordance when a remote session exits non-zero                                                                                                        | `terminal-pane.tsx`                                                          | ⬜     |
| 1.17 | Manual acceptance: key auth, passphrase, 2FA, ProxyJump, the user's own ControlMaster honoured, keepalive over an idle hour, network drop, restore, ssh.exe, WSL | —                                                                            | ⬜     |
| 1.18 | Docs: README feature bullet (+ the ControlMaster snippet), ARCHITECTURE section, ROADMAP milestone, GOTCHAS entry                                                | `README.md`, `docs/*`                                                        | ⬜     |

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

**Exit criteria:** on a host with tmux, a running `claude` survives quitting minmux and closing
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

| #   | Question                 | Decision                                                                              | Status |
| --- | ------------------------ | ------------------------------------------------------------------------------------- | ------ |
| D1  | Host source              | `~/.ssh/config` only (+ per-WSL-distro configs); minmux settings are display-only     | agreed |
| D2  | Split from an SSH pane   | Always same host; split menu offers "local shell" explicitly                          | agreed |
| D3  | Restore on launch        | Lazy: connect when the pane is first focused                                          | agreed |
| D4  | Windows                  | Hosts grouped by environment: `ssh.exe` for Windows hosts, distro `ssh` for WSL hosts | agreed |
| D5  | Remote shell integration | Phase 3, opt-in per host                                                              | agreed |
| D6  | Persistence              | tmux when present (`persist: "auto"`); detect + suggest install, never silent         | agreed |
| D7  | Ordering vs the daemon   | SSH core → tmux persistence → daemon (separate project)                               | agreed |
| D8  | Connection reuse         | Not automatic (dropped 2026-09-27); users add ControlMaster to their own config       | agreed |
| D9  | Keepalive                | `ServerAliveInterval=30` / `CountMax=4` by default (`keepAliveSeconds`, 0 = off)      | agreed |
| D10 | Restore after relaunch   | `restore: "auto"` (default) or `"on-focus"` (press Enter) for password/2FA hosts      | agreed |

---

## 12. Risks

| Risk                                                 | Mitigation                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------- |
| Password/2FA hosts prompt on every pane              | Documented ControlMaster snippet; `restore: "on-focus"`                |
| Idle connections dropped by NAT/firewalls            | `ServerAliveInterval` keepalive (§4b)                                  |
| Restore triggers many auth prompts                   | Lazy connect (D3)                                                      |
| WSL spawn path appends shell-integration args        | `SpawnOpts.remote` skips it (1.7)                                      |
| tmux options missing on old tmux (< 3.3)             | Options are best-effort; passthrough only needed for phase 3           |
| Remote spoofs the "no tmux" OSC                      | Worst case a banner; install command comes from a local whitelist only |
| Orphaned tmux sessions pile up on servers            | Close → kill-session; orphan sweep on connect; per-install prefix      |
| Remote bootstrap breaks odd shells                   | Opt-in, fallback to plain shell, acceptance matrix (3.6)               |
| Panels silently showing local data for a remote pane | `Session.remote` checked in `use-active-cwd` and each panel (1.14)     |
