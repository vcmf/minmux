# Configuration

Settings live in a single JSON file that is the source of truth. Edit it by hand or through the
in-app settings panel; a live watcher re-applies changes as you save. Keys you leave out keep
their defaults.

- macOS and Linux: `~/.config/minmux/settings.json`
- Windows: `%APPDATA%\minmux\settings.json`

```jsonc
{
  "font": { "family": "JetBrains Mono", "size": 13, "ligatures": false, "lineHeight": 1.2 },
  "theme": "catppuccin", // minimal | tokyo-night | catppuccin | gruvbox
  "appearance": "system", // dark | light | system (follow the OS)
  "resumeAgents": "auto", // auto | ask | off
  "agents": { "codex": { "enabled": false } }, // switch one agent's integration off
  "ssh": {
    "pinned": ["native:gpu-box"], // kept in the sidebar
    "colors": { "prod-*": "red", "staging-*": "amber" }, // red | amber | blue | #rrggbb
  },
}
```

## Keys

| Key                       | Default                       | What                                                                                                                                                  |
| ------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `font`                    | FiraCode Nerd Font Mono, 13   | `family`, `size`, `lineHeight`, `ligatures`. Ligatures stay off by default: with the WebGL renderer they garble glyphs in splits.                     |
| `theme`                   | `minimal`                     | `minimal`, `tokyo-night`, `catppuccin`, `gruvbox`; each has a dark and a light variant.                                                               |
| `appearance`              | `dark`                        | `dark`, `light`, or `system` (follows the OS live).                                                                                                   |
| `renderer`                | `webgl`                       | `webgl` or `dom` (slower; for a GPU that misbehaves).                                                                                                 |
| `cursorBlink`             | `true`                        |                                                                                                                                                       |
| `scrollback`              | `5000`                        | Lines kept per terminal.                                                                                                                              |
| `confirmQuit`             | `true`                        | Ask before quitting while terminals are open.                                                                                                         |
| `shareHistory`            | `true`                        | zsh/bash history shared across panes, written as you go.                                                                                              |
| `shiftEnterNewline`       | `true`                        | Shift+Enter inserts a newline in agents that support it (Claude Code), instead of submitting.                                                         |
| `defaultShell`            | `""`                          | Shell for new terminals; empty uses your `$SHELL`.                                                                                                    |
| `fileLinks`               | `true`                        | Click file paths in output to open them.                                                                                                              |
| `openPath`                | `code -g {file}:{line}:{col}` | Editor command for a clicked path; empty uses the OS default.                                                                                         |
| `resumeAgents`            | `auto`                        | On relaunch, resume the agent session each pane was in: `auto`, `ask` (a button), or `off`.                                                           |
| `resumeBypassPermissions` | `false`                       | Claude Code: also restore `--permission-mode bypassPermissions` on resume.                                                                            |
| `agents`                  | every agent on                | `{ "claude" \| "codex" \| "opencode": { "enabled": boolean } }`. Off: new terminals aren't wired for it, and its sessions aren't resumed.             |
| `ssh`                     | see [SSH.md](SSH.md)          | `hidden`, `shown`, `pinned`, `colors`, `keepAliveSeconds` (30), `autoReconnect` (true), `restore` (`auto`), `integrationMode` (`ask`), `integration`. |

Defaults are in [`src/settings/schema.ts`](../src/settings/schema.ts); the SSH ones in
[`src/lib/ssh-validate.ts`](../src/lib/ssh-validate.ts), the agent switches in
[`src/settings/agent-switches.ts`](../src/settings/agent-switches.ts).

## Command line

`open` opens a pane in the running app (and starts it if it isn't running). For now the command
is the app's own executable — on macOS `/Applications/minmux.app/Contents/MacOS/minmux`, written
`minmux` below:

```
minmux open [--tab <title>] [--cwd <dir>] [--split right|down] [-- <command> [args…]]
minmux --help
```

- `--tab <title>`: the tab with that exact title, created (and titled) if there's none; without
  it, the active tab. The tab comes to the front.
- `--cwd <dir>`: where the pane starts; default the current directory.
- `--split right|down`: which side of the tab's focused pane the new pane opens on (default
  `right`). A new tab just gets the one pane.
- `-- <command> [args…]`: runs that program (no shell in between) instead of your default shell.
  When it exits the pane stays with its output; closing it always asks first (minmux can't tell
  whether it still runs). A relaunch reopens the pane as a shell in that folder: the command
  isn't run again. With no shell, nothing wraps `claude` with minmux's hooks (status,
  notifications, resume): a script that starts Claude passes them itself —
  `MINMUX_AGENT=claude claude ${MINMUX_CLAUDE_SETTINGS:+--settings "$MINMUX_CLAUDE_SETTINGS"} …`.

Each call adds one pane, so a script can lay out a whole tab, e.g. one tab per wave of work and
one pane per worktree:

```sh
for wt in ~/src/app-wt/*/; do
  minmux open --tab "wave 3" --cwd "$wt" -- ~/bin/start-session.sh "$(basename "$wt")"
done
```

Errors (an unknown option, a missing directory) are printed and exit with status 2; the app
isn't touched. Every request and what became of it is logged in `diagnostics.log`
(`cli-open-*` lines). The first `open` with no app running starts it and stays in the
foreground as the app, attached to that terminal. Linux and Windows are untested (on Windows a
command runs natively, not in WSL).
