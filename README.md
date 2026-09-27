<p align="center">
  <img src="docs/media/icon.png" alt="smterm" width="128" height="128" />
</p>

<h1 align="center">smterm</h1>

<p align="center">A minimal terminal for agentic coding, built to keep you in the loop (yes we love reading the code).</p>

<p align="center">
  <a href="https://github.com/vcmf/smterm/actions/workflows/ci.yml"><img src="https://github.com/vcmf/smterm/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Linux%20%C2%B7%20Windows%2FWSL-informational" alt="Platforms" />
</p>

<p align="center">If smterm looks useful to you, a ⭐ helps other people find it.</p>

<p align="center">
  <img src="docs/media/screenshot.jpg" alt="smterm running four agent sessions in split panes, with the Agents board on the right" width="100%" />
</p>

**smterm** is a fast, cross-platform terminal (tabs, split panes, real shells) for people who run
coding agents all day. It stays out of your way like a normal terminal, then adds a few panels
that show you what the agents are actually doing: git diffs, files, and a live agents board that
works with Claude Code. If you have looked for an open-source Warp alternative, or a tmux built
for coding agents, this is that.

- 🔔 **Notifications when a session needs you.** Working, waiting for input, or done, shown as a
  dot on the tab and in the sidebar, plus a native OS notification when a background pane wants
  you. No more finding a finished agent an hour late.
- 🔍 **Changes panel.** A git diff for the focused pane's working directory, so you can read
  what an agent just touched. Branch and ahead/behind show in the status bar.
- 📁 **Files browser.** A lazy per-folder listing rooted at the focused pane's cwd, with git
  decorations (badges on changed files, tinted folders). Click a file to open it in your editor.
- 🤖 **Agents board.** A live view of the Claude Code agents you launched inside smterm: the
  root session, its sub-agents, what each is doing, its cwd, and its recent files. Click one to
  jump to its pane.
- 🪟 **Real multiplexer.** Tabs and resizable splits. Split a pane and it keeps your shell and
  directory. Quit and reopen and your layout comes back.
- 🌐 **SSH hosts in one click.** The hosts in your `~/.ssh/config` are listed in the sidebar.
  Click one for a terminal on it; splits and new terminals from that pane stay on the host. A
  dropped connection says so and reconnects on Enter.
- 🖥️ **Cross-platform.** macOS, Linux, and Windows, with WSL as a first-class shell target.
- ⌨️ **Command palette (⌘K).** New sessions, splits, theme switching, settings.
- 🎨 **Themes and fonts.** Minimal Dark, Tokyo Night, Catppuccin, Gruvbox; bundled fonts and
  ligatures.

## Install

macOS and Linux:

```
curl -fsSL https://raw.githubusercontent.com/vcmf/smterm/main/install.sh | sh
```

Windows (PowerShell):

```
irm https://raw.githubusercontent.com/vcmf/smterm/main/install.ps1 | iex
```

## A closer look

<table>
  <tr>
    <td width="42%"><img src="docs/media/feat-agents.jpg" width="100%" alt="Agents board showing sessions, sub-agents, status, and token usage" /></td>
    <td><b>Agents board.</b> A live tree of the Claude Code agents you launched: each session, its sub-agents, what they are doing, and token usage. Click one to jump to its pane.</td>
  </tr>
  <tr>
    <td width="42%"><img src="docs/media/feat-notifications.png" width="100%" alt="Notification bell with an unread badge in the top bar" /></td>
    <td><b>Notifications when a session needs you.</b> A dot on the tab and a native OS notification the moment a background pane wants input or finishes.</td>
  </tr>
  <tr>
    <td width="42%"><img src="docs/media/feat-sessions.jpg" width="100%" alt="Sidebar tree of sessions and panes with status dots" /></td>
    <td><b>Every session and pane at a glance.</b> The sidebar tree shows each session, its panes, and a status dot: running, needs input, or idle.</td>
  </tr>
  <tr>
    <td width="42%"><img src="docs/media/feat-changes.jpg" width="100%" alt="Changes panel showing a git diff" /></td>
    <td><b>Changes panel.</b> A live git diff for the focused pane's working directory, with per-file counts and the full unified diff.</td>
  </tr>
  <tr>
    <td width="42%"><img src="docs/media/feat-files.jpg" width="100%" alt="Files browser with git decorations on changed files" /></td>
    <td><b>Files browser.</b> A lazy per-folder listing rooted at the pane's cwd, with git decorations on changed files.</td>
  </tr>
  <tr>
    <td width="42%"><img src="docs/media/feat-file-preview.jpg" width="100%" alt="Inline file preview open over the terminal" /></td>
    <td><b>Open a file and read it.</b> Click a file to open an inline preview and read what an agent wrote, without leaving the terminal.</td>
  </tr>
</table>

## Works with Claude Code

Run `claude` in any pane and the Agents board lights up: the root session, its sub-agents, what
each is doing, its working directory, and the files it touched. It reads Claude Code's own hook
events, so there is zero setup and no global config to edit; smterm only wires the panes it
launches. Agents started outside smterm do not show up.

## Why I built this

