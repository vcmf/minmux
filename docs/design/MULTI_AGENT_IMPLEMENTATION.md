# Implementation plan — Multi-agent support (Codex, OpenCode)

> How to build `MULTI_AGENT.md`, as PR-sized steps. Each step names its scope, the files it
> touches, the constraints it must meet, its tests and its real-app check. Mechanics (exact
> code, syntax, layouts) are decided in the PR itself. Feature ids (F1–F18) and spikes
> (S1–S3) refer to the design doc.

Status: **PLAN** (2026-10-01). Order: Phase 0 spikes (done) → Phase 1 refactor (Claude only)
→ Phase 2 Codex → Phase 3 OpenCode → Phase 4 docs. Phases 2 and 3 are independent once
Phase 1 lands.

## Ground rules for every PR

- `make fmt && make check` green (tsc renderer + electron, eslint, prettier, Vitest).
- Conventional commit; PR title with its emoji (CLAUDE.md).
- Performance: nothing on the PTY → renderer path; main-process work async and coalesced;
  hooks never block an agent's loop; the OpenCode plugin never awaits I/O in a handler.
- Invariants: same-reference store returns when unchanged, `useShallow` selectors return
  primitives, persisted files stay readable by older builds and never lose what a newer build
  wrote.

**Workflow per PR:** plan → implement → `/code-review high`. One round to start. A round that
finds a **severe problem in the code** means fix + another round; moderate/low findings → fix
what's worth it and stop. Three or more rounds → stop and check the design. Findings against
docs never trigger another round. Before pushing, verify in the real app (`run-minmux`) when
the PR touches terminals, rendering or agent integration.

## PR plan (13 PRs)

