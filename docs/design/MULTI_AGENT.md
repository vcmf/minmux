# Design — Multi-agent support: Codex and OpenCode next to Claude Code

> Bring the Claude Code integrations minmux already has (agent tree, working dir, PR status
> following the agent, pane colour, tokens, resume, …) to **OpenAI Codex CLI** and
> **OpenCode**, and put a real agent abstraction under them so a fourth agent is one adapter.
> Companion to `AGENT_OBSERVABILITY.md` (the M6 design this generalises) and
> `../ARCHITECTURE.md`. Implementation steps: `MULTI_AGENT_IMPLEMENTATION.md`.

Status: **DESIGN / proposed** (2026-09-30). Milestone: ROADMAP M6 → **6d** (cross-agent
generalisation). ROADMAP 6d said to defer the abstraction until a second agent lands; this
doc adds two at once, so the abstraction is now due.

Legend for every fact about an agent: ✅ verified on a dev machine (installed binary or files
on disk) · 📄 from the vendor's docs (2026-09) · ❓ needs a spike (`MULTI_AGENT_IMPLEMENTATION.md`
Phase 0) before we build on it.

---

## 1. Goal, scope, non-goals

**Goal.** A user who runs `codex` or `opencode` in a minmux pane gets the same agent-aware
features as a `claude` user, with no setup and without minmux touching their global config.
Where an agent can't provide the data, the feature degrades to "not shown", never to an
error.

**In scope.** Codex CLI (the Rust TUI, `codex`), OpenCode (`opencode` TUI), local panes and
WSL panes. The generic abstraction in main and renderer.

**Non-goals.**

- Agents in **SSH panes**: their hooks would run on the host, and there's no path back for
  the drop files. `spawnRemote` already sets no agent env (main.ts, "no claude hook env").
  Unchanged.
- Driving agents (sending prompts, approving tools). minmux observes, as in M6 §9.
- Codex **IDE / app-server** sessions and `opencode serve` / `web`: only the TUIs a user
  types in a pane.
- A generic "any CLI" adapter. Gemini CLI, Aider, … are future adapters on the same seam.

---

## 2. The three agents' extension points (researched 2026-09-30)

