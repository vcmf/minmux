# Implementation plan — Multi-agent support (Codex, OpenCode)

> How to build `MULTI_AGENT.md`, as a sequence of PR-sized steps. Each step lists files, the
> change, tests, real-app verification (`run-minmux` skill, never against the real `HOME`),
> and what "done" means. Feature ids (F1–F18) and spikes (S1–S3) refer to the design doc.

Status: **PLAN** (2026-09-30). Order: **Phase 0 spikes → Phase 1 refactor (Claude only, no
behaviour change) → Phase 2 Codex → Phase 3 OpenCode → Phase 4 polish**. Phases 2 and 3 are
independent once Phase 1 lands and can run in parallel.

Ground rules for every PR:

- `make fmt && make check` green (tsc renderer + electron, eslint, prettier, Vitest).
- Conventional commit / PR title per CLAUDE.md (e.g. `refactor(agents): …`, `feat(codex): …`).
- Performance: nothing on the PTY → renderer path; new main-process work is async and
  coalesced; the OpenCode plugin never awaits I/O in a handler.
- The existing invariants hold: same-reference store returns when unchanged, `useShallow`
  selectors return primitives, persisted files stay readable by older builds.

**Workflow per PR:** plan → implement → `/code-review high`. One review round to start; a
round that finds any **severe** issue means fix + another round; only moderate/low findings
→ fix what's worth it and stop. **Three or more rounds → stop and check whether the design
needs rework** rather than patching further. Before pushing, verify in the real app
(`run-minmux`) when the PR touches terminals, rendering or agent integration.

## PR plan (13 PRs)