| #   | PR (title without emoji)                                                     | Steps   | Depends on | Status     |
| --- | ---------------------------------------------------------------------------- | ------- | ---------- | ---------- |
| 0   | `docs(agents): multi-agent design, implementation plan and spike results`    | Phase 0 | —          | in review  |
| 1   | `refactor(agents): tag events and nodes with the agent kind`                 | 1a      | 0          | open (#90) |
| 2   | `refactor(agents): per-agent drop folders, drop root from env`               | 1b      | 1          |            |
| 3   | `refactor(agents): move claude specifics behind an adapter`                  | 1c      | 2          |            |
| 4   | `refactor(ui): agent-neutral presence, icon and labels` + per-agent settings | 1d + 1e | 3          |            |
| 5   | `feat(codex): agents board for codex sessions`                               | 2a      | 4          |            |
| 6   | `feat(codex): token badge and thread name`                                   | 2b      | 5          |            |
| 7   | `feat(codex): resume codex sessions and hint when hooks aren't approved`     | 2c + 2d | 5          |            |
| 8   | `feat(opencode): minmux plugin and scoped loading`                           | 3a      | 4          |            |
| 9   | `feat(opencode): agents board for opencode sessions`                         | 3b      | 8          |            |
| 10  | `feat(opencode): token badge and session title`                              | 3c      | 9          |            |
| 11  | `feat(opencode): resume opencode sessions on relaunch`                       | 3d      | 9          |            |
| 12  | `docs: architecture, gotchas, claude.md, roadmap and readme for multi-agent` | Phase 4 | all        |            |

Rough size (production / test LOC): refactor ~600 new + ~350 moved / ~740; Codex ~600 / ~650;
OpenCode ~700 / ~680. Hardest parts: the OpenCode plugin, the lead rules, the meta tracker.

---

## Phase 0 — Spikes (done)

Results in `MULTI_AGENT.md` §9; captured streams in `src/test/fixtures/agents/`.

- **S1 Codex hooks** (2026-09-30): additive `-c` hooks, env inherited, trust keyed by
  definition hash with no folder, sub-agent tool events carry `agent_id`. **Open:** S1-e
  (quoting on native Windows / WSL, before PR #5 ships Windows), S1-f (`codex resume` from
  another folder) and S1-g (user rename vs automatic name), both before PR #7.
- **S2 OpenCode plugin** (2026-10-01): inline config merges plugins, two-level tree by default,
  no quit event, resume visible only as the plugin starting, renames detectable by order.
  **Open:** whether `opencode --session <bad id>` exits (before PR #11).
- **S3 Terminal ergonomics** (1–2 h, in the dev build, any time before Phase 4): Shift+Enter,
  image paste, light/dark, mouse + click-to-open, titles, bell / OSC 9, focus across splits in
  both TUIs. Code only if something breaks.

---

## Phase 1 — Refactor (Claude only)

Gate: existing tests pass (renames aside) and a `run-minmux` pass shows Claude unchanged:
board, sub-agents, icon, snippet, `in` + PR, `/color` + `/rename` accent, tokens, quit →
relaunch → resume. User-visible exceptions are named in the PR: PR #1's waiting-state fix and
PR #4's Settings group.

### 1a. Agent kind in the graph — PR #1 (open, #90)

Done: agent kind on events and nodes, canonical event names, explicit parents with
re-parenting, subtree prune/evict, PermissionRequest → waiting, `agentPanes`.

### 1b. Per-agent drop folders, drop root from env — PR #2

- **Scope:** `hook-writer.ts` (writer takes the root from the env and the agent from its
  arguments; no-op without the env), `agent-hooks.ts` (watch one level of subfolders; the
  folder names the agent; unknown folders ignored; the watcher stays agent-free), `main.ts`
  (create the agent folders, set `MINMUX_AGENT_EVENTS` per pane), `shell-integration.ts`
  (forward it into WSL), `profile.ts` (scrub list), the `run-minmux` driver's `dropHook`.
- **Constraints:** Claude's hook definition stays valid in WSL panes (keep a WSL definition if
  it embeds a path); the WSL value of `MINMUX_AGENT_EVENTS` is the translated Windows path.
- **Tests:** writer path from env + agent, no-op without env; watcher tagging, unknown folders,
  claim/sweep dedup across subfolders; the WSL env list.
- **Verify:** the Claude board fills in a native pane (and a WSL pane if a Windows box is
  available).

### 1c. Adapter registry in main — PR #3

- **Scope:** new `electron/agents/` (adapter types, registry, `claude.ts` holding today's hook
  settings, arming, normaliser, token and name sources, resume rules); `main.ts` loops the
  registry; `agent-sessions.ts` takes per-agent rules and the per-agent files (design §4.5);
  `shell-integration.ts` generates wrapper blocks from adapter metadata.
- **Constraints:** Claude's generated rc text is byte-identical to today's; Claude's ledger file
  is byte-identical; a pane with entries in two files resolves to the newest.
- **Tests:** existing Claude tests move alongside; ledger: an entry without `agent` loads as
  Claude, other agents' entries live in their own file and survive a Claude-only rewrite,
  newest-wins across files, a different agent's SessionStart while a lead is live is nested;
  rc snapshot.

### 1d + 1e. Agent-neutral renderer + per-agent settings — PR #4

- **Scope:** `src/lib/agent-kinds.ts` (labels, commands, worktree layouts), an agent icon
  component, renames (`claudeWorkDirs`, `claudeActive/Started/Exited`, `claudeSeen`,
  `CLAUDE_COLORS`, close-confirm and resume-banner strings, agents-panel icon and empty state);
  settings `agents.<kind>.enabled` (default on, D2) read at spawn; Settings "Agents" group;
  `resumeBypassPermissions` labelled Claude-only.
- **Tests:** rename-only updates; close text for a Codex and a mixed tab; worktree layout
  applies only to its own agent; settings merge/validate; spawn env includes only enabled
  agents.

**Phase 1 exit:** the gate above; ROADMAP 6d → in progress.

---

## Phase 2 — Codex

Fixtures: `codex-exec.jsonl`, `codex-tui.jsonl`.

### 2a. Arming + normaliser — PR #5

- **Scope:** `electron/agents/codex.ts` (hook overrides for the events in design §4.1,
  normaliser, lead rule by process), the generated `codex()` wrapper, the launch marker in
  terminal-manager (display-only).
- **Constraints:** hook definitions byte-stable across launches and panes (trust); arguments
  reach Codex intact (paths with spaces and quotes); the marker goes only to the terminal,
  never into stdout or `$(…)`; no hook blocks an interactive key; settings `/hooks` would list
  as "Issues" avoided; Windows quoting per S1-e before Windows ships.
- **Tests:** normaliser over both fixtures (mapping, `apply_patch` paths, bounded input, junk →
  no throw); graph over the fixtures (sub-agent tools on the sub-agent, waiting on
  PermissionRequest, idle on Interrupt, a stray SessionEnd ignored); definition stability;
  wrapper argument round-trip; lead rule (`/new` in the same process = switch, another process
  = nested).
- **Verify:** sandbox HOME with Codex authed and hooks approved: board with status and
  sub-agent, Codex icon, `in`, PR, close text; Claude in another pane unaffected.

### 2b. Tokens + thread name — PR #6

- **Scope:** Codex token source from the rollout (incl. the context window shown as fill), a
  shared-index name source (one watcher, fan-out by session), the meta tracker generalised to
  per-pane, shared and pushed sources.
- **Constraints:** D3: names shown, no colour until S1-g settles user renames.
- **Tests:** token fold (cumulative output, context incl. cache, partial last line); index fold
  (latest wins, junk ignored); fan-out to the right pane only.
- **Verify:** badge after a turn; thread name on board and banner; no colour from an automatic
  name.

### 2c + 2d. Resume + approval hint — PR #7

- **Scope:** Codex resume rules (`codex resume <id>` after `cd`), banner labels per kind; the
  approval hint (design F18) with its timer logic and per-definition seen-set.
- **Constraints:** S1-f checked first; the hint never writes to the PTY.
- **Tests:** ledger/plan for Codex entries (bad id → skip); hint logic as a pure function
  (launch, event, prompt return, dismissals, definition change); component render.
- **Verify:** quit → relaunch → resumed in the right folder; unapproved hooks → hint; approve →
  hint gone; changed definition → hint back.

**Phase 2 exit:** design F1–F15 for Codex (no worktree chips); GOTCHAS `#codex`.

---

## Phase 3 — OpenCode

Fixtures: the S2 streams for designing the projection; PR #8 regenerates them through the real
plugin.

### 3a. Plugin + arming — PR #8

- **Scope:** the plugin source (kept as reviewable text in `electron/agents/`, written once per
  launch), `opencode.ts` arming, the merge of a user's own `OPENCODE_CONFIG_CONTENT` (rc tail
  for zsh/bash, env for other shells).
