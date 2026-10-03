# Design — Multi-agent support: Codex and OpenCode next to Claude Code

> Bring the Claude Code integrations minmux already has (agent tree, working dir, PR status
> following the agent, pane colour, tokens, resume) to **OpenAI Codex CLI** and **OpenCode**,
> behind an agent abstraction so a fourth agent is one adapter. Companion to
> `AGENT_OBSERVABILITY.md` (the M6 design this generalises) and `../ARCHITECTURE.md`.
> Implementation steps: `MULTI_AGENT_IMPLEMENTATION.md`.

Status: **DESIGN / accepted** (2026-10-01). Milestone: ROADMAP M6 → **6d**.

**How to read this doc.** It records decisions, constraints and verified facts. It does not
specify code: shell syntax, file layouts, regexes and similar mechanics are settled in the
implementation PRs, under their tests and reviews. Where this doc names a mechanism, treat it
as the intended direction, not a spec. Legend for facts about an agent: ✅ verified on a dev
machine (spikes, §9) · 📄 vendor docs (2026-09) · ❓ still to verify.

---

## 1. Goal, scope, non-goals

**Goal.** A user who runs `codex` or `opencode` in a minmux pane gets the same agent-aware
features as a `claude` user: on by default, zero setup, without minmux writing their global
config. Where an agent can't provide the data, the feature is simply not shown.

**In scope.** Codex CLI (the `codex` TUI), OpenCode (the `opencode` TUI), local and WSL panes,
the generic abstraction in main and renderer.

**Non-goals.** Agents in SSH panes (their hooks run on the host; unchanged). Driving agents
(minmux observes, as in M6). Codex IDE / app-server sessions and `opencode serve`/`web`.
Agents that run as a shared daemon with no per-pane process (e.g. OpenClaw): they need a
different way to match sessions to panes.

---

## 2. What each agent offers

