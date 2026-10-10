# Where an agent works: other checkouts in the sidebar (#58)

Status: **proposal, revised after two reviews** (detection; latency and failure modes) · Scope: `electron/agents/*` (normalisers),
`src/lib/agent-graph.ts`, `src/lib/agent-dirs.ts`, `src/store.ts`, `src/app.tsx`,
`electron/pane-git.ts`, `src/components/sidebar.tsx`

## Problem

The sidebar's `from` / `in` lines follow the shell's folder and the agent's own working folder
(its `cwd`, from hook events). An agent can do most of its work somewhere else without ever
moving.

Case study, transcript `graphics-track`:

- All 1,102 entries carry `cwd: ~/workspace/rts`. Claude never moved.
- Line 132: `git worktree add -b docs/track-e-amendment ../rts-track-e origin/main`, run with the
  Bash tool, so no `WorktreeCreate` hook fires.
- 7 Edits and 22 Writes then target `/Users/…/rts-track-e/…` by absolute path.
- 86 of its 183 Bash calls change that worktree as `cd /Users/…/rts-track-e && …` (Python
  writes, `cp`, `git commit`, `gh pr create`).
- The sidebar shows `rts`'s branch and PR only, so the folder it works in and the PRs it opens
  are invisible.

## Goals

1. Show the checkouts an agent **works in**, when they're not `from`'s or `in`'s, with their
   branch and PR.
2. No setup, on by default, for every agent that reports paths (Claude, Codex, OpenCode).
3. Off the terminal hot path, with a fixed budget of extra git lookups per poll that can never
   crowd out the `from` / `in` lines.
4. When PRs can't show (`gh` missing or not logged in), say why.

## Non-goals

- **Files that were only read.** Reading another repo isn't working in it.
- **General shell parsing.** Only one narrow, unambiguous Bash shape counts (§1).
- **Moving the Changes panel or status bar.** They keep following `from` / `in`.
- **Persisting across relaunch.** In-memory, per pane.

## Design

### 0. Foundations: lookups off main, bounded, never waiting on each other

Measured: launching a process (`git`, `gh`) blocks the calling event loop for about 4 ms. A
poll's burst at today's 64-request cap blocks main, the process carrying all PTY I/O, for about
**400 ms**. Every 10 s poll launches again, because `HEAD_TTL` is 8 s. That's a latent problem
today, and more lookups per pane would make it routine. So before adding keys:

- **Branch / PR lookups run in the fs worker (#112), not main.** A launch's cost lands there;
  main only forwards. The worker also handles the dead-mount and hang cases.
- **Launches are capped at 4 at a time** in the worker, and the `HEAD_TTL` is aligned with the
  poll interval (≥ 12 s), so an unchanged folder isn't relaunched every poll.
- **`from` / `in` answers never wait on slower keys:** `edit` keys and folder → root resolves
  go in a **separate request** that the main poll doesn't wait on (today `lookup()` waits on
  every key together, so one slow path delays every pane).
- **PR lookups have priority:** `from` / `in` first, then `edit`. An **offline breaker** pauses
  `gh` for 1 minute after 3 timeouts in a row, so a dead network can't build a queue that never
  drains.
- **`gh` runs non-interactively and quietly:** `GH_PROMPT_DISABLED=1`, `GH_NO_UPDATE_NOTIFIER=1`.

### 1. Signals: edits, and a narrow Bash prefix (normalisers only)

Each normaliser (`electron/agents/*`, where agent specifics live) sets on `AgentEvent`:

- **`edited?: true`**, by **tool name**, on **PostToolUse** only (the edit happened):
  - **Claude:** `Edit`, `Write`, `MultiEdit`, `NotebookEdit`.
  - **Codex:** `apply_patch`, including every `*** … File:` / `*** Move to:` header, not just
    the first.
  - **OpenCode:** `edit`, `write`, `patch`, with all of `paths`. Its `touched()` also covers
    reads, so the tool name decides, not the presence of a path.
- **`workDir?: string`** for a Bash call whose command starts with exactly
  `cd <absolute path> &&`: no quotes, no `$`, no `~`. That's the shape agents use; anything else
  is ignored. In the case study this covers 100+ commands, including `git commit` and
  `gh pr create`, and it catches sessions that work only through Bash.