The steps below merge into these PRs. Phases 1–3 are stacked (each PR branches off the
previous); Codex (#5–7) and OpenCode (#8–11) are independent once #4 lands.

| #   | PR (title without emoji)                                                     | Steps   | Depends on | Status                         |
| --- | ---------------------------------------------------------------------------- | ------- | ---------- | ------------------------------ |
| 0   | `docs(agents): multi-agent design, implementation plan and spike results`    | Phase 0 | —          | spikes S1 + S2 done, in review |
| 1   | `refactor(agents): tag events and nodes with the agent kind`                 | 1a      | 0          | implemented, in review         |
| 2   | `refactor(agents): per-agent drop folders, drop root from env`               | 1b      | 1          |                                |
| 3   | `refactor(agents): move claude specifics behind an adapter`                  | 1c      | 2          |                                |
| 4   | `refactor(ui): agent-neutral presence, icon and labels` + per-agent settings | 1d + 1e | 3          |                                |
| 5   | `feat(codex): agents board for codex sessions`                               | 2a      | 4          |                                |
| 6   | `feat(codex): token badge and thread name`                                   | 2b      | 5          |                                |
| 7   | `feat(codex): resume codex sessions and hint when hooks aren't approved`     | 2c + 2d | 5          |                                |
| 8   | `feat(opencode): minmux plugin and scoped loading`                           | 3a      | 4          |                                |
| 9   | `feat(opencode): agents board with multi-level sub-agents`                   | 3b      | 8          |                                |
| 10  | `feat(opencode): token badge and session title`                              | 3c      | 9          |                                |
| 11  | `feat(opencode): resume opencode sessions on relaunch`                       | 3d      | 9          |                                |
| 12  | `docs: architecture, gotchas, claude.md, roadmap and readme for multi-agent` | Phase 4 | all        |                                |

Rough size, production / test LOC: refactor ~600 new + ~350 moved / ~740; Codex ~600 / ~650;
OpenCode ~700 / ~680. Hardest parts: the OpenCode plugin (runs inside the agent), the
lead-vs-nested rules, and the meta tracker rework.

---

## Phase 0 — Spikes (throwaway; outputs = findings + captured fixtures)

Output of each spike: a short "Spike results" section appended to `MULTI_AGENT.md` (like
AGENT_OBSERVABILITY §7) + raw event streams saved as fixtures under
`src/test/fixtures/agents/<agent>-<scenario>.jsonl` (new dir; content scrubbed of prompts and
file contents before commit).

### S1 — Codex hooks (half a day)

**Done 2026-09-30** except S1-e/f/g. Results: `MULTI_AGENT.md` §9 (additive `-c` hooks, env
inherited, trust keyed by definition hash with no folder, sub-agent tool events carry `agent_id`).

Install the current Codex CLI in a sandbox `HOME` (`HOME=$(mktemp -d)`, copy auth only if
needed; never the real `~/.codex`). Use a throwaway writer that dumps stdin + `env` to a dir.

| Question                                                                                                                                                                                                                                                                            | How                                                                                         | Blocks             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------ |
| **S1-a** Does `-c hooks.<Event>=[…]` add to or replace `[hooks.<Event>]` in config.toml and `hooks.json`?                                                                                                                                                                           | put a user hook in `~/.codex/hooks.json` and config.toml, add ours via `-c`, see which fire | 2a design          |
| **S1-b** Do hook commands inherit the parent env (`MINMUX_PANE_ID`, `MINMUX_AGENT_EVENTS`)?                                                                                                                                                                                         | writer dumps `process.env`                                                                  | **all of Phase 2** |
| **S1-c** Trust UX: warning text, does `/hooks` trust persist across launches, and across a changed `MINMUX_AGENT_EVENTS` value? Is the trust hash over the definition only?                                                                                                         | trust once, relaunch with a different env value                                             | D1, 2d             |
| **S1-d** Real payloads: SessionStart/End, UserPromptSubmit, Pre/PostToolUse (`Bash`, `apply_patch`), PermissionRequest (approval mode on), Stop, Interrupt (Esc mid-turn), SubagentStart/Stop (a turn that spawns an agent); `permission_mode` values; `transcript_path` = rollout? | capture a scripted session                                                                  | 2a/2b fixtures     |
| **S1-e** Quoting: a hook `command` string with a quoted path containing spaces, on macOS/Linux, native Windows (which shell runs it?) and WSL                                                                                                                                       | vary the cfg path                                                                           | 2a                 |
| **S1-f** `codex resume <id>` from a different cwd: does it work, and which cwd does the session use?                                                                                                                                                                                | resume from `/tmp`                                                                          | 2c                 |
| **S1-g** `thread_name`: how is it set (`/rename`? auto?), and does `session_index.jsonl` get a line per change?                                                                                                                                                                     | rename twice, watch the file                                                                | 2b                 |

**Exit:** S1-b answered yes, and S1-a gives a non-destructive scoping path (either `-c` adds
to the user's hooks, or a plugin/alt path does). If S1-b is "no", switch Phase 2 to the
notify-only fallback (D1) and re-plan 2a.

### S2 — OpenCode plugin (half a day)

**Done 2026-10-01.** Results: `MULTI_AGENT.md` §9 (inline config merges plugins, two-level
tree by default, no quit event, resume confirmed by the plugin starting, renames detectable by order).

Sandbox via `XDG_CONFIG_HOME` / `XDG_DATA_HOME` in a temp dir (opencode 1.17.9 is installed ✅).

| Question                                                                                                                                                                                                        | How                                                             | Blocks      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------- |
| **S2-a** Does `OPENCODE_CONFIG_CONTENT='{"plugin":["file:///…/p.js"]}'` load the plugin, and does it **merge** with a user config that lists its own plugins?                                                   | user config with plugin A + our inline plugin B; log which init | 3a          |
| **S2-b** Real event stream: the root turn, a `task` sub-agent (and nested sub-agent if the agent does it), permission ask/reply, question tool, `/new`, the session picker, compaction, quit (Ctrl-C / `/exit`) | plugin logs every `event.type` + key ids                        | 3b fixtures |
| **S2-c** On quit, does `server.instance.disposed` fire, and does the plugin get time to write a file?                                                                                                           | as above                                                        | F5          |
| **S2-d** `opencode --session <id>`: what events fire when a session is resumed (confirm signal)? Session id format (regex)? Does it work from another cwd?                                                      | resume from another dir                                         | 3d          |
| **S2-e** Cost: time spent in our `event` handler under a long streaming turn                                                                                                                                    | `performance.now()` around the handler, histogram               | 3a          |
| **S2-f** Does a user-renamed title differ from an auto one (a flag/field)?                                                                                                                                      | rename a session, diff `Session`                                | D3, 3c      |

**Exit:** a working, merging arming path (inline config, or `OPENCODE_CONFIG_DIR` fallback)
and a captured stream covering root + child sessions.

### S3 — Terminal ergonomics in both TUIs (1–2 hours, in the dev build)

Inside `make run` (dev profile, sandbox HOME): Shift+Enter newline, Ctrl+V image paste,
light/dark detection (COLORFGBG / OSC 11), mouse selection + click-to-open while the TUI holds
the mouse, window title updates, bell/OSC 9 on turn end (Codex with `tui.notifications`),
focus reporting across split panes. File issues for anything off. No code is planned here
unless something breaks.

---

## Phase 1 — Refactor to the abstraction (Claude only, zero behaviour change)

Gate for every PR in this phase: the **existing** tests pass unchanged except for mechanical
renames, and a `run-minmux` pass shows Claude still gets board, icon, `in`, PR, accent,
tokens and resume. No user-visible change.

### 1a. Agent kind in the event and graph (`refactor(agents): tag events and nodes with the agent kind`)

- `src/lib/agent-graph.ts`: add `AgentKind`, `AgentEventName` union (§4.1 of the design),
  `AgentEvent.agent`, `parentAgentId?`, `pid?`; `AgentNode.agent`. Reducer: set `agent` on node
  creation; `PermissionRequest` → `waiting` (unused by Claude but harmless);
  `PostToolUse` on a `waiting` node → `working`; attach to `parentAgentId` when that node
  exists (recursive `childIds`); `evictRoot` and the `UserPromptSubmit` prune walk the subtree.
- `electron/agent-hooks.ts`: `normalizeHookEvent` returns `agent: "claude"`; the `event`
  field is narrowed to the union (unknown names still pass through as-is at runtime and fall
  to `default:`, so keep the type `AgentEventName | (string & {})`).
- `claudePaneIds` → `agentPanes(graph): string[]` flat `[paneId, kind, …]`, memoised the same
  way. Keep `claudePaneIds` as a thin wrapper for this PR only if it shrinks the diff.
- Tests: `agent-graph.test.ts` fixtures get `agent: "claude"` (a helper); new cases: a
  three-level tree via `parentAgentId`; prune/evict of a deep subtree; PermissionRequest →
  waiting → PostToolUse → working; `agentPanes` memo identity.

### 1b. Transport: per-agent subfolder and dir from env (`refactor(agents): per-agent drop folders`)

- `electron/hook-writer.ts` → `electron/agents/drop-writer.ts`: `HOOK_WRITER` reads the root
  from `process.env.MINMUX_AGENT_EVENTS` and the agent from `argv[1]`, writes
  `<root>/<agent>/<paneId>.<pid>.<ts>.<rand>.json`. If the env var is missing it writes nothing
  (the hook is a no-op outside minmux panes, e.g. a stale shell).
- `startHookWatcher`: watch the root with `depth: 1`; the agent is the parent folder name
  (ignore unknown folders); the sweep reads each known subfolder; `onBatch` receives
  `{ agent, raw, file }` records, or keep the signature and pass a `normalize(agent, raw, file)`
  callback (preferred: the watcher stays agent-free).
- `main.ts` `startAgentObservability`: create `<nonce>/claude/`, set `MINMUX_AGENT_EVENTS` per
  pane (WSL: the `/mnt/c` form, forwarded with `/p` → translate the Windows path instead;
  pick one approach in review and test it). Add the var to `wslInjection` wslenv and to
  `PARENT_INSTANCE_VARS` (profile.ts).
- `buildHookSettings` no longer takes a dir: the settings file is now constant per profile.
  The `.wsl.json` variant goes away if the env path translation covers it (it should: the
  writer resolves the env var inside WSL).
- Tests: `hook-writer.test.ts` → the writer builds the right path from env + argv, and is a
  no-op without env (run the `-e` source with a fake env in Vitest via `node:vm` or a child
  `node`, since plain Node is fine in Vitest); `agent-hooks.test.ts`: files in `claude/` are
  tagged, unknown folders are ignored, claim/sweep dedup still holds across subfolders.
- Verify: the Claude board fills in native and (if a Windows box is available) WSL panes.

### 1c. Adapter registry in main (`refactor(agents): move claude specifics behind an adapter`)

- New `electron/agents/`: `types.ts` (`AgentAdapter`, `SessionRules`, `MetaSource`),
  `registry.ts` (`adapters: AgentAdapter[]`, `adapterFor(kind)`), `claude.ts` holding:
  `buildHookSettings` + `install`, `arm` (`MINMUX_CLAUDE_SETTINGS`), `normalize` (the old
  `normalizeHookEvent`), `usage` (from `agent-tokens.ts` + `transcript-tokens.ts`), `meta`
  (file-watch source wrapping `transcript-meta.ts`), `session` (`SAFE_ID`, `resumeCommand`,
  `cwdFits` = `cwdMatchesTranscript`, `isSwitch` = the `clear`/`fork` rule).
- `main.ts`: `startAgentObservability` loops the registry (install, subfolder, normaliser by
  folder); `pty:spawn` merges `arm()` of every enabled adapter; `onBatch` calls
  `adapterFor(ev.agent).usage` and meta routing; `TRACED_HOOKS` unchanged (canonical names).
- `electron/agent-sessions.ts`: `SessionLedger` takes the registry. `apply` uses
  `rules.isSwitch` / `rules.cwdFits` of the event's agent. A root SessionStart from a
  **different agent** than the live lead is nested. `resumeCommand` comes from
  `rules.resumeCommand`. `LedgerEntry.agent` (missing on load ⇒ `"claude"`). Serialize a
  non-Claude entry with `id` instead of `sessionId` (older builds skip it), and a Claude entry
  byte-for-byte as today.
- `shell-integration.ts`: generate the wrapper lines from `[{ command, envVar }]` (still line
  arrays; one generated block per agent that needs a wrapper; Claude's output identical to
  today, asserted by a snapshot test).
- Tests: move existing tests alongside (`claude.test.ts` gets the normaliser + hook-settings
  tests); `agent-sessions.test.ts` all green plus: an entry without `agent` loads as Claude; a
  non-Claude entry serializes without `sessionId` and round-trips; a Claude SessionStart while
  a (fake) other-agent lead is live → nested. `shell-integration.test.ts`: the generated zsh
  and bash rc are byte-identical to the current strings for Claude-only.

### 1d. Renderer naming + agent kinds (`refactor(ui): agent-neutral presence, icon and labels`)

- New `src/lib/agent-kinds.ts`: `{ claude: { label, command, worktreeMarkers: ["/.claude/worktrees/"] } }`
  (icons live in components; map kind → icon in `components/agent-icon.tsx`, with
  `ClaudeIcon` kept as the Claude entry).
- Renames: `claudeWorkDirs/claudeWorkFlat` → `agentWorkDirs/agentWorkFlat` (`agent-dirs.ts`,
  `inGitFor` reads markers from `agent-kinds` by the node's agent: `WorkDir` gains `agent`);
  `TerminalManager.claudeActive/claudeStarted` → `agentActive/agentStarted`;
  `ShellFlow.claudeSeen` → `agentSeen`; `store.claudeExited` → `agentExited`;
  `close-confirm.ts` `claude: boolean` → `agent?: AgentKind` + strings from `agent-kinds`
  (tab form: "2 are running agents" when mixed, else "running Codex"); `CLAUDE_COLORS` →
  `ACCENT_COLORS`; resume banner strings via `agent-kinds` (`ResumePlan.agent`, defaulting to
  Claude); agents-panel icon per root + empty-state text; sidebar/terminal-pane icon by kind.
- Tests: rename-only updates to `agent-dirs.test.ts`, `close-confirm.test.ts`,
  `resume-flow.test.ts`, `sidebar.test.tsx`, `terminal-pane.test.tsx`, `resume-banner.test.tsx`,
  `session-color.test.ts`; one new test each: the close text for a Codex/mixed tab, the
  worktree marker only applying to its own agent.

### 1e. Settings (`feat(settings): per-agent enable switches`)

- `src/settings/schema.ts`: `agents: { claude: { enabled: true }, codex: { enabled: D2 },
opencode: { enabled: D2 } }` with merge/validate; main reads it at spawn (`arm` only for
  enabled adapters; a change applies to **new** panes, stated in the UI).
- Settings panel "Agents" group; `resumeBypassPermissions` label → "Claude: restore bypass
  permission mode".
- Tests: schema merge/validate (unknown agent keys dropped, missing ones defaulted); spawn
  env includes only enabled agents (unit-test the env builder, not a PTY).

**Phase 1 exit:** Claude-only behaviour identical (full `run-minmux` pass: board, sub-agents,
icon, snippet, `in` + PR, accent via `/color` + `/rename`, tokens, quit → relaunch → resume);
ROADMAP 6d updated to "in progress".

---

## Phase 2 — Codex adapter

Depends on S1 (+ Phase 1). Fixtures from S1-d drive every test.

### 2a. Arm + normalise (`feat(codex): agents board for codex sessions`)

- `electron/agents/codex.ts`:
  - `install`: nothing beyond the shared `drop.js` (written once to `<cfg>/agents/drop.js`,
    shared with Claude if 1b moved Claude to it).
  - `arm`: `MINMUX_CODEX_ARGS` = the `-c` overrides per S1-a (one per event in §4.1's Codex
    column: SessionStart, SessionEnd, UserPromptSubmit, PreToolUse, PostToolUse,
    PermissionRequest, Stop, Interrupt, SubagentStart, SubagentStop), each
    `{type="command", command="node \"<cfg>/agents/drop.js\" codex", async=true, timeout=5}`
    (SessionEnd and Interrupt: `timeout=3`, no `async`, or `/hooks` lists them under "Issues"); tool events with `matcher=""`. Pure builder, and the output must be
    byte-stable across launches (trust hash; asserted in a test).
  - `normalize`: Claude-compatible fields + `Interrupt → Stop`, `apply_patch` path scan
    (`/^\*\*\* (Add|Update|Delete) File: (.+)$/m`, max 20 paths, input capped at 256 KiB before
    scanning), per-session last-cwd → synthetic `CwdChanged`, `agent: "codex"`.
  - `session.isSwitch`: Claude's rule (`clear`) (no `fork` in Codex's sources).
- `shell-integration.ts`: generated `codex()` wrapper (zsh: `command codex ${(z)MINMUX_CODEX_ARGS} "$@"`
  or, safer, store the args as a newline-separated list and split into an array; bash: `read -ra`
  / `mapfile`). Pick the variant with no word-splitting pitfalls in review and test it with a
  path containing a space. It also prints the launch marker `OSC 6974;agent;codex`.
- terminal-manager: parse `OSC 6974;agent;<kind>` (display-only) → `entry.flow.agentLaunched = kind`
  (+ timestamp) for the hint in 2d.
- Tests: `codex.test.ts` (normaliser over the S1 fixture: event mapping, patch path extraction,
  size cap, no throw on junk; `arm` output stable and quoting-safe); `agent-graph` over the
  Codex fixture (root + a sub-agent, root receives the sub-agent's tool events, waiting on
  PermissionRequest, idle on Interrupt); `shell-integration` generated wrappers.
- Verify (`run-minmux`, sandbox HOME with Codex authed): a Codex session shows on the board
  with status transitions, sub-agent row, Codex icon in the sidebar/tab, `in` line when started
  in a subfolder, PR line, close-confirm text; `claude` in another pane unaffected.

### 2b. Tokens + name/colour (`feat(codex): token badge and thread name`)

- `codex.ts` `usage`: `TranscriptFold` with a Codex line fold (`event_msg`/`token_count` →
  `{ context: last.input_tokens, output: total.output_tokens, window: model_context_window }`),
  triggered on Stop / SubagentStop (`agent_transcript_path`); `forget` on SessionEnd.
- `TokenUsage.window?` (agent-graph) + `tokens.ts` / agents-panel: show `context / window` %
  in the tooltip when `window` is known.
- `codex.ts` `meta`: shared-file source over `<codex home>/session_index.jsonl` (derive home
  from `transcript_path`), fold `Map<id, thread_name>` (latest wins), one `fs.watch`; the
  tracker fans out to panes whose lead is that session id. Generalise `AgentMetaTracker` to take
  a `MetaSource` (per-pane file vs shared file vs pushed).
- Tests: token fold over fixture lines (cumulative overwrite, not add; context includes cached;
  partial tail line), index fold (latest wins, bad lines ignored); tracker fan-out: two panes,
  two sessions, one file change → only the renamed pane emits.
- Verify: badge after a turn; rename a thread → pane colour appears (hash) + board/banner name.

### 2c. Resume (`feat(codex): resume codex sessions on relaunch`)

- `codex.ts` `session`: `safeId` UUID regex, `resumeCommand` = `codex resume <id>` (no mode in
  v1, per S1-d), no `cwdFits`.
- `ResumePlan.agent` flows to the banner (label, "Start Codex here", picker command
  `codex resume`).
- Confirm: `app.tsx` already matches `SessionStart` + same `sessionId` from the pane (now any
  agent); for Codex, S1 must show `source: "resume"` keeps the id.
- Preflight in `agents:resume-plan`: transcript exists check works unchanged (the rollout path).
- Tests: ledger with a Codex entry (serialize without `sessionId`, plan builds `codex resume`,
  bad id → skip); `resume-flow` unchanged.
- Verify: Codex in a pane → quit minmux → relaunch → banner → resumed in the right folder.

### 2d. Trust hint (`feat(codex): hint when codex skipped minmux hooks`)

- Store: `agentHint?: { sessionId, kind: "codex-trust" }` + `settings.agents.codex.hintDismissed`.
- terminal-manager: after `agentLaunched = "codex"`, arm a 10 s timer; any Codex hook event
  from that pane cancels it, as does the prompt returning (Codex exited). On fire, set the hint.
  Once any Codex event is seen this profile, never arm again (persist a `seenHooks` flag in
  settings).
- Component: `agent-hint.tsx` modelled on `integration-hint.tsx`, copy per design F18
  ("Approve minmux in Codex to see every running agent live on the Agents board…").
  **Approve in Codex** writes `/hooks\r` to the PTY only when the pane's foreground is Codex
  (launch marker seen, no prompt since). A dismissal counter in the store becomes **Don't
  ask again** after three.
- Tests: the timer logic as a pure function (launch, event, prompt-return, dismissed →
  show/don't show); component render + dismiss.
- Verify: untrusted hooks → hint appears; trust via `/hooks` → relaunch Codex → board fills,
  hint gone for good.

**Phase 2 exit:** F1–F15 for Codex as marked in the design (no worktree chips, root-attributed
sub-agent tools), documented in GOTCHAS `#codex`.

---

## Phase 3 — OpenCode adapter

Depends on S2 (+ Phase 1). Fixture from S2-b drives the tests.

### 3a. Plugin + arming (`feat(opencode): minmux plugin and scoped loading`)

- `electron/agents/opencode-plugin.ts`: the plugin source as a **line array** (like the shell
  scripts), written by `install` to `<cfg>/agents/opencode-plugin.js` (+ a `/mnt/c`-addressed
  config for WSL panes). Plugin behaviour:
  - reads `MINMUX_AGENT_EVENTS` + `MINMUX_PANE_ID` once; absent ⇒ returns `{}` (inert);
  - `event`: switch on `event.type` over the allow-list (`session.created/updated/deleted/
status/idle/error/compacted`, `permission.asked/replied`, `question.asked`, `file.edited`,
    `message.updated`, `server.instance.disposed`), everything else returns at once;
  - `tool.execute.before/after`: record `{tool, sessionID, callID, filePath?}` only;
  - keeps small maps: session → parentID/root, message id → output tokens, root → last
    assistant text (≤200 chars);
  - writes `{v:1, type, sessionID, rootID, parentID?, …projected fields, pid: process.pid}`
    with `fs.promises.writeFile(...).catch(() => {})`, **not awaited**; filename identical to
    the writer's (`<pane>.<pid>.<ts>.<rand>.json`) into `<root>/opencode/`.
- `electron/agents/opencode.ts` `arm`: `OPENCODE_CONFIG_CONTENT` per S2-a (or
  `OPENCODE_CONFIG_DIR` fallback when the user's env doesn't already set it — main can see
  `process.env` after `shell-env.ts` imported the login env).
- Tests: build the plugin source, load it in Vitest via a data-URL `import()` with a fake
  `MINMUX_*` env and a temp dir: feed it synthetic bus events → assert the files written
  (projection has no content fields, filters work, handlers return synchronously / resolve
  without awaiting the write, inert without env).
- Verify + perf (S2-e numbers re-measured with the real plugin): long OpenCode turn, no
  visible slowdown, handler p99 ≪ 1 ms.

### 3b. Normalise + multi-level tree (`feat(opencode): agents board for opencode sessions`)

- `opencode.ts` `normalize`: validate `v:1`, map per design §4.1 (root/child, `parentAgentId`,
  `SubagentStop` on child idle, `pid`), `agent: "opencode"`.
- `session.isSwitch` + lead rule (design F14): ledger learns a per-pane **lead pid** for
  OpenCode; roots from another pid are nested; within the lead pid, the most recently active
  root leads (`UserPromptSubmit` re-points the lead, so the ledger's "switch" needs an
  "activity" input, not only SessionStart; add `SessionRules.leadOnActivity: true`).
- agents-panel: recursive children (indent + connectors per depth, cap 4 levels, "+N").
- Tests: normaliser over the S2 fixture; graph: nested `task` sub-agents form 3 levels, child
  tools attributed to the child; ledger: `/new` switches the lead, a second pid is nested, the
  session picker (activity on an older root) re-points the lead; panel renders depth.
- Verify: an OpenCode run that spawns sub-agents → tree on the board; icon; `in`; PR.

### 3c. Tokens + title (`feat(opencode): token badge and session title`)

- Plugin emits `TokenUsage` drops (accumulated per session, on completed assistant messages)
  and `meta` drops (root `session.updated` title). `opencode.ts` `meta` = pushed source (no
  file watch). Colour per **D3** (default: only a user-set title, per S2-f, else none).
- Tests: accumulation dedupes repeated `message.updated` for the same id; child tokens go to the
  child node; meta routing to the lead pane only.
- Verify: badge, title on board/banner, colour per D3.

### 3d. Resume (`feat(opencode): resume opencode sessions on relaunch`)

- `session`: `safeId` from S2-d, `resumeCommand` = `opencode --session <id>`, `cd` to the
  recorded directory. Confirm per S2-d; if no signal exists, the banner goes to `sent` for
  OpenCode (new `ResumePlan.confirmable: false` → terminal-manager skips the failure timer and
  shows "sent"; the machinery exists for shells without integration).
- Tests: ledger/plan for OpenCode entries; `resume-flow` with `confirmable: false`.
- Verify: quit → relaunch → OpenCode reopens the same session in the right folder.

**Phase 3 exit:** F1–F15 for OpenCode per the design, GOTCHAS `#opencode`.

---

## Phase 4 — Polish and docs

- **Docs:** `ARCHITECTURE.md` (agent adapters in §4/§11), `GOTCHAS.md` (`#codex`, `#opencode`;
  rename `#claude-transcript` scope to "agent internal formats"), `CLAUDE.md` (structure:
  `electron/agents/`; invariant: agent specifics live only in adapters + `agent-kinds.ts`),
  `electron/CLAUDE.md` file list, `ROADMAP.md` 6d → done, README "Agents" row + the Codex
  `tui.notifications` tip, `AGENT_OBSERVABILITY.md` §9 "non-Claude agents" pointer here.
- **Diagnostics:** `hookTrace` includes `agent`; `agent-hooks-up` logs the adapters armed.
- **Mixed-agent pass (`run-minmux`):** Claude, Codex and OpenCode in three panes of one tab,
  plus Claude running `codex exec` (nested, must not steal the pane); close-confirm text for
  the tab; quit → relaunch resumes all three.
- **Follow-ups (separate designs, not in this plan):** hook-driven pane status (fixes §9a,
  needs the test matrix); OpenCode cost display; SSH-pane agents; OTEL for any agent.

---

## Sizing (rough, one engineer)

| Step            | Size    | Notes                                                         |
| --------------- | ------- | ------------------------------------------------------------- |
| Phase 0 (S1–S3) | 1–1.5 d | S1-b / S2-a are the go/no-go answers                          |
| 1a–1e           | 3–4 d   | mostly mechanical; 1c (ledger + shell gen) is the careful one |
| 2a–2d           | 3 d     | small because Codex speaks Claude's hook contract             |
| 3a–3d           | 4 d     | the plugin + multi-level tree + lead-by-pid                   |
| Phase 4         | 1 d     |                                                               |

## Definition of done

- Each agent has a captured-fixture test suite (normaliser → graph → ledger).
- No agent name outside `electron/agents/*`, `src/lib/agent-kinds.ts`, the icons and
  user-facing strings (a `grep -ri claude src electron` review at the end of Phase 1 lists
  every remaining hit with a reason).
- Missing agent binary, untrusted hooks, `--pure`, a disabled switch → empty board and plain
  terminal, never an error or a delay.
- Perf: `MINMUX_PERF=1` harness unchanged with all three agents running (`docs/PERF.md`).
