# Changelog

What changed in each minmux release, newest first. Generated from the pull request titles by
[git-cliff](https://git-cliff.org): edit `cliff.toml`, not this file.

## [0.1.61](https://github.com/vcmf/minmux/releases/tag/v0.1.61) - 2026-11-08

### Fixed

- Keep the remote section from shrinking under a long session list ([#179](https://github.com/vcmf/minmux/pull/179))

## [0.1.60](https://github.com/vcmf/minmux/releases/tag/v0.1.60) - 2026-10-21

### Added

- Show a PR's labels in its colours, in the list rows and its detail ([#175](https://github.com/vcmf/minmux/pull/175))

### Fixed

- Find past sessions by their name too ([#174](https://github.com/vcmf/minmux/pull/174))

## [0.1.59](https://github.com/vcmf/minmux/releases/tag/v0.1.59) - 2026-10-20

### Added

- Close a PR from its status line, reopen from an undo banner ([#171](https://github.com/vcmf/minmux/pull/171))
- A repo's name opens it on GitHub; a click copies a PR's branch names ([#169](https://github.com/vcmf/minmux/pull/169))

## [0.1.58](https://github.com/vcmf/minmux/releases/tag/v0.1.58) - 2026-10-16

### Added

- Update a PR's branch and switch it between draft and ready from its chips ([#166](https://github.com/vcmf/minmux/pull/166))
- One agents list grouped like the sidebar ([#164](https://github.com/vcmf/minmux/pull/164))
- Tell live agents when the theme changes (mode 2031) ([#159](https://github.com/vcmf/minmux/pull/159))

### Fixed

- Mute the title of a session that isn't open ([#158](https://github.com/vcmf/minmux/pull/158))

## [0.1.57](https://github.com/vcmf/minmux/releases/tag/v0.1.57) - 2026-10-15

### Added

- Colour the agents pane by agent and by session ([#157](https://github.com/vcmf/minmux/pull/157))
- Show the processes each agent session runs ([#155](https://github.com/vcmf/minmux/pull/155))
- Mark your own comments and reviews with (you), the PR author with a chip ([#153](https://github.com/vcmf/minmux/pull/153))

## [0.1.56](https://github.com/vcmf/minmux/releases/tag/v0.1.56) - 2026-10-15

### Added

- Find, search and resume past agent sessions ([#145](https://github.com/vcmf/minmux/pull/145))

## [0.1.55](https://github.com/vcmf/minmux/releases/tag/v0.1.55) - 2026-10-15

### Added

- GitHub PR links in terminals and the sidebar open in the pull requests dialog ([#147](https://github.com/vcmf/minmux/pull/147))
- Merge a PR from the dialog: merge commit, squash or rebase ([#146](https://github.com/vcmf/minmux/pull/146))

## [0.1.54](https://github.com/vcmf/minmux/releases/tag/v0.1.54) - 2026-10-14

### Added

- A PR's checks and commits, live while CI runs; open it on GitHub by its title ([#138](https://github.com/vcmf/minmux/pull/138))
- Show which PRs an agent is working on, and the one this pane is on ([#136](https://github.com/vcmf/minmux/pull/136))

### Faster

- Load the pull requests dialog a tab at a time, never waiting on gh auth ([#135](https://github.com/vcmf/minmux/pull/135))

## [0.1.53](https://github.com/vcmf/minmux/releases/tag/v0.1.53) - 2026-10-14

### Added

- Comment on a pull request, approve it or request changes ([#133](https://github.com/vcmf/minmux/pull/133))
- List every logged-in gh account's PRs and say who the dialog runs as ([#131](https://github.com/vcmf/minmux/pull/131))
- Show stacked PRs as a tree and link related PRs and issues ([#129](https://github.com/vcmf/minmux/pull/129))
- Request and remove reviewers from the pull requests dialog ([#128](https://github.com/vcmf/minmux/pull/128))
- Show a PR's description, conversation and review threads ([#127](https://github.com/vcmf/minmux/pull/127))
- Add a pull requests dialog listing mine, review requested and the focused repo ([#125](https://github.com/vcmf/minmux/pull/125))

## [0.1.52](https://github.com/vcmf/minmux/releases/tag/v0.1.52) - 2026-10-14

### Added

- Show the checkout an agent edits in, with its branch and PR ([#119](https://github.com/vcmf/minmux/pull/119))

## [0.1.51](https://github.com/vcmf/minmux/releases/tag/v0.1.51) - 2026-10-10

### Faster

- Stop the sidebar poll from freezing the terminal every 10 s ([#118](https://github.com/vcmf/minmux/pull/118))

## [0.1.50](https://github.com/vcmf/minmux/releases/tag/v0.1.50) - 2026-10-10

### Added

- Show an agent's folder when it's a subfolder of the same repo ([#116](https://github.com/vcmf/minmux/pull/116))

## [0.1.49](https://github.com/vcmf/minmux/releases/tag/v0.1.49) - 2026-10-09

### Added

- Drag a terminal to another group or out into a new one ([#115](https://github.com/vcmf/minmux/pull/115))

## [0.1.48](https://github.com/vcmf/minmux/releases/tag/v0.1.48) - 2026-10-06

### Added

- Watch expanded folders so new files show up by themselves ([#114](https://github.com/vcmf/minmux/pull/114))
- Re-read folders on expand, add a refresh button, one read queue ([#113](https://github.com/vcmf/minmux/pull/113))

### Faster

- Read folders in a utility process that main can kill ([#112](https://github.com/vcmf/minmux/pull/112))
- Read a folder without blocking main on its symlinks ([#111](https://github.com/vcmf/minmux/pull/111))

## [0.1.47](https://github.com/vcmf/minmux/releases/tag/v0.1.47) - 2026-10-05

### Added

- Rename a session from the sidebar ([#110](https://github.com/vcmf/minmux/pull/110))

## [0.1.46](https://github.com/vcmf/minmux/releases/tag/v0.1.46) - 2026-10-04

### Fixed

- End a coding agent that ignores the hang-up when its pane closes or minmux quits ([#109](https://github.com/vcmf/minmux/pull/109))

## [0.1.45](https://github.com/vcmf/minmux/releases/tag/v0.1.45) - 2026-10-03

### Added

- Resume opencode sessions on relaunch ([#104](https://github.com/vcmf/minmux/pull/104))
- Token badge and session title ([#103](https://github.com/vcmf/minmux/pull/103))
- End sessions whose process exited ([#102](https://github.com/vcmf/minmux/pull/102))
- Agents board for opencode sessions ([#101](https://github.com/vcmf/minmux/pull/101))
- Minmux plugin and scoped loading ([#100](https://github.com/vcmf/minmux/pull/100))
- Resume codex sessions and hint when hooks aren't approved ([#99](https://github.com/vcmf/minmux/pull/99))
- Token badge, thread name and agent icons ([#98](https://github.com/vcmf/minmux/pull/98))
- Agents board for codex sessions ([#97](https://github.com/vcmf/minmux/pull/97))

### Faster

- Check codex's node in the pane, not before the window ([#106](https://github.com/vcmf/minmux/pull/106))

## [0.1.44](https://github.com/vcmf/minmux/releases/tag/v0.1.44) - 2026-10-01

### Fixed

- Stop the git poll from stalling terminals in repos with huge untracked folders ([#92](https://github.com/vcmf/minmux/pull/92))

## [0.1.43](https://github.com/vcmf/minmux/releases/tag/v0.1.43) - 2026-09-29

### Breaking

- Rename the app from smterm to minmux ([#86](https://github.com/vcmf/minmux/pull/86))

## [0.1.42](https://github.com/vcmf/minmux/releases/tag/v0.1.42) - 2026-09-29

### Added

- Reorder sessions by dragging in the top bar or the sidebar ([#85](https://github.com/vcmf/minmux/pull/85))

## [0.1.41](https://github.com/vcmf/minmux/releases/tag/v0.1.41) - 2026-09-29

### Added

- Remote shell integration (opt-in per host) ([#83](https://github.com/vcmf/minmux/pull/83))

## [0.1.40](https://github.com/vcmf/minmux/releases/tag/v0.1.40) - 2026-09-29

### Added

- Close sessions and terminals from the sidebar, asking first when it would kill work ([#81](https://github.com/vcmf/minmux/pull/81))

## [0.1.39](https://github.com/vcmf/minmux/releases/tag/v0.1.39) - 2026-09-28

### Added

- Show a remote pane's folder beside its host ([#78](https://github.com/vcmf/minmux/pull/78))
- Start the remote section collapsed and show connection status in its header ([#77](https://github.com/vcmf/minmux/pull/77))

## [0.1.38](https://github.com/vcmf/minmux/releases/tag/v0.1.38) - 2026-09-28

### Added

- Reconnect a dropped connection a few times on its own, and connect all waiting panes at once ([#75](https://github.com/vcmf/minmux/pull/75))
- A host-first picker, a sidebar of pinned and open hosts, and a host menu ([#74](https://github.com/vcmf/minmux/pull/74))
- Show where a remote pane runs and colour hosts you mark ([#73](https://github.com/vcmf/minmux/pull/73))
- Show connection state everywhere a pane appears, and act on each failure ([#72](https://github.com/vcmf/minmux/pull/72))
- Run a dev build as its own profile beside the installed app ([#70](https://github.com/vcmf/minmux/pull/70))
- Reconnect on restore and after exit ([#69](https://github.com/vcmf/minmux/pull/69))
- Connect to saved hosts from the sidebar, picker and palette ([#68](https://github.com/vcmf/minmux/pull/68))
- Spawn remote sessions and keep them in the layout ([#66](https://github.com/vcmf/minmux/pull/66))
- Parse ssh config and build ssh spawn commands ([#63](https://github.com/vcmf/minmux/pull/63))

### Fixed

- Keep the disconnect line below the last prompt ([#71](https://github.com/vcmf/minmux/pull/71))
- Keep row icons from shrinking next to a long name ([#65](https://github.com/vcmf/minmux/pull/65))

## [0.1.37](https://github.com/vcmf/minmux/releases/tag/v0.1.37) - 2026-09-26

### Fixed

- Resume where claude filed the session and keep background agents from taking over a pane ([#62](https://github.com/vcmf/minmux/pull/62))

## [0.1.36](https://github.com/vcmf/minmux/releases/tag/v0.1.36) - 2026-09-25

### Fixed

- Wait for every pty to exit before quitting ([#61](https://github.com/vcmf/minmux/pull/61))

## [0.1.35](https://github.com/vcmf/minmux/releases/tag/v0.1.35) - 2026-09-25

### Added

- Full-path tooltips and a right-click menu on folder lines ([#60](https://github.com/vcmf/minmux/pull/60))

## [0.1.34](https://github.com/vcmf/minmux/releases/tag/v0.1.34) - 2026-09-25

### Added

- Show where claude works (in) next to where it started (from) ([#59](https://github.com/vcmf/minmux/pull/59))

## [0.1.33](https://github.com/vcmf/minmux/releases/tag/v0.1.33) - 2026-09-25

### Added

- Show the claude code icon on terminals running claude ([#57](https://github.com/vcmf/minmux/pull/57))

## [0.1.32](https://github.com/vcmf/minmux/releases/tag/v0.1.32) - 2026-09-25

### Added

- Resume each pane's Claude Code session on relaunch ([#55](https://github.com/vcmf/minmux/pull/55))

## [0.1.30](https://github.com/vcmf/minmux/releases/tag/v0.1.30) - 2026-09-25

### Added

- Show each terminal's branch, GitHub PR and Claude's last reply ([#53](https://github.com/vcmf/minmux/pull/53))

## [0.1.29](https://github.com/vcmf/minmux/releases/tag/v0.1.29) - 2026-09-25

### Added

- Colour a pane's border with its Claude Code session colour ([#51](https://github.com/vcmf/minmux/pull/51))

## [0.1.28](https://github.com/vcmf/minmux/releases/tag/v0.1.28) - 2026-09-25

### Added

- Add a light variant for every theme with a new theme picker ([#50](https://github.com/vcmf/minmux/pull/50))

## [0.1.27](https://github.com/vcmf/minmux/releases/tag/v0.1.27) - 2026-09-24

### Added

- Drag terminal tabs between panes with drop-zone hints ([#48](https://github.com/vcmf/minmux/pull/48))
- Stack multiple terminals as tabs inside a pane ([#47](https://github.com/vcmf/minmux/pull/47))

## [0.1.26](https://github.com/vcmf/minmux/releases/tag/v0.1.26) - 2026-08-06

### Added

- App version + a quiet update ping ([#45](https://github.com/vcmf/minmux/pull/45))

## [0.1.25](https://github.com/vcmf/minmux/releases/tag/v0.1.25) - 2026-08-03

### Added

- Token badge shows ↑context ↓output (bounded, not a 22M cumulative total) ([#44](https://github.com/vcmf/minmux/pull/44))

## [0.1.24](https://github.com/vcmf/minmux/releases/tag/v0.1.24) - 2026-07-31

### Added

- Token usage per session and sub-agent ([#43](https://github.com/vcmf/minmux/pull/43))

## [0.1.23](https://github.com/vcmf/minmux/releases/tag/v0.1.23) - 2026-07-31

### Added

- Curved tree connectors + box the active pane's session ([#42](https://github.com/vcmf/minmux/pull/42))

## [0.1.22](https://github.com/vcmf/minmux/releases/tag/v0.1.22) - 2026-07-27

### Added

- Export COLORFGBG so agents detect the theme on WSL ([#41](https://github.com/vcmf/minmux/pull/41))

## [0.1.21](https://github.com/vcmf/minmux/releases/tag/v0.1.21) - 2026-07-24

### Faster

- Never decode the clipboard bitmap on paste ([#39](https://github.com/vcmf/minmux/pull/39))

## [0.1.20](https://github.com/vcmf/minmux/releases/tag/v0.1.20) - 2026-07-24

### Fixed

- Allow rerooting the files panel on WSL ([#38](https://github.com/vcmf/minmux/pull/38))

## [0.1.19](https://github.com/vcmf/minmux/releases/tag/v0.1.19) - 2026-07-24

### Added

- Preview files on WSL via the UNC share ([#37](https://github.com/vcmf/minmux/pull/37))

## [0.1.18](https://github.com/vcmf/minmux/releases/tag/v0.1.18) - 2026-07-24

### Added

- Ctrl+V paste on Windows + cheap clipboard image check ([#36](https://github.com/vcmf/minmux/pull/36))

## [0.1.17](https://github.com/vcmf/minmux/releases/tag/v0.1.17) - 2026-07-24

### Added

- File-drop hook transport (fixes WSL board + kills ECONNREFUSED) ([#34](https://github.com/vcmf/minmux/pull/34))
- List WSL folders via \\wsl.localhost UNC ([#33](https://github.com/vcmf/minmux/pull/33))

### Faster

- Skip the clipboard image probe on text paste ([#32](https://github.com/vcmf/minmux/pull/32))

## [0.1.16](https://github.com/vcmf/minmux/releases/tag/v0.1.16) - 2026-07-21

### Fixed

- Single-instance lock to stop ECONNREFUSED hook spam ([#31](https://github.com/vcmf/minmux/pull/31))

## [0.1.15](https://github.com/vcmf/minmux/releases/tag/v0.1.15) - 2026-07-21

### Added

- Drag-resize the right panel ([#30](https://github.com/vcmf/minmux/pull/30))

## [0.1.13](https://github.com/vcmf/minmux/releases/tag/v0.1.13) - 2026-07-20

### Added

- Open file links on a plain click ([#28](https://github.com/vcmf/minmux/pull/28))

## [0.1.12](https://github.com/vcmf/minmux/releases/tag/v0.1.12) - 2026-07-20

### Added

- Show each agent's folder + worktrees, open a terminal there ([#27](https://github.com/vcmf/minmux/pull/27))

## [0.1.11](https://github.com/vcmf/minmux/releases/tag/v0.1.11) - 2026-07-20

### Faster

- Snappier scrollback feel ([#26](https://github.com/vcmf/minmux/pull/26))

## [0.1.10](https://github.com/vcmf/minmux/releases/tag/v0.1.10) - 2026-07-16

### Added

- Navigable root folder with breadcrumb ([#25](https://github.com/vcmf/minmux/pull/25))

## [0.1.9](https://github.com/vcmf/minmux/releases/tag/v0.1.9) - 2026-07-16

### Added

- Syntax-highlighted file preview popup ([#24](https://github.com/vcmf/minmux/pull/24))
- Right-click menu — open in editor, reveal, copy path ([#21](https://github.com/vcmf/minmux/pull/21))

## [0.1.8](https://github.com/vcmf/minmux/releases/tag/v0.1.8) - 2026-07-16

### Added

- App icon, branding, and readme revamp ([#20](https://github.com/vcmf/minmux/pull/20))

## [0.1.7](https://github.com/vcmf/minmux/releases/tag/v0.1.7) - 2026-07-15

### Added

- Unified side panel — Files / Changes / Agents (one panel, one switcher) ([#19](https://github.com/vcmf/minmux/pull/19))

## [0.1.6](https://github.com/vcmf/minmux/releases/tag/v0.1.6) - 2026-07-15

### Fixed

- Cmd/Ctrl+V attaches clipboard images in Claude Code ([#18](https://github.com/vcmf/minmux/pull/18))

## [0.1.5](https://github.com/vcmf/minmux/releases/tag/v0.1.5) - 2026-07-15

### Fixed

- Share zsh history with all terminals (unpoison HISTFILE) ([#16](https://github.com/vcmf/minmux/pull/16))

## [0.1.4](https://github.com/vcmf/minmux/releases/tag/v0.1.4) - 2026-07-14

### Added

- M6 6b — live agents & worktrees board (hooks → tree → panel) ([#15](https://github.com/vcmf/minmux/pull/15))

## [0.1.3](https://github.com/vcmf/minmux/releases/tag/v0.1.3) - 2026-07-10

### Fixed

- Track active pane from terminal focus so split targets it ([#13](https://github.com/vcmf/minmux/pull/13))

## [0.1.2](https://github.com/vcmf/minmux/releases/tag/v0.1.2) - 2026-07-10

### Fixed

- WebGL on all panes — rebuild shared atlas to kill split garble ([#12](https://github.com/vcmf/minmux/pull/12))

## [0.1.1](https://github.com/vcmf/minmux/releases/tag/v0.1.1) - 2026-07-10

### Added

- Clickable file links (Cmd/Ctrl-click a path to open it in your editor) ([#5](https://github.com/vcmf/minmux/pull/5))
- Shift+Enter inserts a newline (multi-line input for agents) ([#7](https://github.com/vcmf/minmux/pull/7))

### Fixed

- Git panel works for WSL sessions (run git inside the distro) ([#4](https://github.com/vcmf/minmux/pull/4))
- Share zsh/bash history across panes (cmux-like) ([#2](https://github.com/vcmf/minmux/pull/2))

### Faster

- Repair WebGL glyph atlas/framebuffer on focus, DPR change, resize ([#3](https://github.com/vcmf/minmux/pull/3))
- Skip no-op PTY resizes (kills spurious SIGWINCH on split) ([#6](https://github.com/vcmf/minmux/pull/6))

## [0.1.0](https://github.com/vcmf/minmux/releases/tag/v0.1.0) - 2026-07-10

The first release: tabs and split panes over your own shells, a status and notifications per
session, the changes panel, layout restore, themes and the command palette. macOS, Linux and
Windows/WSL.