- **Paths:** relative paths are resolved against `ev.cwd`, else dropped. Folder names use POSIX
  string rules for a POSIX path (a WSL pane on Windows), never Node's `path` on Windows.
- **Per-agent excludes**, applied in the normaliser so they're dropped at the source: the agent's
  own config and memory folders (`~/.claude`, `~/.codex`, `~/.config/opencode`), the OS temp
  folder, and `node_modules` / build output (a codegen burst mustn't flood the map).

### 2. Per pane: work folders → checkouts

The pane's agent state holds `workDirs`: edited folders (dirnames) and Bash `workDir`s, each with
an **edit count** and a last-seen time.

- **Written to the lead session (`rid`), never to a sub-agent's node.** Sub-agents are pruned
  when they finish, but their work is the lead's.
- **Lifetime: the pane, not the session.** The line keeps showing after `/exit` or `/clear`
  (that's when you want the PR the agent just opened). It goes when the pane closes, or when a
  new session in the pane works somewhere else.
- **Grouped by checkout:** a renderer-side map `folder → root`, filled from git answers:
  - **No lookup inside a known root:** a folder inside a root already known is placed by prefix
    (unless the path holds a worktree marker).
  - **Rootless entries expire after 60 s:** a folder that later gets `git init` / `git worktree
add` shows up.
  - **Removed worktrees clear:** a root whose answer comes back gone is dropped.
  - **Bounded:** an LRU of 512 entries per pane, cleared with the pane.
- **Capped at 8 roots per pane** (not 8 folders: one repo can have many). `+N` counts roots.

### 3. Which checkout shows: ranked, stable

- **Candidates:** roots that aren't `from`'s or `in`'s root.
- **Ranked by work count, ties broken by recency.** The shown root changes only after the
  challenger leads by 2, so a one-off edit elsewhere doesn't take over and the line doesn't
  flicker.
- **Hidden if it has no branch and no PR** (a submodule or detached checkout): nothing useful to
  show.

### 4. Git lookups: a fixed budget, outside `from` / `in`

- **A typed key helper `gitKey(pane, "in" | "edit")`** replaces the string suffix. It's used by
  the store's prune (`store.ts`), `paneOfGitKey`, `settleInAnswers` (the "keep the last answer
  for one poll" rule applies to `edit` too) and `tagShellAnswers`, which must not tag `edit`
  answers. Today's code would silently drop `pane@edit` answers.
- **`planGitPoll` runs in two passes:** every pane's `from` / `in` first, then `edit` keys in
  what's left under the 64 cap. An `edit` key can never crowd out a `from` line.
- **Resolving new folders** (folder → root) costs at most **2 `rev-parse` per poll** across all
  panes, outside the cap. That's cheap, and the answers are cached forever in the renderer map.
- **The `edit` key polls the checkout root, not a folder**, so panes showing the same checkout
  share one cached answer and one `gh` call.
- **A slower rate:** the shown `edit` root is polled every 30 s (or right away when it changes),
  since an edited checkout's branch rarely changes; its PR follows the usual TTLs.
- **The re-poll key** (`app.tsx`) includes each pane's **shown** `edit` root only (stable,
  thanks to the hysteresis), never counts or pending resolves, so a new target appears within
  ~0.4 s and a busy turn doesn't churn polls.

### 4b. Render rules (store invariants)

- **The reducer returns the same `workDirs`** when an event changes nothing that matters, as
  Read events and the like don't.
- **The sidebar selector flattens primitives only:** `[paneId, shownRoot, plusN]`, the way
  `agentWorkFlat` does. Never counts or times: they change on every edit, at up to 20 batches
  a second.
- **`editTarget` is memoised on the pair (graph, root map),** not on the graph alone.

### 5. The sidebar

```
from   main • ~/workspace/rts
edits  docs/track-e-amendment • ~/workspace/rts-track-e   +1
       PR #12 open
```

- **Label:** `edits`. It shows the root's branch, `~`-shortened path and PR line.
- **One `+N`:** Claude's `WorktreeCreate` worktrees and the other worked-in roots are merged into
  a single list, with one tooltip.
- **Folder actions:** the same tooltip and right-click menu as the other folder lines.

### 6. `gh` state, not guessed from spawn errors

Today `pane-git` treats any `ENOENT` from `gh` as "gh is missing" and turns PRs off for
10 minutes. But a deleted folder also gives `ENOENT` (`spawn` with a missing `cwd`), and edited
worktrees are often deleted (`git worktree remove`), so one deleted worktree can hide PRs for
every pane. That's a live bug.

- **Missing:** decided by an **async** PATH lookup of `gh` in the worker, once per environment,
  re-checked every 10 minutes. A synchronous scan could freeze on a network PATH entry. For a
  WSL pane, a cached `command -v gh` inside the distro. Never from a spawn error.
- **An `ENOENT` from `gh`:** if `gh` is on PATH, it's a deleted folder: no PR for that root,
  and the `gh` state is untouched. There's no `stat` before each call: `fs` calls have no
  timeout, and a dead mount would hang a thread.
- **Not logged in:** from `gh pr view`'s **exit code 4** (40 ms, no network), which happens
  anyway. Not `gh auth status`: that goes to the network (about 0.7 s), and it fails if _any_
  configured host has a problem.
- **UI:** answers carry `gh: "missing" | "unauthenticated"`. Every branch line's tooltip says
  "Install GitHub CLI (gh) to see PRs" or "Run `gh auth login` to see PRs" whenever it applies,
  not just once.

## Cost

| What                      | Cost                                                                                                                                                   |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Per keystroke / PTY chunk | nothing                                                                                                                                                |
| Per hook event            | a count update in the pane's map; Bash prefix match on PostToolUse only (anchored regex: ≤ 0.25 ms on 64 KB)                                           |
| Main process              | nothing new: lookups run in the fs worker, at most 4 launches at once                                                                                  |
| Per poll                  | ≤ 2 new `rev-parse` (folder → root, cached); `edit` roots every 30 s, in a separate request; one `gh` per shown root (TTL-cached, after `from` / `in`) |
| Per environment           | one async PATH lookup per 10 minutes                                                                                                                   |

## Edge cases

- **No git root** (`/tmp`, scratch, `~/.claude/...`): excluded at the source or remembered as
  rootless, so never shown.
- **A deleted worktree:** the `stat` before `gh` finds it gone; its root answer drops, and the
  line hides.
- **Symlinks and WSL:** compared by git root (as in #116); POSIX folder rules for POSIX paths.
- **Background (nested) sessions:** they don't own the pane, so they add nothing.

## Alternatives

- **`git worktree list`:** rejected. `rts` has 11 worktrees, so you can't tell which session
  owns which.
- **The PR URL from `gh pr create` output** (Bash PostToolUse `tool_response`): attaches the PR
  to the session with no polling. Worth a follow-up spike, since we don't know whether the hook
  writer keeps that field.

## Plan

0. Foundations (its own PR, which also fixes the live `gh` bug): `pane-git` in the fs worker,
   at most 4 launches at once, `HEAD_TTL` ≥ poll interval, separate requests for slow keys, PR
   priority and offline breaker, `gh` state from an async PATH lookup and exit code 4. Measure
   with `MINMUX_PERF=1` with many panes polling, before and after.
1. Normalisers: `edited` (by tool name), Bash `workDir` prefix, path resolution, excludes; tests
   per agent.
2. `gitKey` helper replacing the `@in` suffix logic everywhere; tests that `edit` answers are
   kept, settled and never tagged as shell answers.
3. Pane-level `workDirs` (lead session, pane lifetime), the folder → root map, ranking with
   hysteresis; pure `editTarget()` + tests.
4. `planGitPoll` two passes + the resolve budget; re-poll key.
5. Sidebar `edits` line, merged `+N`, menu, `gh` tooltip.
6. Real-app check: a scratch repo + a sibling worktree, simulated Edits and
   `cd <abs> && git commit` Bash events there; an `edits` line with its branch; delete the
   worktree and check the PR hint doesn't claim gh is missing.