I love the terminal, and the easiest way to put an agent like Claude Code to work is to launch
it from a CLI. But I also like reading the code an agent writes and making the edits myself, and
a plain terminal makes that hard: you lose track of which session needs you, and you never
really see what changed. smterm keeps the shell I already like and adds just enough to stay in
the loop: the Changes, Files, and Agents panels show what happened, not just that something did. It also behaves the same on macOS, Linux and WSL, which helps since
my work moves between all three.

## Also

Beyond the headline features above:

- Copy and paste, find in scrollback (`Cmd`/`Ctrl+Shift` + `F`)
- Collapsible sidebar and a shell picker for new tabs
- The Agents board needs zero setup: it is wired only for panes smterm spawns

## Configuration

Settings live in a single JSON file that is the source of truth. Edit it by hand or through the
in-app settings panel; a live watcher re-applies changes as you save.

- macOS and Linux: `~/.config/smterm/settings.json`
- Windows: `%APPDATA%\smterm\settings.json`

```jsonc
{
  "font": { "family": "JetBrains Mono", "size": 13, "ligatures": true, "lineHeight": 1.2 },
  "theme": "catppuccin", // minimal | tokyo-night | catppuccin | gruvbox
  "appearance": "system", // dark | light | system (follow the OS)
  "cursorBlink": true,
  "scrollback": 5000,
  "ssh": { "hidden": [], "keepAliveSeconds": 30, "restore": "auto" }, // restore: auto | on-focus
}
```

## SSH hosts

smterm reads the hosts from your `~/.ssh/config` (including `Include`d files) and shows them in
the sidebar's **Remote** section, the new-tab picker and the command palette (`SSH: Connect to
host`). It never keeps its own host list, passwords or keys: a click runs the system `ssh
<alias>`, so keys, `ssh-agent`, 1Password, `ProxyJump` and password or 2FA prompts all work as
in any terminal. Editing the config updates the list as you save. Wildcard patterns
(`Host *.corp`) aren't listed; hide a host with `"ssh": { "hidden": ["github.com"] }`.

- **Splits stay on the host.** Splitting an SSH pane, or opening a new terminal in it, opens
  another `ssh` to the same host. "Open folder in split" stays local.
- **Keepalive.** smterm adds `ServerAliveInterval=30` (with `ServerAliveCountMax=4`), so an idle
  pane survives NAT timeouts and a dead link ends in about two minutes instead of hanging.
  `"ssh": { "keepAliveSeconds": 0 }` leaves it to your config.
- **Reconnect.** When `ssh` exits, the pane says why and Enter (or the **Reconnect** button)
  connects again. After a relaunch SSH panes reconnect as they're shown; with
  `"ssh": { "restore": "on-focus" }` they wait for Enter instead, which is handy for password
  or 2FA hosts.
- **Prompt-free splits.** Each pane is its own `ssh`. For hosts that ask for a password, let
  OpenSSH share one connection by adding this to your `~/.ssh/config`:

  ```
  Host *
    ControlMaster auto
    ControlPath ~/.ssh/cm-%C
    ControlPersist 10m
  ```

- **WSL.** On Windows, the hosts in each running WSL distro's `~/.ssh/config` are listed too and
  connect with that distro's own `ssh`.
- The Changes and Files panels show local folders only, so for an SSH pane they say it's remote.

## What is still rough

This is v0. I use it every day, and it will still surprise you sometimes.

- On macOS it is Apple Silicon only for now. Intel is not built yet.
- The app is not code-signed or notarized, so installing it outside the script gives you a
  security prompt the first time.
- Agent status comes from a heuristic (is the pane still producing output, or has it gone
  quiet?), so it reads the state wrong once in a while.
- The Agents board only knows about Claude Code today, since it reads Claude's hook events. The
  code under it does not assume any particular agent, so others can plug in later.
- Windows and WSL have had far less real-world use than macOS and Linux, so expect rougher edges
  there.
- After a full quit, your tabs and layout come back on relaunch, but running processes are not
  restored yet.

Most of these are already on the near-term roadmap, so they should not be rough for long.

Found a bug? [Open an issue](https://github.com/vcmf/smterm/issues). What you did, what
happened, and what you expected is all it takes for a useful report.

## Build from source

```
git clone https://github.com/vcmf/smterm
cd smterm
make install   # deps, native module rebuild, git hooks
make run       # dev mode
make dist      # package an installable build for your OS
```

`make run` uses its own **dev profile** (`~/.config/smterm-dev`, `%APPDATA%\smterm-dev` on
Windows; a DEV badge by the logo), so it runs next to an installed smterm without touching its
settings or layout.
`SMTERM_PROFILE=<name> make run` picks another profile (one per worktree, say);
`SMTERM_PROFILE=default` uses the installed app's config, only while that app is closed. An
installed smterm ignores `SMTERM_PROFILE`; start it with `--profile=<name>` instead (macOS:
`open -a smterm --args --profile=qa`).

Run `make help` for the full list of targets (`make check` runs lint + tests, `make fmt`
formats). Logic lives in small pure modules with real tests (`make test`).

Stack, if you care: Electron, React, TypeScript, xterm.js on the WebGL renderer, and node-pty
for the shells. Zustand for state, react-resizable-panels for the layout, Vitest for tests.
Design and decisions live in [`docs/`](docs/): start with
[ARCHITECTURE.md](docs/ARCHITECTURE.md) and [ROADMAP.md](docs/ROADMAP.md).

## License

[MIT](LICENSE). Do what you want with it.
