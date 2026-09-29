# Design — Agent observability: the live agents & worktrees board

> Surface every running agent minmux launched — the agent, its sub-agents, its worktree, its
> recent file activity, its status — as a first-class **board** in the app, fed by Claude Code's
> **official** extension points (hooks now; OpenTelemetry traces later). Companion to
> `../ARCHITECTURE.md`; supersedes the "control-plane road" caveat in `AGENT_TEAMS.md` §11 for the
> specific case of _official_ telemetry.

Status: **DESIGN / accepted for Phase 1** (2026-07-13). Milestone: see `../ROADMAP.md` → M6.

---

## 1. Goal & the reframe

**Goal.** A panel that answers, at a glance: _which agents are running right now, what is each one
doing, in which worktree, and who spawned whom._ Plus the file/worktree view that falls out of the
same data.

**The reframe that makes this tractable.** A terminal sees only **OS processes + byte streams**, so
the PTY can't observe an agent's _in-process_ sub-agents (the `Task` tool). Earlier design
(`AGENT_TEAMS.md`) treated the sub-agent tree as effectively unreachable without scraping private
state. That was wrong in one important way: **Claude Code emits its own structure through documented,
supported channels** — hooks and OpenTelemetry. Ingesting those is an _integration_, not scraping. So
the agent tree is reachable — just not from the PTY.

**Non-negotiable principle (unchanged).** minmux stays terminal-first. This is an **additive,
opt-in observability layer**, wired only for the shells minmux itself launches; it never becomes a
prerequisite for using the terminal, and it never parses undocumented private files.

---

## 2. Data sources (researched 2026-07-13)

Two official channels, complementary:

### 2a. Hooks → localhost (Phase 1 foundation — stable, real-time)