| Capability             | Claude Code (today)                                            | Codex CLI                                                                                                                                                                                                                | OpenCode (1.18.34 ✅)                                                                                     |
| ---------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Event source           | hooks (`--settings` file), `command` type                      | **hooks**, same names and fields as Claude 📄; `command` is a **string** (no args) 📄                                                                                                                                    | **JS plugin**: `event` hook for bus events + `tool.execute.before/after` ✅ (`@opencode-ai/plugin` types) |
| Scoping to our panes   | shell wrapper → `claude --settings <file>`                     | shell wrapper → `codex -c <hooks override>`; **additive** to the user's hooks ✅ (S1-a)                                                                                                                                  | env **`OPENCODE_CONFIG_CONTENT`** (inline config); plugin list **merges** with the user's ✅ (S2-a)       |
| Friction               | none                                                           | ⚠️ **hook trust**: an unreviewed hook is **skipped** with a startup warning to open `/hooks` 📄; trust is keyed on the hook definition's hash 📄                                                                         | `--pure` disables external plugins ✅ (user's choice → no board)                                          |
| Session lifecycle      | SessionStart(source) / SessionEnd(reason)                      | SessionStart(`startup│resume│clear│compact`) / SessionEnd(`other`) 📄                                                                                                                                                    | `session.created/updated/deleted`, `session.status`, `session.idle`, `server.instance.disposed` ✅        |
| Turn                   | UserPromptSubmit / Stop                                        | UserPromptSubmit / Stop (+`last_assistant_message`) / **Interrupt** 📄                                                                                                                                                   | `session.status` busy↔idle, `session.idle` ✅                                                             |
| Needs input            | Notification                                                   | **PermissionRequest** 📄                                                                                                                                                                                                 | `permission.asked` / `permission.replied`, `question.asked` ✅                                            |
| Tools                  | Pre/PostToolUse (`tool_name`, `tool_input`)                    | Pre/PostToolUse; `Bash`, `apply_patch` (patch text in `tool_input.command`), `mcp__…`, `collaborationspawn_agent` / `collaborationwait_agent` ✅                                                                         | `tool.execute.before/after` (`tool`, `sessionID`, `callID`, args) ✅                                      |
| Sub-agents             | SubagentStart/Stop + `agent_id` on every sub-agent event       | SubagentStart/Stop (`agent_id`, `agent_type`, `agent_transcript_path`) ✅; sub-agent **tool** events carry the parent `session_id` **and** the sub-agent's `agent_id` ✅ (the docs say otherwise) → same model as Claude | child **sessions** with `parentID` ✅ → real multi-level tree                                             |
| cwd                    | on every event + CwdChanged                                    | on every event, no CwdChanged 📄                                                                                                                                                                                         | `Session.directory`, `AssistantMessage.path.cwd` ✅                                                       |
| Files                  | tool `file_path` + FileChanged                                 | tool input (`apply_patch` patch headers, `Edit`/`Write` path) 📄                                                                                                                                                         | `file.edited` ✅                                                                                          |
| Worktrees              | WorktreeCreate / WorktreeRemove                                | — (no hook)                                                                                                                                                                                                              | — (`OPENCODE_EXPERIMENTAL_WORKSPACES` exists ✅, not in scope)                                            |
| Tokens                 | transcript JSONL `message.usage`                               | rollout JSONL `event_msg/token_count`: `last_token_usage`, `total_token_usage`, **`model_context_window`** ✅                                                                                                            | inline on `message.updated` (`tokens.input/output/reasoning/cache.read/write`, `cost`) ✅                 |
| Name / colour          | transcript `custom-title` / `agent-color`                      | `thread_name` in `~/.codex/session_index.jsonl` (`id, thread_name, updated_at`) ✅; no colour command                                                                                                                    | `Session.title` (auto-generated) ✅; no colour command                                                    |
| Transcript             | `~/.claude/projects/<cwd-encoded>/<id>.jsonl`                  | `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` ✅, = hook `transcript_path` 📄 (format "not stable")                                                                                                           | SQLite `~/.local/share/opencode/opencode.db` ✅ (we don't read it; the plugin gives us everything)        |
| Resume                 | `claude --resume <uuid>` (only from the session's project dir) | `codex resume <id>` (UUIDv7 ✅, looked up globally)                                                                                                                                                                      | `opencode --session <id>` ✅ (`--continue`, `--fork` also exist)                                          |
| Terminal notifications | bell                                                           | `tui.notifications` + `tui.notification_method = osc9│bel│auto`, only while unfocused 📄                                                                                                                                 | ❓                                                                                                        |
| Terminal title         | OSC 0/2 (task)                                                 | ❓                                                                                                                                                                                                                       | sets it (`OPENCODE_DISABLE_TERMINAL_TITLE` exists ✅)                                                     |

**The key finding: Codex adopted Claude's hook contract** (same event names, same
`session_id`/`transcript_path`/`cwd`/`hook_event_name`/`permission_mode` fields, `async`,
`timeout`, `matcher`). So the Claude pipeline carries over to Codex almost unchanged. OpenCode
is different: in-process plugins over a typed event bus. That is actually the richest source,
because we write the plugin and can project events down to exactly what we need, with no
content leaving the agent process.

---

## 3. Today's pipeline and where it's Claude-bound

```
shell-integration.ts   claude() { command claude --settings "$MINMUX_CLAUDE_SETTINGS" "$@" }
        │               (zsh + bash; WSLENV forwards MINMUX_CLAUDE_SETTINGS/p + MINMUX_PANE_ID)
        ▼
hook-writer.ts         buildHookSettings(eventsDir) → claude-hooks.json (+ .wsl.json)
        │               each hook: node -e HOOK_WRITER <eventsDir> → <paneId>.<pid>.<ts>.<rand>.json
        ▼
agent-hooks.ts         startHookWatcher: claim/parse/delete → normalizeHookEvent (Claude fields)
        ▼
main.ts                startAgentObservability.onBatch:
                        SessionLedger.apply (resume + lead/nested) → agents:events
                        AgentMetaTracker.track (transcript /color /rename) → agents:meta
                        tokenEventsForBatch (transcript usage) → agents:events (TokenUsage)
        ▼
renderer               store.applyAgentEvents → reduceAgentEvent (agent-graph.ts)
                        agents-panel · sidebar (icon, snippet, from/in, PR) · terminal-pane accent
                        app.tsx git poll (agent-dirs) · resume banner · close-confirm
```

Claude-specific code, by layer. Everything not listed is already agent-agnostic.

| Layer       | Claude-bound today                                                                                                                                                                                                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Arming      | `claude()` in `ZSH_ZSHRC` / `BASH_HOOKS` tail (shell-integration.ts:75, :158); `MINMUX_CLAUDE_SETTINGS` (main.ts:767, `wslInjection` wslenv, profile.ts scrub list); `buildHookSettings`                                                                                                                      |
| Normalise   | `normalizeHookEvent` (agent-hooks.ts) reads Claude field names; `AgentEvent.event` is a free `string` of Claude hook names                                                                                                                                                                                    |
| Main fold   | `SessionLedger` (UUID `SAFE_ID`, `resumeCommand` → `claude --resume`, `cwdMatchesTranscript` = Claude's project-dir encoding, `permissionMode` words); `TRACED_HOOKS`                                                                                                                                         |
| Transcripts | `transcript-tokens.ts` (`message.usage`), `transcript-meta.ts` (`agent-color`/`custom-title`), `agent-tokens.ts` (`subagentTranscriptPath` = Claude's layout), `AgentMetaTracker` (one transcript per pane)                                                                                                   |
| Graph       | `reduceAgentEvent` switch on Claude names; two levels only (a sub-agent always parents to the root); `claudePaneIds`; no `agent` on nodes                                                                                                                                                                     |
| Renderer    | `ClaudeIcon`; `claudeWorkDirs`/`claudeWorkFlat`; `/.claude/worktrees/` in `inGitFor`; `CLAUDE_COLORS`; `TerminalManager.claudeActive/claudeStarted`, `ShellFlow.claudeSeen`, `store.claudeExited`; close-confirm `claude` flag + strings; resume banner strings + `claude --resume`; agents-panel empty state |
| Settings    | `resumeAgents` / `resumeBypassPermissions` are named generically but mean Claude                                                                                                                                                                                                                              |

Already generic, reused as-is: the drop-file transport (`startHookWatcher`, claim-by-rename,
sweep, size cap), `TranscriptFold`, `pane-git.ts` (branch + PR per folder), the git poll
planner (once fed a generic work-dir map), `session-status` and notifications, `resume-flow.ts`
(`onMark`, `canType`), `withCd`/`isPosixShell`, the resume banner state machine.

---

## 4. Core abstractions

### 4.1 `AgentKind` and the canonical event: keep Claude's hook names

We **don't** invent a new vocabulary. Claude's hook names are what Codex adopted, what our
test fixtures use, and what the reducer already understands. So they become the canonical
`AgentEventName` (a typed union instead of `string`), extended only where an agent brings a
concept Claude lacks:

```ts
// src/lib/agent-graph.ts
export type AgentKind = "claude" | "codex" | "opencode"

export type AgentEventName =
  | "SessionStart" | "SessionEnd"          // lifecycle (source / reason)
  | "UserPromptSubmit" | "Stop"            // turn start / end
  | "Notification" | "PermissionRequest"   // needs input (both → status "waiting")
  | "PreToolUse" | "PostToolUse"
  | "SubagentStart" | "SubagentStop"
  | "CwdChanged" | "FileChanged"
  | "WorktreeCreate" | "WorktreeRemove"
  | "TokenUsage"                           // synthetic (main computes, or the plugin reports)

export interface AgentEvent {
  agent: AgentKind                          // NEW: which adapter produced it
  event: AgentEventName                     // was: string
  parentAgentId?: string                    // NEW: explicit parent (OpenCode child sessions); absent = root
  pid?: number                              // NEW: agent process id when the adapter knows it (OpenCode) — lead rule
  …existing fields unchanged…
}
```

Mapping (normalisers own this table; the reducer only sees the left column):

| Canonical         | Claude                | Codex                                                              | OpenCode (plugin projection)                                                                                   |
| ----------------- | --------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| SessionStart      | SessionStart          | SessionStart                                                       | first event of a **root** session in this process (`session.created` w/o `parentID`, or first seen)            |
| SessionEnd        | SessionEnd            | SessionEnd                                                         | `session.deleted` only. Quitting fires nothing ✅: the prompt returning or the plugin's pid dying ends it (F5) |
| UserPromptSubmit  | UserPromptSubmit      | UserPromptSubmit                                                   | `session.status` → busy (root)                                                                                 |
| Stop              | Stop                  | Stop, **Interrupt**                                                | `session.idle` / `session.status` → idle (root)                                                                |
| Notification      | Notification          | —                                                                  | `question.asked`                                                                                               |
| PermissionRequest | —                     | PermissionRequest                                                  | `permission.asked`                                                                                             |
| Pre/PostToolUse   | Pre/PostToolUse       | Pre/PostToolUse                                                    | `tool.execute.before/after`                                                                                    |
| SubagentStart     | SubagentStart         | SubagentStart                                                      | `session.created` **with** `parentID` (`parentAgentId` = parent unless it's the root)                          |
| SubagentStop      | SubagentStop          | SubagentStop                                                       | child `session.idle`                                                                                           |
| CwdChanged        | CwdChanged            | synthesised when `cwd` changes (normaliser keeps last per session) | —                                                                                                              |
| FileChanged       | FileChanged           | from `apply_patch`/`Edit`/`Write` input (paths only)               | `file.edited`                                                                                                  |
| Worktree*         | Worktree*             | —                                                                  | —                                                                                                              |
| TokenUsage        | main, from transcript | main, from rollout                                                 | plugin, from `message.updated` (accumulated in-plugin)                                                         |

`AgentNode` gains `agent: AgentKind`. A sub-agent attaches to `parentAgentId` when that node
exists, else to its session root (two-level stays the default; OpenCode gets depth).

### 4.2 `AgentAdapter` (main process): the only place agent specifics live

```ts
// electron/agents/types.ts
export interface AgentAdapter {
  kind: AgentKind
  command: string // "claude" | "codex" | "opencode"

  /** Write this adapter's static files once per launch (hook settings, plugin). */
  install(ctx: { cfgDir: string; dropRoot: string; dropRootWsl: string | null }): void
  /** Env (and shell functions) that arm the agent in one pane. Pure. */
  arm(pane: { wsl: boolean }): { env: Record<string, string>; wslenv: string[] }

  /** A raw drop (+ filename facts) → 0..n canonical events. Never throws. */
  normalize(raw: unknown, file: { paneId?: string; pid?: number; ts: number }): AgentEvent[]

  /** Token totals for events that end a turn / sub-agent (reads a transcript) — optional. */
  usage?: (batch: AgentEvent[], resolve: ResolvePath) => Promise<AgentEvent[]>
  /** Where the session's name/colour comes from — optional. */
  meta?: MetaSource
  /** Lead/nested + resume rules — optional (no resume without it). */
  session?: SessionRules
}

export interface SessionRules {
  safeId: RegExp
  resumeCommand(e: LedgerEntry, opts: { allowUnsafeMode: boolean }): string | null
  /** Does this folder belong to the session? (Claude's project-dir check) — undefined = can't tell. */
  cwdFits?(cwd: string | undefined, transcriptPath: string | undefined): boolean | undefined
  /** Is a new root SessionStart a switch (replaces the lead) rather than a nested agent? */
  isSwitch(ev: AgentEvent, lead: LedgerEntry): boolean
}
```

Shell functions stay in `shell-integration.ts` (scripts are line arrays, reviewed as shell),
generated from the adapters' `command` + env var name: one loop, not three hand-written
functions. OpenCode needs no function (env only).

### 4.3 Transport: one drop root, one subfolder per agent, dir passed by env

- `hook-events/<nonce>/<agent>/<paneId>.<pid>.<ts>.<rand>.json`, so the agent comes from the
  folder. The filename format is unchanged and `startHookWatcher` gets `depth: 1`.
- **The drop root moves from the hook definition to an env var** `MINMUX_AGENT_EVENTS`.
  WSL panes get the **Windows** path, forwarded as `MINMUX_AGENT_EVENTS/p` so WSL translates
  it (`C:\…` → `/mnt/c/…`) for writers inside the distro. This replaces today's separate
  `/mnt/c`-addressed `claude-hooks.wsl.json`. Two reasons:
  1. Codex trusts a hook by the hash of its definition. Today the per-launch nonce dir is
     baked into the command, which would ask for a re-review on **every launch**. With the
     dir in the env, the definition is constant per profile: review once.
  2. One writer script for all agents (`node <cfg>/agents/drop.js <agent>`), instead of the
     inline `node -e` per settings file. Claude keeps `-e` or moves too (either works).
- The nonce still protects: only our panes know the dir.

### 4.4 Renderer: agent-kind metadata + agent-neutral selectors

`src/lib/agent-kinds.ts`, pure data:
`{ label: "Codex", command: "codex", icon: CodexIcon, worktreeMarkers: [] }`.
Renames: `claudePaneIds → agentPanes` (flat `[paneId, kind, …]` for `useShallow`),
`claudeWorkDirs → agentWorkDirs`, `claudeActive/claudeStarted/claudeExited → agent…`,
`ShellFlow.claudeSeen → agentSeen`, `ClaudeIcon → AgentIcon({ kind })`.

---

## 5. Feature-by-feature plan

Each feature: what exists (grounded in code) → is the abstraction there? → what to add →
per-agent plan.

### F1. Zero-setup arming (scoped to minmux panes)

**Today.** `main.ts` `pty:spawn` sets `MINMUX_CLAUDE_SETTINGS` + `MINMUX_PANE_ID` when
`hookSettingsPath` is set. The zsh/bash rc defines `claude()` only when the var is set and the
shell is interactive. WSL: `wslInjection` lists `MINMUX_CLAUDE_SETTINGS/p`. The profile scrub
removes a parent minmux's vars (profile.ts:55).

**Abstraction: missing.** Env names and the function are hard-coded.

**Add.** `adapter.arm()` → env + wslenv merged in `pty:spawn` for every enabled adapter.
Generate the rc functions from adapter metadata. Add every new var to
`PARENT_INSTANCE_VARS`. Per-agent enable switch in settings (F18).

- **Claude.** No behaviour change: `MINMUX_CLAUDE_SETTINGS` keeps its name (older rc files in
  a running shell still reference it).
- **Codex.** `MINMUX_CODEX_ARGS` holds the override(s); rc defines
  `codex() { command codex $MINMUX_CODEX_ARGS "$@" }` (array form in zsh/bash so the TOML
  value isn't word-split). The override is the hooks table as inline TOML, e.g.
  `-c 'hooks.SessionStart=[{hooks=[{type="command",command="node \"…/drop.js\" codex",async=true,timeout=5}]}]'`
  per event. ✅ **S1-a**: `-c` hooks form their own `/<session-flags>/config.toml` layer and
  run **in addition to** the user's `hooks.json` and `[hooks]` in config.toml (both fired
  next to ours in the spike). Never write `~/.codex` ourselves (Codex itself writes the trust
  record there when the user approves).
  ✅ **S1-b**: hook subprocesses inherit the env (`MINMUX_PANE_ID` arrived on every event),
  so per-pane values stay out of the hook definition and trust holds across panes and
  launches.
  **Launch marker.** The wrapper also prints a private, non-secret OSC
  (`OSC 6974;agent;codex ST`) before `command codex`. terminal-manager then knows "Codex was
  launched in this pane" even when no hook fires (hooks untrusted, old Codex), which drives
  the review hint (F18). It is display-only (anything printed can fake it), so it never
  feeds the ledger or resume.
- **OpenCode.** No function. Env
  `OPENCODE_CONFIG_CONTENT='{"plugin":["file://<cfg>/agents/opencode-plugin.js"]}'`
  (WSL panes: the plugin URL as a `/mnt/c` path, forwarded without `/p` since it's JSON, not a
  path). **If the user already exports `OPENCODE_CONFIG_CONTENT`** (seen in main's env after
  `shell-env.ts`), main parses it and appends our plugin to its `plugin` array instead of
  replacing it; an unparseable value is left alone and OpenCode isn't armed in that pane.
  ✅ **S2-a**: the inline config's `plugin` list **merges** with the user's (a stand-in user
  plugin from their config loaded next to ours), and the plugin process sees
  `MINMUX_PANE_ID`. No fallback needed. Arming works in fish/pwsh/nushell too, since no shell
  function is needed. Ending a session there relies on the plugin pid check (F14), because
  those shells send no "prompt returned" mark.

### F2. Event transport (file drops)

**Today.** `HOOK_WRITER` (inline `node -e`) → `startHookWatcher` (claim by rename, 750 ms
sweep, 1 MiB cap, 50 ms coalescing, sort by filename ts). **Abstraction: present**, only the
dir layout and the writer's dir argument change (§4.3).

- **Claude.** Settings point at `drop.js claude` (or keep `-e` with `process.env`).
- **Codex.** Same writer: Codex hooks get JSON on stdin (📄), exactly what the writer copies.
  `async: true`, `timeout: 5`, **except SessionEnd and Interrupt: `timeout: 3`, no `async`**.
  Codex clamps those two to 3 s and always runs SessionEnd synchronously, and it lists any
  hook that asks for more under "Issues" on the `/hooks` screen ✅, which users would read as
  minmux's hooks being broken.
- **OpenCode.** The plugin writes drops itself (`fs.promises.writeFile`, never awaited by the
  hook, errors swallowed). It writes a **projected** payload `{v:1, type, sessionID, parentID,
…}`, not raw bus events, so no prompt, file or tool content ever leaves the agent (M6 §6
  safety rule, now enforced at the source).

### F3. Normalisation

**Today.** `normalizeHookEvent` (agent-hooks.ts) → `AgentEvent`. **Abstraction: missing.**
**Add.** `adapter.normalize` per agent, dispatched by subfolder. Claude's current function
moves to `electron/agents/claude.ts` unchanged, and gets `agent: "claude"`.

- **Codex.** Start from the Claude normaliser (same fields), plus:
  - `Interrupt` → `Stop`;
  - `PermissionRequest` passes through (reducer: waiting);
  - `tool_name: "apply_patch"`: extract paths from `*** Add File:`/`*** Update File:`/`*** Delete File:`
    headers in `tool_input` (bounded scan, paths only);
  - a per-(session) last-cwd map synthesises `CwdChanged`;
  - drop `turn_id` (no use yet).
- **OpenCode.** Validates the plugin's projection (`v: 1`, else drop). Maps per §4.1.
  Root vs child: `parentID` present ⇒ `SubagentStart` with `agentId = sessionID`,
  `sessionId` = the **root** session (the plugin resolves the root by walking `parentID`s it
  has seen) and `parentAgentId` = the parent unless it is the root. Keeps `pid` (the plugin
  runs inside the opencode process, so `process.pid` identifies that TUI instance).

### F4. Agent tree board

**Today.** `agents-panel.tsx` renders `rootIds` → `childIds` (one level) + worktrees, status
dot, current tool, cwd-or-recent-file, token badge, click to focus, box around the active
pane's session. **Abstraction: mostly present** (the graph is agent-neutral except the
two-level assumption and Claude event names).

**Add.** `agent` on nodes + an icon per root; a recursive child renderer (depth-indented,
capped at ~4 levels, then "+N"); reducer: attach to `parentAgentId` if known;
`UserPromptSubmit` prunes finished descendants recursively; `SessionEnd` evicts the subtree.
Empty state: "run `claude`, `codex` or `opencode` in a pane".

- **Claude.** Unchanged (never sends `parentAgentId`).
- **Codex.** Two levels from SubagentStart/Stop. Sub-agent tool events carry the
  sub-agent's `agent_id` ✅, so its tools and files attribute to it exactly as for Claude.
- **OpenCode.** Child sessions (`parentID`), each tool call with its own `sessionID`, so
  per-child attribution works. ✅ By default a sub-agent has **no `task` tool**, so the tree is
  two levels like Claude's; deeper only with custom agent configs (the reducer supports it).
  The child's type is the title suffix: `"… (@general subagent)"`.

### F5. Agent presence per pane (icon, "agent here", exit, close confirm)

**Today.** `claudePaneIds(graph)` (non-nested roots) drives the sidebar/tab icon
(`ClaudeIcon`), close-confirm's `claude` flag, and the accent. Exit detection: `onMark` emits
`shell-idle` when a prompt returns after `claudeSeen` → `ipc.shellIdle` (ledger) +
`store.claudeExited` (`dropPaneSessions`). **Abstraction: missing** (names only; the
mechanism is agent-neutral).

**Add.** `agentPanes` returns kind per pane; icon from `agent-kinds`; close-confirm carries
`agent?: AgentKind` and says "Codex is running in this terminal…"; renames per §4.4.

- **Claude.** Same behaviour.
- **Codex.** Same as Claude (SessionEnd + prompt-return backstop).
- **OpenCode.** No reliable end event when the TUI quits, so the **prompt-return backstop is
  the main path** (already built). ✅ Quitting fires **no** event at all (no
  `server.instance.disposed`, no `session.deleted`).

### F6. Agent status (working / waiting / idle / done)

**Today.** The graph node status: `UserPromptSubmit`/`PreToolUse` → working, `Notification`
→ waiting, `Stop` → idle, `SubagentStop` → done. Board only. Pane/tab status is the separate
generic heuristic (`session-status.ts`, known flaw §9a). **Abstraction: present** once
events are canonical.

**Add.** `PermissionRequest` → waiting. On `PostToolUse`/`UserPromptSubmit` after waiting →
working (today a waiting node stays waiting until the next PreToolUse; same fix for all).

- **Codex.** PermissionRequest is an exact "needs you" signal; Interrupt → idle.
- **OpenCode.** `session.status` gives busy/idle/retry directly; `permission.asked` →
  waiting, `permission.replied` → working.
- **Follow-up, not in this work:** feeding hook status into pane/tab badges would fix §9a for
  all agents, but GOTCHAS #agent-status says it needs the activity-based rewrite with a test
  matrix. Tracked separately (ROADMAP M3.6 Track C).

### F7. Working dir: `from` / `in`, and panels follow the agent

**Today.** `claudeWorkDirs` (newest non-nested root per pane → `cwd` + other worktrees) feeds
the sidebar's `from`/`in` lines, `planGitPoll` (polls the `in` folder under `inGitKey`),
`workCwd` → `useActiveWorkCwd` (Changes/Files panels, status bar). `inGitFor` treats
`/.claude/worktrees/` under a repo as a separate checkout. **Abstraction: present in logic,
missing in naming** + the Claude worktree marker.

**Add.** Rename to `agentWorkDirs`; `worktreeMarkers` from `agent-kinds` (Claude:
`/.claude/worktrees/`; others: none yet).

- **Codex.** `cwd` on every event. Codex rarely moves, but `in` works when it does (e.g.
  started in a subfolder).
- **OpenCode.** `Session.directory` (the project dir) on session events; `path.cwd` on
  assistant messages if finer is needed.

### F8. Worktrees on the board

**Today.** `WorktreeCreate`/`Remove` → `root.worktrees` → board chips + "open a terminal
here" + sidebar "other worktrees". **Abstraction: present.**

- **Codex / OpenCode.** No worktree events → no chips. The generic side still works: when an
  agent's `cwd` is a linked worktree, `in` + the PR poll show its branch/PR. Revisit if either
  adds worktree events.

### F9. Branch + PR status

**Today.** `pane-git.ts` (`git rev-parse` + `gh pr view`, cached/TTL'd in main) per pane
folder, plus the agent's `in` folder when it moved (`planGitPoll`). **Abstraction:
present.** Nothing agent-specific once F7 is generic. All three agents get it for free.

### F10. Current tool + recent files

**Today.** `PreToolUse` sets `currentTool`; file paths from `tool_input.file_path|path|notebook_path`
and `FileChanged` → `recentFiles` (cap 10). **Abstraction: present** (via normalisers).

- **Codex.** `tool_name` as-is (`Bash`, `apply_patch`, …); the sub-agent tools are
  `collaborationspawn_agent` / `collaborationwait_agent` ✅, shown as "spawn agent" / "wait agent";
  paths from F3's patch-header scan.
- **OpenCode.** The plugin extracts `args.filePath` / `args.path` for `edit`/`write`/`read`
  tools. ✅ `file.edited` carries **no `sessionID`**, so it isn't used (the tool args already
  have the path, with the session). Tool names are OpenCode's lower-case (`bash`, `edit`, …).
  Show them as they come.

### F11. Tokens

**Today.** `tokenEventsForBatch`: on `Stop` read the session transcript, on `SubagentStop`
the sub-agent transcript (`agent_transcript_path` or Claude's derived layout) → synthetic
`TokenUsage` (`context` = latest input incl. cache, `output` cumulative). `TranscriptFold`
reads incrementally in 256 KiB slices. **Abstraction: half.** The fold engine is generic;
the line parser, the trigger events and the sub-agent path rule are Claude's.

**Add.** `adapter.usage`. `TokenUsage` gains optional `window?: number` (model context
window) so the badge can show a fill %, when known.

- **Claude.** Current code moves behind `usage`.
- **Codex.** A new fold over rollout lines: `type:"event_msg"`, `payload.type:"token_count"`,
  `info.last_token_usage.input_tokens` → `context` (Codex's `input_tokens` already includes
  `cached_input_tokens` ✅), `info.total_token_usage.output_tokens` → `output` (it's already
  cumulative, so overwrite rather than add), `info.model_context_window` → `window`. Same
  triggers (Stop, SubagentStop with `agent_transcript_path`). WSL path resolution reuses
  `transcriptTargets`.
- **OpenCode.** No transcript read. The plugin accumulates per session from `message.updated`
  (assistant, completed; deduped by message id): `context` = latest `input + cache.read +
cache.write`, `output` += `output + reasoning`. It emits `TokenUsage` directly, and each
  child session reports against its own node.

### F12. Session name + highlight colour

**Today.** `AgentMetaTracker` watches the lead session's transcript (`fs.watch`, debounced)
and folds `agent-color`/`custom-title` (`transcript-meta.ts`) → `agents:meta` → `agentMeta`
→ `sessionColor()` (explicit colour wins, else hash of name into `CLAUDE_COLORS`) → pane
border + tab icon; host colour beats it; the name also goes to the resume banner via
`ledger.setName`. **Abstraction: half.** `SessionMeta` and `sessionColor` are generic; the
source (one Claude transcript per pane) isn't.

**Add.** `adapter.meta: MetaSource` with two shapes: **file-watch** (Claude: per-pane
transcript; Codex: one shared index file) and **pushed** (OpenCode: the plugin sends a `meta`
drop). `CLAUDE_COLORS` → `ACCENT_COLORS` (same eight).

- **Claude.** Unchanged.
- **Codex.** `thread_name` from `<codex home>/session_index.jsonl`: append-only, latest line
  per `id` wins ✅. Derive `<codex home>` from `transcript_path` (`…/sessions/YYYY/MM/DD/…` →
  up four), so a custom `CODEX_HOME` just works. **One** watcher for all Codex panes
  (`TranscriptFold<Map<id, name>>`), fanning out to panes by session id. No colour command →
  hash of the name.
- **OpenCode.** `session.updated` → the plugin emits `{type:"meta", title}` for root
  sessions. ⚠️ Titles are auto-generated, so every session would get a colour
  (**decision D3**, §8). Default proposal: colour OpenCode panes only from the title the user
  **set** with `/rename`, else none; always show the title as the name (banner, board).
  ✅ OpenCode stores no "renamed" flag (its `session` table has only `title`), but titles go
  `"New session - <date>"` → one automatic title → so **any later change is the user's**. The
  plugin sends each title change with `{before, after, hadPrompt}`, and **main** decides and
  persists it in the session's ledger entry (`userNamed`), so the answer survives a resume
  (a new plugin process only sees the stored title). Rules: default → X before the first
  prompt = user (OpenCode only auto-titles a default title after a prompt); default → X after
  a prompt = automatic; any change from a non-default title = user. Limit: a session renamed
  in an OpenCode run outside minmux comes back uncoloured.

### F13. Last reply snippet (sidebar)

**Today.** Sidebar takes `lastMessage` of the newest non-nested root per pane
(`Stop.last_assistant_message`, `Notification.message`). **Abstraction: present.**

- **Codex.** `Stop.last_assistant_message` 📄.
- **OpenCode.** The plugin keeps the last assistant text part of the root session (bounded,
  first ~200 chars) and sends it on idle. ⚠️ That is content. The sidebar already shows it
  for Claude, so the same rule applies: shown, never logged.

### F14. Lead vs nested (which session "owns" the pane)

**Today.** `SessionLedger.apply`: while a live lead exists, another session's SessionStart is
nested unless `source` is `clear`/`fork`. Main tags root events `nested`, and the graph,
accent, `in` and presence follow only the lead. **Abstraction: missing** (the rule is
Claude's).

**Add.** `SessionRules.isSwitch(ev, lead)`; the ledger keys entries by pane and stores
`agent`. A SessionStart from a **different agent** while a lead is live is nested (e.g. a
Claude agent running `codex exec`).

- **Claude.** `isSwitch` = today's rule.
- **Codex.** Same rule (`codex exec` from the agent's Bash inherits the pane env → nested).
- **OpenCode.** The pane's lead is **the first opencode process (pid)** seen there. Its
  sessions switch freely (`/new`, session picker: the most recently _active_ root session
  leads). Sessions from another pid (an `opencode run` launched by the agent) are nested.
  Child sessions are never roots. **The lead also ends when its process is gone:** OpenCode
  fires nothing on quit (S2-c), and shells without our integration (fish, pwsh, a cold WSL)
  never send the returning-prompt mark. So main checks the lead pid with
  `process.kill(pid, 0)` when another agent's SessionStart arrives in that pane, on each
  resume plan, and every 10 s while an OpenCode lead without a prompt mark exists (one
  syscall, off the hot path). A dead pid clears the lead and evicts its sessions. WSL pids
  aren't visible from Windows: there the check is skipped and the prompt mark (zsh/bash in
  WSL are integrated) stays the only signal.

### F15. Resume on relaunch

**Today.** Ledger per pane (write-through, freeze on quit), `plan()` preflights and builds
`claude --resume <uuid> [--permission-mode m]`, `withCd` on POSIX shells, banner confirms on
the same session's SessionStart, one shot. **Abstraction: half.** The flow (`resume-flow.ts`,
banner, freeze/consume, preflight) is generic; id validation, the command, the folder check
and the confirm signal are Claude's.

**Add.** `LedgerEntry.agent`; `SessionRules.resumeCommand/safeId/cwdFits`; `ResumePlan.agent`;
the banner uses `agent-kinds` labels and the picker command (`claude --resume`, `codex
resume`, `opencode` + session list). **Compatibility (invariant: older builds read our
files, and never lose what a newer build wrote):** Claude entries stay in
`agent-sessions.json`, written exactly as today. Codex and OpenCode entries go in
`agent-sessions.codex.json` / `agent-sessions.opencode.json`, which older builds never read
or rewrite. So a downgrade neither types `claude --resume <codex-id>` nor deletes the other
agents' entries. One `SessionLedger` keeps all three in memory and writes each file
separately (same temp + rename, same freeze).

- **Claude.** Unchanged.
- **Codex.** `codex resume <id>`, `safeId` = the UUID regex (UUIDv7 fits ✅). No `cwdFits`:
  rollouts are found by id, not folder ✅, but still `cd` into the recorded cwd (sandbox +
  project trust are per folder). Permission mode is not restored in v1 (Codex's
  approval/sandbox flags don't map 1:1 to `permission_mode`; ❓ S1-d records what values
  appear). Confirm = SessionStart `source: "resume"` with the same id.
- **OpenCode.** `opencode --session <id>`, `safeId` = `^ses_[A-Za-z0-9]{26}$` ✅. OpenCode
  files sessions per project, so `cd` to `Session.directory`. ✅ Reopening a session emits no
  session event, only the plugin starting in a new process. So the plugin sends a `started`
  drop at init, and the confirm is **"OpenCode started in this pane and is still running
  after a few seconds"** (a bad id makes it exit, and the returning prompt fails the resume as
  today). The session id itself is confirmed at its first activity.

### F16. Attention + notifications

**Today.** Generic: OSC 9 / bell → `attention` signal → badges + native notification when
unfocused. **Abstraction: present.**

- **Codex.** Hooks give PermissionRequest/Stop, but pane badges don't use hook status yet
  (F6 follow-up). Codex's own `tui.notifications` (OSC 9 or bell while unfocused 📄) already
  reaches our generic attention path when the user enables it. We **don't** force it through
  `-c`: that would override the user's choice of events. The README documents
  `notifications = true` + `notification_method = "osc9"` for minmux users.
- **OpenCode.** ❓ S3 checks whether it rings the bell on idle/permission.

### F17. Terminal ergonomics (generic, verify per agent)

Shift+Enter → CSI-u newline (`terminal-keys.ts`), Ctrl+V image paste, COLORFGBG/OSC 10/11
light/dark, precmd mouse reset, click-to-open paths while mouse tracking is on. All generic.
❓ S3 checks each in Codex and OpenCode, and fixes land only if something is off.

### F18. Settings, naming, docs

- `settings.agents: { claude: { enabled }, codex: { enabled }, opencode: { enabled } }`
  (defaults **D2**). `resumeAgents` applies to all; `resumeBypassPermissions` stays
  Claude-only (it is Claude's mode) and its label says so.
- Settings panel: an "Agents" group showing each agent, enabled, and (Codex) "hooks need
  review in `/hooks` once" help.
- **Codex review hint.** A pane that printed the Codex launch marker (F1) and then produced
  no Codex hook event for 10 s gets a one-line hint above the terminal:

  > **Approve minmux in Codex to see every running agent live on the Agents board:** status,
  > sub-agents, tokens, and resume after restart. One-time: type **`/hooks`** in Codex, then
  > press **t**. [**Show me**] [Not now]

  minmux **never types** this for the user: it can't tell whether Codex sits at its input box
  or at its own "Trust this folder?" / "Hooks need review" screens or mid-turn, where the
  keys would pick an option or reach the model. **Show me** focuses the pane and copies
  `/hooks` to the clipboard. **Not now** hides it for this pane; after three dismissals it
  offers **Don't ask again** (stored in settings). It uses the `integration-hint.tsx`
  pattern (in the pane's flow, never over the prompt).
  It stops showing once a Codex hook event arrives **for the current definition**: main
  stores the sha256 of each hook definition it arms (native and WSL differ: their paths
  differ), and a seen-set of those hashes. A new minmux release that changes the definition,
  or a first WSL pane, has an unseen hash, so the hint can return when it's needed.

- Docs: GOTCHAS gets `#codex` and `#opencode` anchors; CLAUDE.md gains the invariant
  "**agent specifics live only in `electron/agents/<kind>.ts` + `src/lib/agent-kinds.ts`**".

---

## 6. Performance & safety (same hard rules as M6 §8)

- Nothing new touches the PTY → renderer path. All work is in main on the hook channel,
  async, coalesced.
- **Codex:** `async: true` hooks (never block its loop), `timeout` backstop, `node` per event
  as today. Only the event set we consume, and `matcher: ""` on tool events like Claude.
- **OpenCode plugin runs inside the agent.** Every handler returns immediately (the write is
  fire-and-forget), and it filters to the ~12 event types in §4.1 **before** doing anything.
  `message.part.*` deltas (the firehose) are ignored. `message.updated` is only read for
  completed assistant messages. `tool.execute.before` is awaited by OpenCode, so it must
  never do I/O inline. Measure with `MINMUX_PERF=1` plus a long OpenCode turn.
- **Content:** OpenCode drops are projected (no prompt/tool content except the bounded last
  reply for F13). Codex/Claude drops carry whatever the hook JSON has (as today), deleted
  after reading and never logged.
- **Trust:** the drop root is per-launch and secret (env only). Codex's hook definition holds
  no secret and no per-launch value (§4.3).

---

## 7. Risks

| Risk                                                                                     | Mitigation                                                                                                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Codex `-c` hooks replace the user's own hooks                                            | ruled out by S1-a (additive); a fixture test asserts we only ever pass `-c hooks.<Event>` keys                                 |
| Codex trust prompt confuses users ("minmux hooks need review")                           | a one-time hint in the pane when a Codex session starts but no hook event arrives (reuse the `integration-hint` pattern); docs |
| Codex/OpenCode formats change (rollout "not stable" 📄)                                  | parse best-effort, never throw (GOTCHAS #claude-transcript rules extended); version-tagged fixtures                            |
| OpenCode arming clobbers the user's config                                               | S2-a showed plugin lists merge; a user-exported `OPENCODE_CONFIG_CONTENT` is merged, not replaced (F1)                         |
| Plugin slows OpenCode                                                                    | filter-first, no awaited I/O; perf check in S2                                                                                 |
| Renaming churn breaks invariants (same-reference store returns, `useShallow` primitives) | the refactor phase is behaviour-neutral with the existing test suite as the gate                                               |
| Older build types `claude --resume <codex-id>`, or deletes other agents' entries         | non-Claude entries live in their own ledger files (§F15)                                                                       |
| A quit OpenCode keeps leading a pane without a prompt mark                               | lead pid liveness check (F14)                                                                                                  |

---

## 8. Decisions (settled 2026-10-01)

- **D1 — Codex hook trust: one-time `/hooks` approval.** Full feature set, plus the approval
  hint (F18) when Codex was launched but no hook event came. Not the notify-only fallback, and
  never `--dangerously-bypass-hook-trust` (it would also skip review of repo-provided hooks).
- **D2 — On by default.** Codex and OpenCode are armed like Claude: scoped to minmux panes,
  additive to the user's own hooks/plugins, no global config written. Settings keeps a
  per-agent switch.
- **D3 — Colour only from names the user set.** Codex and OpenCode both name sessions
  automatically, so colouring from any name would colour every pane. Always show the name
  (board, banner); colour only after a user rename (OpenCode: a title change after the
  automatic one; Codex: per S1-g).

## 9. Spike results

### S1 — Codex hooks (2026-09-30, Codex CLI 0.159.2, sandboxed `CODEX_HOME`)

Captured with a throwaway writer (stdin + env → file), once via `codex exec` and once in the
interactive UI. Fixtures: 17 events from `exec` (Bash, `apply_patch`, one sub-agent) and 16
from the UI (approval, Esc interrupt, stand-in user hooks).

- ✅ **Scoping works and is additive (S1-a).** `-c hooks.<Event>=[…]` shows up as its own
  source, `/<session-flags>/config.toml`. The stand-in user hooks in `$CODEX_HOME/hooks.json`
  and `[hooks]` in config.toml fired **next to** ours for SessionStart and Stop.
- ✅ **Env reaches the hook (S1-b).** `MINMUX_PANE_ID` on every event; the hook's parent pid
  is the Codex process.
- ✅ **Trust (S1-c).** Untrusted hooks are skipped; the UI opens a "Hooks need review · N hooks
  are new or changed" screen (Review / Trust all / Continue without), `codex exec` skips them
  silently. Approval is stored by Codex in `$CODEX_HOME/config.toml` as
  `[hooks.state."/<session-flags>/config.toml:<event>:<i>:<j>"] trusted_hash = "sha256:…"`:
  keyed by source + event + position + definition hash, **no folder** → one approval covers
  every repo while our definition stays byte-identical. Separate from Codex's per-folder
  "Trust this folder?" screen, which every Codex user sees anyway.
- ✅ **Payloads (S1-d).** Common: `session_id`, `transcript_path` (= the rollout JSONL), `cwd`,
  `hook_event_name`, `model`, `permission_mode` (`default`; `bypassPermissions` under exec).
  Turn events add `turn_id`. SessionStart `source: "startup"`; SessionEnd `reason: "other"`.
  PermissionRequest: `tool_name`, `tool_input.command` + `tool_input.description` ("May I run
  curl outside the sandbox…"). Stop: `last_assistant_message`. Interrupt fires on Esc.
  SubagentStart/Stop: `agent_id`, `agent_type` (`default`); SubagentStop adds
  `agent_transcript_path`, `last_assistant_message`. Sub-agent tool events carry `agent_id`.
- ⚠️ **Stop does not fire under `codex exec`** (UserPromptSubmit does); it fires in the UI,
  which is what minmux panes run. `exec` sessions launched by another agent are nested
  anyway.
- ⚠️ **A SessionEnd can arrive for a session that never sent SessionStart** (seen once around
  the trust screen). The reducer already ignores it; keep it in the fixture.
- ⚠️ **`plugin_hooks` is listed as removed** in `codex features list`: no plugin-bundled hooks.
  Fine, since `-c` is additive.
- Thread names are automatic (`session_index.jsonl`: "Run curl HEAD request"); Codex prints
  `codex resume <id>` on exit.
- Not yet checked: S1-e (quoting on native Windows / WSL), S1-f (`codex resume` from another
  folder), S1-g (does a user rename differ from an auto name?). They block only PR #7 and the
  Windows part of PR #5.

### S2 — OpenCode plugin (2026-10-01, OpenCode 1.18.34, sandboxed `XDG_CONFIG_HOME`/`XDG_DATA_HOME`)

A spike plugin logged every bus event and tool hook: one `opencode run` (bash, read, edit, a
`task` sub-agent) and one interactive session (permission, `/rename`, `/new`, `/sessions`,
quit, then `opencode --session <id>`).

- ✅ **Loading (S2-a).** `OPENCODE_CONFIG_CONTENT='{"plugin":["file://…"]}'` loads our plugin
  and keeps the user's own plugins; `MINMUX_PANE_ID` is in the plugin's env; `process.pid` is
  stable per OpenCode instance.
- ✅ **Lifecycle (S2-b).** Root `session.created` (`info.id`, `title`, `directory`) → repeated
  `session.status {type: busy}` (**dedupe**) → `session.status {type: idle}` + `session.idle`.
  Sub-agent: `session.created` with `info.parentID` and title `"… (@general subagent)"`,
  then its own busy/idle. Tools: `tool.execute.before/after` with `tool`, `sessionID`,
  `callID`, args (e.g. `filePath`). `permission.asked` (`permission`, `patterns`, `tool`) →
  `permission.replied`. Tokens on `message.updated` (assistant, `time.completed`):
  `input`, `output`, `reasoning`, `cache.read/write`, `cost`.
- ✅ **Sessions.** `/new` = a new root `session.created` in the same process; switching in
  `/sessions` emits nothing until the next prompt (then that session goes busy). Quit emits
  nothing (S2-c). `--session <id>` emits only `plugin.init` from the new process (S2-d).
- ✅ **Titles (S2-f).** default `"New session - <ISO date>"` → automatic → `/rename`; no flag
  marks a user title.
- ✅ **Cost (S2-e).** 308 handler calls during a turn with a sub-agent: median 0.001 ms, max
  0.32 ms, with synchronous appends. The real plugin writes asynchronously and filters first.
- ⚠️ `file.edited` has no `sessionID`; `opencode run` reads stdin when it isn't a TTY (a
  scripted run must close stdin); the free models need OpenCode ≥ 1.18.0.

## 10. Out of scope (recap)

SSH-pane agents; OTEL ingestion (M6 6c) for any agent; driving agents; Codex IDE/app-server
sessions; per-agent file authorship beyond "recent files"; cost display (OpenCode has it,
easy follow-up).