- **Constraints:** filter first, never await I/O, report busy/idle on change only, project
  (no content beyond the bounded last reply), versioned drops, a `started` drop at init,
  session directory on every root event, parent id whenever known, a proper `file:` URL;
  inert without the minmux env.
- **Tests:** the plugin loaded in Vitest with a fake env: projection has no content, filters,
  handlers don't await writes, inert without env; config merge (absent, present, no `plugin`,
  unparseable, re-exported by the user's rc).
- **Verify + perf:** long OpenCode turn, handler p99 ≪ 1 ms; user plugins still load.

### 3b. Normaliser, tree and lead rules — PR #9

- **Scope:** `opencode.ts` normaliser, the lead rule by process with switches on activity, the
  process liveness check (design §4.4), recursive children in the agents panel.
- **Tests:** normaliser over regenerated fixtures; graph: two-level default plus a synthetic
  three-level stream; ledger: `/new` switches, a picked older session leads once active, a
  second process is nested, a dead process frees the pane (fish case); panel depth.
- **Verify:** sub-agents on the board; icon; `in`; PR; quit OpenCode in a fish pane, then run
  `claude` there → Claude leads.

### 3c. Tokens + title — PR #10

- **Scope:** plugin token accumulation and title reporting; pushed name source; main decides and
  persists "user-named" (design F12).
- **Tests:** dedupe per message; child tokens on the child; user-named rules (before/after first
  prompt, after resume).
- **Verify:** badge; title on board/banner; colour only after `/rename`, kept after relaunch.

### 3d. Resume — PR #11

- **Scope:** OpenCode resume rules (`opencode --session <id>` after `cd`), confirm on "started
  and kept running".
- **Constraints:** check what a bad id does first.
- **Tests:** ledger/plan for OpenCode entries; confirm logic.
- **Verify:** quit → relaunch → the same session reopens in the right folder.

**Phase 3 exit:** design F1–F15 for OpenCode; GOTCHAS `#opencode`.

---

## Phase 4 — Docs and the mixed pass — PR #12

- `ARCHITECTURE.md`, `GOTCHAS.md` (`#codex`, `#opencode`; widen `#claude-transcript` to agent
  internal formats), `CLAUDE.md` (structure + the adapter invariant), `electron/CLAUDE.md`,
  `ROADMAP.md` 6d → done, README (agents row, Codex notifications tip),
  `AGENT_OBSERVABILITY.md` pointer.
- Diagnostics name the agent.
- Mixed pass (`run-minmux`): Claude, Codex and OpenCode in one tab; close text; quit →
  relaunch resumes all three.
- Follow-ups, separate designs: hook-driven pane status (ARCHITECTURE §9a), OpenCode cost,
  SSH-pane agents, OTEL.

## Definition of done

- Each agent has a fixture-driven test suite (normaliser → graph → ledger).
- No agent name outside `electron/agents/*`, `src/lib/agent-kinds.ts`, icons and user-facing
  strings (a grep at the end of Phase 1 lists every remaining hit with a reason).
- Missing binary, unapproved hooks, `--pure`, a disabled switch → empty board and a plain
  terminal, never an error or a delay.
- `MINMUX_PERF=1` harness unchanged with all three agents running.