Claude Code exposes [31 hook events](https://code.claude.com/docs/en/hooks). The ones we consume:

| Event                               | Gives us                                                                                         |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `SubagentStart` / `SubagentStop`    | a sub-agent's `agent_id`, `agent_type`, `agent_transcript_path`, `session_id` — spawn + teardown |
| `TaskCreated` / `TaskCompleted`     | task lifecycle within a session                                                                  |
| `SessionStart` / `SessionEnd`       | the root agent lifecycle                                                                         |
| `WorktreeCreate` / `WorktreeRemove` | **the worktree view, for free**                                                                  |
| `CwdChanged`                        | keeps each agent's cwd live (complements our OSC-7 tracking)                                     |
| `FileChanged`                       | recent file activity per agent → the "file view"                                                 |
| `Notification` / `Stop`             | attention / turn-boundary signals (dovetails with our status engine)                             |

Hooks can be typed **`http`** and POST the event JSON to `http://localhost:<port>`. So minmux runs a
tiny loopback receiver and gets every event **as it happens** (no batching). Common fields on every
event: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`.

**Known gap:** hook input does **not** include an explicit `parent_agent_id`. Lineage within a
session is _inferred_ (see the correlation model in §2b, validated by the spike). Good enough for a
flat "root → sub-agents" grouping; exact multi-level (sub-agent-of-a-sub-agent) parenting comes from
OTEL (2c).

### 2b. Correlation model (validated by the spike — §7)

The real event stream (a headless `claude` that launched one sub-agent) gives a clean two-level
reconstruction with **no** `parent_agent_id` needed:

- **Root agent** = events with **no `agent_id`** (SessionStart, the launching `PreToolUse`, Stop,
  SessionEnd). The session _is_ the root agent.
- **Sub-agent** = events carrying an `agent_id` (+ `agent_type` like `general-purpose`). **Every**
  tool call the sub-agent makes carries its `agent_id`, so all its activity is directly attributable.
- **The parent→child edge:** the root fires `PreToolUse` with `tool_name: "Agent"` (the Task tool is
  surfaced as `Agent`), immediately followed by `SubagentStart{agent_id}` — **same `session_id` and
  same `prompt_id`**. So `(session_id, prompt_id)` ties the launching turn to the sub-agent it spawned.
- **`prompt_id`** groups one turn end-to-end (the sub-agent's whole lifecycle shares the launching
  turn's `prompt_id`); **`agent_id`** identifies which agent. Together they rebuild the per-turn tree.
- **Lifecycle + payload:** `SubagentStart` → sub-agent's `PreToolUse`/`PostToolUse` (with
  `tool_name`, `tool_input`, `tool_response`, `duration_ms`) → `SubagentStop` (with
  `agent_transcript_path` + `last_assistant_message`). `cwd` and `transcript_path` are on every event.

So the `agent-graph` reducer keys agents by `agent_id` (root = the sessionless bucket), attributes
each tool event by `agent_id`, and draws the root→sub edge from the `Agent` `PreToolUse` +
`SubagentStart` pair sharing `(session_id, prompt_id)`. Deeper nesting is the only thing this can't
resolve — that's OTEL's `parent_agent_id` (2c).

### 2c. OpenTelemetry traces → local OTLP receiver (Phase 2 — richer, beta)

With [`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_TRACES_EXPORTER=otlp`,
`CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`](https://code.claude.com/docs/en/agent-sdk/observability)
pointed at a **local** OTLP HTTP endpoint, Claude emits spans:

- `claude_code.interaction` (a turn) → `claude_code.llm_request`, `claude_code.tool`
  (`.execution` / `.blocked_on_user`), `claude_code.hook`.
- **The tree:** _"when the agent spawns a subagent through the Task tool, the subagent's
  `llm_request` and `tool` spans nest under the parent agent's `claude_code.tool` span, so the full
  delegation chain appears as one trace."_ Recent versions also stamp explicit `agent_id` /
  `parent_agent_id` attributes; spans carry `session.id`.
- Bonus: token/cost/latency per span.

**Caveats:** traces are **beta** ("span names and attributes may change between releases"); export is
batched (default 5 s, tunable to 1 s via `OTEL_TRACES_EXPORT_INTERVAL=1000`); needs a recent Claude
Code. **Open question to spike:** confirm the _interactive_ `claude` TUI (not just the SDK / `claude -p`)
emits these trace spans — the observability docs are framed around the SDK. Hooks almost certainly
fire interactively; traces need empirical confirmation before we depend on them.

---

## 3. The zero-setup lever

minmux already injects env + shell integration into the shells it spawns
(`electron/shell-integration.ts`, `pty:spawn`). The user _types_ `claude` themselves, so we can't add
`--settings` to its argv directly — but the injection gives us two clean, scoped hooks:

1. **A `claude` shell wrapper** injected into the interactive shell: a function
   `claude() { command claude --settings <minmux-hooks.json> "$@"; }`. Any `claude` a user runs in an
   minmux pane transparently loads our scoped hook file — **without** touching their global
   `~/.claude/settings.json`. (`--settings` is confirmed working in the spike, §7.)
2. **Telemetry env** (Phase 2) — set `CLAUDE_CODE_ENABLE_TELEMETRY` + OTLP vars pointing at our
   loopback receiver, per the same injection.

The hook file uses `type: "http"` pointing at `http://127.0.0.1:<port>` with a per-launch token
(the spike used `type: "command"` + `curl` to prove the payloads; `http` is the lighter production
form — no per-event subprocess).

Result: the board **just works** for agents started inside minmux, with **no user setup** and no
global config footprint. Agents started outside minmux simply don't appear (acceptable; opt-in).

---

## 4. Architecture

```
  claude (in a minmux pane)
     │  hook fires (SubagentStart, FileChanged, WorktreeCreate, …)
     ▼
  HTTP POST → 127.0.0.1:<port>  (minmux main: hook receiver, electron/agent-hooks.ts)
     │  validate + normalise → AgentEvent
     ▼
  agent-graph reducer (pure, tested — lib/agent-graph.ts)   ← the risky logic lives here
     │  events → { agents: tree keyed by session/agent_id, worktrees, recent files, status }
     ▼  IPC event agents:update → renderer store slice
  Agents board (React) — tree of agents, per-agent worktree + diff + files + status
```

| Component               | Where                                             | Job                                                                            |
| ----------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------ |
| Hook receiver           | `electron/agent-hooks.ts` (main)                  | loopback HTTP server; auth via a per-launch token; parse events                |
| Hook config injector    | `electron/shell-integration.ts` + `pty:spawn`     | scope the hook config to launched panes; pass the port + token                 |
| **Agent-graph reducer** | `src/lib/agent-graph.ts` (**pure, unit-tested**)  | fold the event stream into the agent tree + worktree/file state; infer lineage |
| Renderer bridge         | `lib/ipc.ts` + a store slice                      | `agents:update` → Zustand; drives the board                                    |
| Agents board            | `src/components/agents-panel.tsx`                 | render the tree; reuse status-ui + git diff panel + session-label              |
| Reuse (unchanged)       | git.ts, session-status, use-active-cwd, status-ui | worktree diffs, status dots, cwd — all already exist                           |

Design rule (matches repo conventions): **the parsing/folding is a pure reducer** in
`lib/agent-graph.ts` with a real test matrix; the HTTP plumbing and React are thin.

---

## 5. Phasing

- **Phase 1 — Hooks board (this milestone).** Loopback hook receiver + injection + `agent-graph`
  reducer + the board. Delivers: live agents/sub-agents grouped per session with type & status,
  each agent's worktree + live git diff, recent files, and worktree create/remove — i.e. **both the
  agents view and the file/worktree view**. Stable, real-time, zero user setup.
- **Phase 2 — OTEL trace overlay (later, opt-in, flagged beta).** Local OTLP receiver adds exact
  multi-level parent→child lineage + token/cost/latency. Gated behind a setting; degrades to Phase 1
  if telemetry is off or the interactive-CLI spike fails.
- **Phase 3 — cross-agent generalisation (future).** The reducer is agent-agnostic; other agents
  that emit OTEL or a documented hook contract can populate the same board.

---

## 6. Risks & open questions

- **Interactive-CLI emission (spike first).** Confirm hooks fire and (for Phase 2) traces emit from
  the interactive TUI, not only the SDK. Blocks nothing in Phase 1 if hooks fire (expected).
- **Lineage from hooks is inferred**, not exact — fine for grouping; exact tree is Phase 2.
- **Beta trace schema churn** — keep OTEL parsing isolated and version-guarded; never let it break
  Phase 1.
- **Claude-specific** — acceptable for v1; the reducer stays agent-agnostic for Phase 3.
- **Security** — loopback only, per-launch token, no content logging by default (don't set
  `OTEL_LOG_*` / tool-content hooks). The board shows structure, not prompt/file contents.
- **Version floor** — needs a recent Claude Code; detect and degrade gracefully (no hooks → empty
  board, not an error).

---

## 7. Spike results (2026-07-13) — validated ✅

Wired a throwaway `type: command` + `curl` hook (all lifecycle events) into a **scoped**
`--settings` file and ran a headless `claude -p` (v2.1.207, `--model claude-haiku-4-5`) that launched
one `general-purpose` sub-agent in a sandbox dir. **18 hook events fired**, full lifecycle. Findings:

- ✅ **Hooks fire reliably**, scoped via `--settings` — **no global config touched**. Confirms §3.
- ✅ **`SubagentStart` / `SubagentStop` fire** with `agent_id` + `agent_type` (`general-purpose`),
  and `SubagentStop` carries `agent_transcript_path` + `last_assistant_message` (1 KB final summary).
- ✅ **Every sub-agent tool call carries the `agent_id`** → activity is directly attributable per agent.
- ✅ **Root→sub edge is reconstructable** without `parent_agent_id`: root `PreToolUse{tool_name:"Agent"}`
  → `SubagentStart` share `(session_id, prompt_id)`; the sub-agent's whole lifecycle shares that
  `prompt_id`. (The correlation model in §2b is taken straight from this run.)
- ✅ **Rich payloads**: `tool_name`, `tool_input`, `tool_response`, `duration_ms`, `cwd`,
  `transcript_path` on the relevant events — enough for the board without enabling any content logging.
- ⚠️ **No `parent_agent_id`** in hook input (as predicted) → deeper-than-one-level nesting needs OTEL.
- ⚠️ Ran **headless** (`claude -p`); the interactive TUI uses the same hook engine so emission is
  near-certain — cheap to confirm by running interactive `claude --settings <hooks>` once (6a).
- Note: the Task tool surfaces as **`tool_name: "Agent"`** (not `"Task"`) in `PreToolUse`.

**Conclusion:** Phase 1 (hooks board) is de-risked — the data is present, attributable, and scopeable.
Proceed to build `agent-graph` against the shapes captured here.

## 8. Performance & safety (hard requirements for 6b)

Hooks run in the `claude` process over a **separate loopback socket** — they never touch minmux's
PTY→xterm render path, so **no terminal lag**. But hooks are **synchronous to Claude's agent loop**
(it waits, bounded by the hook `timeout`), so the receiver must not slow the agent either:

- **Ack instantly.** Return `200 {}` immediately; do all reduce/IPC work on the next tick — never
  block the HTTP response on git/disk/IPC.
- **`http` hooks** (no per-event subprocess) + the **leanest event set** that feeds the board (drop
  per-tool `PreToolUse`/`PostToolUse` if "current tool" isn't worth a round-trip each).
- **Cap the hook `timeout` (~2–3 s)** as a backstop: a slow/down receiver must let Claude proceed,
  never hang it. Receiver down / minmux not running → connection refused instantly → no delay.
- Reduce in **main**; push to the board over an IPC channel **separate** from terminal data, and
  throttle board updates. Nothing agent-observability-related may sit on the render hot path.

## 9. Out of scope

- Reading undocumented private state files (the control-plane road we still reject).
- Driving/orchestrating agents from minmux (this is _observe_, not _control_).
- Non-Claude agents in v1 (the mechanism generalises later — §5 Phase 3).
