# Show HN prep (throwaway)

Working notes for the Show HN launch. Delete this file after the launch. Facts were checked
against `main` on 2026-10-20 (v0.1.58); re-check anything marked _verify_ on the day.

## Before posting

- [ ] ROADMAP no longer says v0 is in progress (#172)
- [ ] A 15 to 30 s GIF or video at the top of the README: an agent goes to "needs input", the
      notification fires, a click jumps to the pane, the Changes panel shows the diff
- [ ] README Install says Apple Silicon only, next to the curl line (today it is only under "What
      is still rough")
- [ ] Fresh install from the README on a clean mac and a clean Linux box, as a new user would
- [ ] Re-check competitor facts below (`docs/COMPETITIVE_LANDSCAPE.md` is from 2026-09-29)
- [ ] Post Tue to Thu, about 8 to 10am US Pacific, with 3 to 4 free hours after it

## Title

```
Show HN: minmux – a cross-platform terminal for Claude Code, Codex and OpenCode
```

Fallback, if you'd rather not name the agents:
`Show HN: minmux – a cross-platform terminal for running coding agents`

Link: https://github.com/vcmf/minmux (HN tends to prefer the repo for open source; the
README links minmux.dev).

## First comment (draft, rewrite in your own words)

> Hi HN, I built minmux because I run Claude Code (and lately Codex and OpenCode) all day in a
> terminal, and I kept losing track of which session was waiting on me and what each one had
> actually changed. I also like reading the code an agent writes and editing it myself, so I
> didn't want an IDE or an app that runs the agents for me.
>
> minmux is a regular terminal: tabs, split panes, your own shell and rc files, ssh. You start
> `claude`, `codex` or `opencode` in a pane the way you always do. minmux listens through each
> agent's own hooks (a small plugin for OpenCode), only in the panes it opens, and shows:
>
> - which session is working, waiting for input, or done, with a native notification when a
>   background pane needs you
> - each session's sub-agents, token count, and the processes it started (dev server, test
>   watcher)
> - a live git diff and a file browser for the pane's folder
> - past sessions you can search and resume; quit with an agent running and it comes back in the
>   same pane after a relaunch
> - your pull requests with reviews and CI, through your own `gh`
>
> No account, no telemetry. The only request it makes on its own is a check for a newer release
> on GitHub. MIT licensed.
>
> It's Electron + xterm.js (WebGL) + node-pty. I started on Tauri and moved because WKWebView kept
> breaking glyph rendering; Chromium gives one engine on every OS. Idle CPU is ~0 and agent tracking
> runs off the keystroke/output path. Numbers are in docs/PERF.md.
>
> What's rough: macOS builds are Apple Silicon only and not notarized yet, Windows/WSL has had much
> less use than mac/Linux (and Codex/OpenCode aren't wired there yet), and the working/idle status is
> partly a heuristic so it's sometimes wrong.
>
> I'd love feedback on what you'd want from a terminal like this, and bug reports from anyone on
> Linux or Windows.

## Likely questions, with answers

Keep answers short, factual, and without dashes as connectors. Admit gaps quickly; HN rewards it.

### "Why Electron? A terminal should be native."

The one you'll certainly get, probably as the first comment.

- Started on Tauri (M0 to M3a). WKWebView on macOS kept garbling glyphs (Nerd icons, box
  drawing), and each OS webview behaves differently. Electron gives one Chromium everywhere and
  xterm's WebGL renderer, the same stack as VS Code's terminal. (ARCHITECTURE §3.5)
- Cost, stated plainly: ~150 MB download; memory was ~140 MB main + ~250 MB renderer + ~80 MB GPU
  in the July baseline (docs/PERF.md). _Verify_ with a current build and a few panes before quoting.
- What we did about speed: PTY output is coalesced (4 ms / 256 KB) before IPC, ~165× fewer
  messages and ~1.6× throughput; idle CPU measured at 0%; every agent integration is off the
  PTY → xterm path.
- Don't argue. "Fair, it's a trade-off I made on purpose. If memory matters more to you than the
  panels, Ghostty/WezTerm + tmux is a great setup."

### "How is this different from cmux / Conductor / Claude Squad / dmux / Vibe Kanban?"

Lead with the shape, not features:

- minmux doesn't launch or orchestrate agents. You run them yourself in a normal shell; minmux
  watches and shows state. Claude Squad, dmux, ccmanager and Conductor create worktrees and start
  agents for you.
- Cross-platform (macOS, Linux, Windows/WSL). cmux and Conductor are macOS only (_verify_).
- MIT. cmux is GPL/AGPL (_verify_); Conductor is closed source.
- It's a full terminal (ssh, splits, your rc files), so it can be the only one you open.
- Be generous: "cmux is great if you're on macOS and want Ghostty's renderer."

### "Why not tmux + a notification hook?"

Totally valid for many people. minmux adds the things that are hard in tmux: sub-agents and token
counts per session, a live diff + file browser for the pane's folder, search and resume across past
sessions, PRs with CI. It doesn't replace tmux's detach/attach (yet: RFC #46 is a daemon for that).

### "You say no wrapper, but how do you hook into Claude without touching my config?"

Be precise here; someone will read the code.

- In panes minmux opens, the zsh/bash integration defines a `claude` shell function that runs
  `command claude --settings <minmux's hook file>`. Claude merges that with your own settings, so
  `~/.claude` is never edited. A `claude` started in any other terminal is untouched.
- Codex: `-c` overrides the same way, plus Codex asks you once to approve the hooks (`/hooks`),
  and Codex records that approval in its own config.
- OpenCode: a small plugin merged into `OPENCODE_CONFIG_CONTENT` for that pane only.
- Hooks write each event as a small file into a folder minmux watches. No HTTP server, no open port.
- So "no wrapper CLI" means you don't learn a new command; there is a shell function in minmux's
  panes. Say that if asked.

### "Telemetry? What does it send?"

None. One unauthenticated request to the GitHub releases API to check for an update. PR features
run your own `gh`. There's a small local lifecycle log (`electron/diagnostics.ts`, app start/quit,
power events, PTY spawn/exit) that never leaves the machine; it's on the list to gate behind a flag.

### "curl | sh? And the app isn't signed?"

- The scripts are short; read them first (`install.sh`, `install.ps1`). They download the release
  asset from GitHub and copy it into place, nothing else.
- macOS build is ad-hoc signed (needed for Apple Silicon to run), not notarized. Notarization needs
  the $99/yr Apple account; planned for v0.1. Files fetched by curl aren't quarantined, which is why
  the script route avoids the Gatekeeper prompt. Downloading the .dmg in a browser shows it.
- Windows `.exe` is unsigned today; SignPath (free for OSS) is the plan.
- Building from source is `make install && make dist`.

### "Intel Mac? Linux arm64? Homebrew? AUR/Nix?"

Not yet. Releases are mac arm64, Windows x64, Linux x64 AppImage. Intel/universal mac and a
Homebrew tap are on the v0.1 list. Packaging PRs for other channels are welcome.

### "Does it work with Gemini CLI / Aider / Amp / Cursor agent / Copilot CLI?"

As a terminal, yes, any CLI runs. The agents panel, status from hooks, tokens and resume need an
adapter per agent (`electron/agents/`); Claude Code, Codex and OpenCode have one. Each adapter is
one file plus a normaliser to a neutral event type, so adding one is contained. Ask which one
they'd want first.

### "Does it handle git worktrees / parallel agents on one repo?"

It shows the worktrees an agent creates (Claude's `WorktreeCreate`/`Remove` hooks) and lets you open
a terminal in one. It doesn't create worktrees or split work for you; that's a deliberate line
(you steer every agent).

### "How reliable is 'needs input'?"

For Claude, Codex and OpenCode it comes from their hooks (permission prompts, idle notifications,
stop), so it's good. For anything else it's partly an output-idle heuristic and can be wrong.
There's a known flaw in the shell-status reducer documented in ARCHITECTURE §9a; the rewrite is
planned with a proper test matrix.

### "What happens to my processes when I quit?"

Quit is guarded with a confirm when terminals are running. On relaunch the layout comes back and
Claude/Codex/OpenCode sessions resume in the same pane and folder. Other processes (dev server,
build) don't survive a full quit yet; a reload of the window keeps everything. A detached daemon
is designed (RFC #46) but not built.

### "Remote agents over SSH?"

SSH panes are first-class (hosts from `~/.ssh/config`, splits stay on the host, auto-reconnect),
with optional remote shell integration per host. The agents panel tracks agents in local panes;
_verify_ what works for an agent running on the remote before answering in detail.

### "Why not a VS Code extension?"

Some people don't live in an editor, and VS Code's own agent sessions only see agents started
through it. minmux wants to be the terminal itself, with the shell you already use.

### "Is this vibe-coded / built with AI?"

Likely to come up (lots of commits in a short time, an agent-focused product). Answer it straight,
in your own words: how you used agents, what you review yourself, that the repo has ~2,200 tests,
lint gates, and design docs. Don't dodge it; dodging is what gets punished.

### "The name looks like cmux / tmux."

"min" for minimal, "mux" because it multiplexes terminals and agents. Fine to say you know cmux
and the two are different projects.

### "Business model? Will it stay free?"

MIT, no account, nothing to sell today. Say what's true for you.

### "GitHub Enterprise / GitLab?"

The PR dialog uses `gh` against github.com only for now. GHE is a reasonable next step; GitLab
would be a separate provider.

## During the thread

- Reply to every top-level comment in the first two hours, briefly.
- Thank people for bug reports and open issues for them right away; link the issue in the reply.
- Never ask anyone to upvote. Don't post the link in group chats asking for votes.
- If it sinks with little discussion, a repost later is allowed by the Show HN rules.
