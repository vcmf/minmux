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