| Capability       | Claude Code (today)                             | Codex CLI (0.159.2)                                                                    | OpenCode (1.18.34)                                                        |
| ---------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Event source     | hooks via `claude --settings <file>`            | **hooks with Claude's contract** (names, fields, `async`, `timeout`) via `codex -c` ✅ | **JS plugin**: bus events + `tool.execute.before/after` ✅                |
| Scoping          | shell wrapper adds `--settings`                 | `-c hooks.<Event>` is its own config layer, **additive** to the user's hooks ✅        | env `OPENCODE_CONFIG_CONTENT`; plugin list **merges** with the user's ✅  |
| Friction         | none                                            | **one-time hook approval** (`/hooks`), keyed by definition hash, no folder ✅          | none (`--pure` disables plugins: user's choice)                           |
| Lifecycle        | SessionStart / SessionEnd                       | SessionStart (`startup`…) / SessionEnd (`other`) ✅                                    | `session.created`, busy/idle status; **nothing on quit** ✅               |
| Turn / needs-you | UserPromptSubmit / Stop / Notification          | UserPromptSubmit / Stop / Interrupt / **PermissionRequest** ✅                         | `session.status` busy↔idle, `session.idle`, `permission.asked/replied` ✅ |
| Tools            | Pre/PostToolUse                                 | Pre/PostToolUse (`Bash`, `apply_patch`, `collaborationspawn_agent`, …) ✅              | `tool.execute.before/after` (`tool`, `sessionID`, args) ✅                |
| Sub-agents       | SubagentStart/Stop; `agent_id` on its events    | same, incl. `agent_id` on a sub-agent's tool events ✅                                 | child sessions with `parentID`; two levels by default ✅                  |
| cwd              | every event + CwdChanged                        | every event ✅                                                                         | `Session.directory` ✅                                                    |
| Files            | tool `file_path`, FileChanged                   | tool input (`apply_patch` patch headers) ✅                                            | tool args (`file.edited` has no session) ✅                               |
| Worktrees        | WorktreeCreate / Remove                         | —                                                                                      | —                                                                         |
| Tokens           | transcript `message.usage`                      | rollout `token_count`, incl. the model's context window ✅                             | `message.updated` tokens + cost ✅                                        |
| Name / colour    | transcript `/rename`, `/color`                  | `thread_name` in `session_index.jsonl`, **automatic** ✅; no colour                    | session title, **automatic**, then `/rename` ✅; no colour                |
| Process identity | —                                               | hook's parent pid = the Codex process ✅                                               | `process.pid` in the plugin ✅                                            |
| Resume           | `claude --resume <uuid>` from the session's dir | `codex resume <id>` ✅ (from another folder ❓ S1-f)                                   | `opencode --session <id>` ✅                                              |

**Key finding.** Codex adopted Claude's hook contract, so the Claude pipeline carries over
almost unchanged. OpenCode is different but the richest: we write the plugin, so we choose
exactly what leaves the agent process.

---

## 3. Where the code is Claude-bound today

| Layer       | Claude-specific                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Arming      | the `claude()` wrapper in the zsh/bash rc tail; `MINMUX_CLAUDE_SETTINGS`; `buildHookSettings`                                                                            |
| Normalise   | `normalizeHookEvent` reads Claude's field names                                                                                                                          |
| Main fold   | `SessionLedger`: UUID ids, `claude --resume`, Claude's project-dir check, permission modes                                                                               |
| Transcripts | token and `/color`/`/rename` readers parse Claude's JSONL; the meta tracker watches one transcript per pane                                                              |
| Graph       | (done in PR #1: agent kind on events/nodes, explicit parents)                                                                                                            |
| Renderer    | `ClaudeIcon`, `claudeWorkDirs`, the `/.claude/worktrees/` check, `CLAUDE_COLORS`, `claude*` calls in terminal-manager and store, close-confirm and resume-banner strings |

Already generic: the drop-file transport, `TranscriptFold`, branch + PR lookup, the git poll
planner, session status and notifications, the resume flow and banner state machine.

---

## 4. Core decisions

### 4.1 One event vocabulary: Claude's hook names

Claude's hook names are the canonical events (Codex uses them already), plus
`PermissionRequest` and the synthetic `TokenUsage`. Each adapter maps its agent onto them;
the reducer only sees canonical events. Events and nodes carry the agent kind; a sub-agent
can name its parent, so trees can go deeper than two levels. **Done in PR #1.**

| Canonical          | Codex                  | OpenCode (plugin projection)                           |
| ------------------ | ---------------------- | ------------------------------------------------------ |
| SessionStart       | SessionStart           | first event of a root session in this process          |
| SessionEnd         | SessionEnd             | `session.deleted`; otherwise the process ending (§F14) |
| UserPromptSubmit   | UserPromptSubmit       | root goes busy                                         |
| Stop               | Stop, Interrupt        | root goes idle                                         |
| Notification       | —                      | `question.asked`                                       |
| PermissionRequest  | PermissionRequest      | `permission.asked`                                     |
| Pre/PostToolUse    | Pre/PostToolUse        | `tool.execute.before/after`                            |
| SubagentStart/Stop | SubagentStart/Stop     | child session created / goes idle                      |
| CwdChanged         | when `cwd` changes     | —                                                      |
| TokenUsage         | main, from the rollout | the plugin, from `message.updated`                     |

### 4.2 One adapter per agent, in main

Each agent is an adapter in `electron/agents/<kind>.ts`. It owns how a pane arms the agent,
how raw drops become canonical events, where tokens and names come from, and the rules for
leading a pane and resuming. Nothing agent-specific lives outside the adapters and
`src/lib/agent-kinds.ts` (labels, icons, commands). This becomes a CLAUDE.md invariant.

### 4.3 Transport: per-agent folders, drop root in the env

- One per-launch drop root, one subfolder per agent; the folder says which agent wrote a drop.
- The drop root travels in an env var (`MINMUX_AGENT_EVENTS`), **not** in hook definitions:
  Codex trusts a hook by its definition's hash, so a definition must be byte-stable across
  launches and panes. The per-launch secret stays env-only.
- A hook definition must run as-is wherever the agent runs. If it embeds a path, WSL panes
  get their own definition (as today's `claude-hooks.wsl.json`). Any path a process inside WSL
  reads is the translated form of the Windows path, never hand-built.

### 4.4 Which session owns a pane (lead vs nested)

The ledger in main stays the one classifier. Rules per agent:

- **Claude:** today's rule (a new session while a lead is live is a background agent, unless
  it's `/clear` or a fork).
- **Codex and OpenCode: by process.** Both tell us their process (§2). The first agent process
  seen in a pane leads it; within that process any new session or thread is a **switch**
  (`/new`, picking another session), and the most recently active root session leads. A
  session from another process in the same pane is nested.
- **A lead ends** on SessionEnd, on the shell prompt returning, or when its process is gone
  (checked off the hot path). The process check matters because OpenCode fires nothing on quit
  and shells without our integration (fish, pwsh) send no prompt mark. It isn't possible for
  WSL panes from Windows; there the prompt mark is the only signal.

### 4.5 Resume files stay safe across versions

Claude entries stay in `agent-sessions.json`, unchanged. Codex and OpenCode entries live in
their own files, which older builds never read or rewrite: a downgrade neither types
`claude --resume <codex-id>` nor deletes other agents' entries. When files disagree about a
pane (a crash between writes, a downgrade), the **newest entry wins**.

---

## 5. Features

Per feature: what exists, whether the abstraction is there, and the plan per agent.

### F1. Arming, on by default

**Today.** main sets the Claude settings path and the pane id; the rc tail defines `claude()`.
**Abstraction:** missing. **Plan:** each adapter declares its arming; per-agent switch in
Settings (default on); every new env var joins the parent-instance scrub list.

- **Codex.** A `codex()` wrapper in the rc tail adds our `-c hooks.<Event>` overrides.
  Constraints: arguments reach Codex **intact** (quotes, spaces in paths: tested); only
  interactive shells define it, so a `codex exec` launched by another agent is never armed.
  The wrapper also emits a display-only **launch marker** (drives the approval hint, F18),
  written **only to the terminal**, never into stdout, pipes or `$(…)`.
- **OpenCode.** No wrapper needed: `OPENCODE_CONFIG_CONTENT` adds our plugin, built as a proper
  `file:` URL. Constraint: **a user's own `OPENCODE_CONFIG_CONTENT` is preserved**, even if
  their rc exports it after minmux set the env; so for zsh/bash the merge happens in our rc
  tail, after the user's rc. Other shells get the env from main (their rc can still override
  it: documented limit).

### F2. Event transport

**Abstraction:** present (claim-by-rename watcher, sweep, size cap, coalescing). **Plan:**
per-agent folders and the env-carried root (§4.3).

- **Codex.** Same writer as Claude. Hooks are async with a short timeout. Codex forces
  SessionEnd to run synchronously (≤ 3 s), so the writer must start and finish fast; no hook
  may block an interactive key (Interrupt stays async). Settings that make `/hooks` list
  "Issues" are avoided.
- **OpenCode.** The plugin writes its own drops, asynchronously and never awaited. It writes a
  **projection**: ids, status, tool names, paths, tokens, title, a bounded last reply. No
  prompt, file or tool content leaves the agent.

### F3. Normalisation

**Abstraction:** missing. **Plan:** one normaliser per adapter, best-effort, never throws.

- **Codex.** Claude's normaliser plus: Interrupt → Stop, PermissionRequest, file paths from
  `apply_patch`, CwdChanged when the cwd changes.
- **OpenCode.** Validates the plugin's projection (versioned). Child sessions become
  sub-agents of their root; every root event carries the session directory, so a session
  first seen mid-life (resumed, picked in `/sessions`) still gets a ledger entry.

### F4. Agent tree board

**Abstraction:** present after PR #1. **Plan:** icon per root, recursive children (capped
depth), empty state names all three agents.

- **Codex.** Two levels; sub-agent tools attribute to the sub-agent ✅.
- **OpenCode.** Two levels by default ✅, deeper with custom agents; the child's type is in its
  title (`"… (@general subagent)"`).

### F5. Presence, exit, close confirm

**Today.** `claudePaneIds` drives the icon, close confirm and accent; a returning prompt means
the agent exited. **Plan:** kind-aware presence (`agentPanes`, PR #1), icon and close text per
kind.

- **Codex.** SessionEnd + prompt return. **OpenCode.** Prompt return + process check (§4.4).

### F6. Agent status

**Abstraction:** present. PermissionRequest → waiting (PR #1). A waiting agent stays waiting
until the next tool starts, the turn ends or a new prompt arrives.

- **OpenCode.** busy/idle from `session.status` (reported on change only); permission asked →
  waiting, replied → working.
- **Not in this work:** hook-driven pane badges (fixes ARCHITECTURE §9a for all agents) need
  the activity-based status rewrite with its test matrix.

### F7. Working dir (`from` / `in`) and panels following the agent

**Abstraction:** present in logic; Claude in names and the worktree-layout check. **Plan:**
agent-neutral names; worktree layouts per agent kind.

- **Codex.** `cwd` on every event. **OpenCode.** the session directory.

### F8. Worktrees

Claude only (no worktree events elsewhere). `in` + PR still show a linked worktree's branch
for any agent.

### F9. Branch + PR status

Generic. All agents get it once F7 is generic.

### F10. Current tool + recent files

**Abstraction:** present via normalisers. Codex: `apply_patch` paths; OpenCode: tool args.
Tool names shown as each agent reports them.

### F11. Tokens

**Abstraction:** half (fold engine generic, parsers Claude's). **Plan:** token source per
adapter; the badge can show context fill when the window is known.

- **Codex.** From the rollout (`transcript_path`): latest context, cumulative output, model
  context window ✅. **OpenCode.** Accumulated in the plugin per session (deduped per message);
  each child reports for its own node.

### F12. Session name + colour

**Abstraction:** half (`sessionColor` generic, source Claude's). **Plan:** a name source per
adapter (watched file, shared index, or pushed by the plugin). **D3:** show the name always;
colour only from a name the user set.

- **Codex.** `thread_name` from the shared index file (one watcher for all panes; Codex home
  derived from `transcript_path`). Names are automatic, so **no colour until S1-g** shows how
  to tell a user rename.
- **OpenCode.** Title changes go default → automatic → user. main decides "user-named" from
  the order (a change before any prompt is the user's) and **persists** it with the session,
  so it survives a resume. Limit: a rename made outside minmux comes back uncoloured.

### F13. Last reply snippet

Codex: Stop's `last_assistant_message`. OpenCode: the plugin's bounded last reply. Shown,
never logged.

### F14. Lead vs nested

See §4.4.

### F15. Resume

**Abstraction:** half (flow and banner generic; id check, command, folder check and confirm
signal Claude's). **Plan:** resume rules per adapter; labels and picker command per kind;
files per §4.5.

- **Codex.** `codex resume <id>`, after `cd` to the recorded folder. Permission mode not
  restored in v1. Confirm: the same session id starting again. ❓ S1-f before PR #7.
- **OpenCode.** `MINMUX_RESUME_SESSION=<id> opencode --session <id>` (ids `ses_` + 26
  characters ✅), after `cd` to the session directory. Reopening emits no session event, so the
  plugin asks OpenCode itself at startup (`client.session.get`) and starts the session at once
  when it exists: an ordinary SessionStart confirms the resume, like Claude's (in a shell
  without `K=V` prefixes the id isn't passed, and the first prompt confirms it). The env carries
  the id because the TUI's plugin worker doesn't see `--session` in its argv (PR #11 spike). A
  bad id: the lookup finds nothing and OpenCode exits 1 ✅ ("Session not found"). Its picker is
  `/sessions` in the TUI, so the banner offers "Open OpenCode (/sessions)".

### F16. Attention + notifications

Generic (OSC 9 / bell). Codex's own `tui.notifications` already reaches it when the user
enables it; we don't force it. ❓ OpenCode's bell behaviour (S3).

### F17. Terminal ergonomics

Generic (Shift+Enter, image paste, light/dark, mouse reset, click-to-open). ❓ S3 checks them
in both TUIs; fixes only if something is off.

### F18. Settings and the Codex approval hint

- Settings: per-agent switch (default on). `resumeBypassPermissions` is labelled Claude-only.
- **Approval hint.** When Codex was launched in a pane (launch marker) but no hook event came
  within a few seconds, a one-line hint appears above the terminal:

  > **Approve minmux in Codex to see every running agent live on the Agents board:** status,
  > sub-agents, tokens, and resume after restart. One-time: type **`/hooks`** in Codex, then
  > press **t**. [**Show me**] [Not now]

  minmux **never types into Codex** for this: Codex may be on its own trust screens or
  mid-turn. **Show me** focuses the pane and copies `/hooks`. Repeated dismissals offer
  "Don't ask again". The hint is tied to the **hook definition** that was approved: a new
  definition (a minmux update, a first WSL pane) can bring it back.

---

## 6. Performance & safety

- Nothing touches the PTY → renderer path; all agent work is in main on the hook channel,
  async and coalesced.
- Hooks never block an agent's loop or an interactive key beyond what the agent itself forces
  (Codex's SessionEnd).
- The OpenCode plugin runs inside the agent: it filters first and never awaits I/O
  (S2: median handler cost 0.001 ms).
- Content: OpenCode drops are projected; Codex/Claude drops are deleted after reading and
  never logged.
- The drop root is per-launch and env-only; hook definitions hold no secret.

## 7. Risks

| Risk                                                        | Mitigation                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| Agent formats change (Codex calls its rollout "not stable") | parse best-effort, never throw; versioned fixtures                        |
| Users confused by Codex's approval prompt                   | the approval hint (F18); docs                                             |
| Arming disturbs a user's own config                         | additive layers only (S1-a, S2-a); user's own values merged, not replaced |
| The plugin slows OpenCode                                   | filter-first, no awaited I/O; perf check per PR                           |
| Renames break store invariants                              | the refactor PRs keep behaviour; the test suite is the gate               |
| Downgrades lose or misuse resume entries                    | per-agent files, newest entry wins (§4.5)                                 |
| A quit agent keeps leading a pane                           | process check (§4.4)                                                      |

## 8. Decisions (settled 2026-10-01)

- **D1 — Codex: one-time `/hooks` approval**, plus the hint (F18). Never the bypass flag (it
  would also skip review of repo-provided hooks).
- **D2 — On by default** for every agent, scoped to minmux panes, with a per-agent switch.
- **D3 — Colour only from names the user set**; names always shown.

## 9. Spike results

### S1 — Codex hooks (2026-09-30, Codex CLI 0.159.2, sandboxed `CODEX_HOME`)

Fixtures: `src/test/fixtures/agents/codex-exec.jsonl` (17 events: Bash, `apply_patch`, one
sub-agent) and `codex-tui.jsonl` (16: approval, Esc interrupt, stand-in user hooks).

- ✅ **Additive scoping (S1-a).** `-c hooks.<Event>` is its own source
  (`/<session-flags>/config.toml`); the user's `hooks.json` and `[hooks]` fired next to ours.
- ✅ **Env reaches the hook (S1-b)**; the hook's parent pid is the Codex process.
- ✅ **Trust (S1-c).** Untrusted hooks are skipped (the UI shows "Hooks need review",
  `codex exec` is silent). Approval is stored in `$CODEX_HOME/config.toml` under
  `hooks.state`, keyed by source + event + position + definition hash, with **no folder**.
  Separate from Codex's per-folder "Trust this folder?" screen.
- ✅ **Payloads (S1-d).** Common: `session_id`, `transcript_path` (the rollout), `cwd`,
  `hook_event_name`, `model`, `permission_mode`; turn events add `turn_id`. PermissionRequest
  has `tool_input.description`. Stop has `last_assistant_message`. Sub-agent events carry
  `agent_id`/`agent_type`; SubagentStop adds `agent_transcript_path`.
- ⚠️ Stop doesn't fire under `codex exec` (it does in the TUI). A SessionEnd can arrive for a
  session that never sent SessionStart. `plugin_hooks` is removed (no plugin-bundled hooks).
  SessionEnd is run synchronously and clamped to 3 s; Interrupt is clamped to 3 s.
- Thread names are automatic; Codex prints `codex resume <id>` on exit.
- ❓ Open: S1-e (quoting on native Windows / WSL), S1-f (`codex resume` from another folder),
  S1-g (telling a user rename from an automatic name). They block PR #7 and the Windows part
  of PR #5.

### S2 — OpenCode plugin (2026-10-01, OpenCode 1.18.34, sandboxed XDG dirs)

Fixtures: `opencode-run.jsonl` (bash, read, edit, a `task` sub-agent) and `opencode-tui.jsonl`
(permission, `/rename`, `/new`, `/sessions`, quit, `--session`). These are the **spike
plugin's raw log of bus events**, for designing the projection; PR #8 regenerates fixtures
through the real plugin.

- ✅ **Loading (S2-a).** The inline config loads our plugin and keeps the user's plugins; the
  plugin sees `MINMUX_PANE_ID`; `process.pid` is stable per instance.
- ✅ **Lifecycle (S2-b).** Root `session.created` → repeated busy (dedupe) → idle +
  `session.idle`. Children: `parentID`, typed title. Tools with `sessionID` and args.
  Permission asked/replied. Tokens and cost on completed assistant messages.
- ✅ **Sessions.** `/new` = a new root in the same process; `/sessions` emits nothing until the
  next prompt; quit emits nothing (S2-c); `--session` emits only the plugin starting (S2-d).
- ✅ **Titles (S2-f).** default → automatic → `/rename`; no flag marks a user title.
- ✅ **Cost (S2-e).** 308 handler calls: median 0.001 ms, max 0.32 ms.
- ⚠️ `file.edited` has no `sessionID`; scripted `opencode run` must close stdin; free models
  need OpenCode ≥ 1.18.0.

## 10. Out of scope

SSH-pane agents; OTEL for any agent; driving agents; Codex IDE/app-server sessions; per-agent
file authorship beyond "recent files"; cost display (OpenCode has it; easy follow-up).
