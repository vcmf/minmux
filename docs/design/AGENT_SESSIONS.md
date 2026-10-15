# Agent sessions: find, search and resume past conversations

## Problem

The agents panel shows the sessions running now. A conversation from yesterday, or one in another
repo, is only reachable by remembering its folder, `cd`-ing there and using the agent's own picker
(`claude --resume`, `codex resume`, OpenCode's `/sessions`), one agent at a time. Finding "the
session where we fixed the quit drain" means grepping gigabytes of JSONL by hand. And nothing says
whether that session is already open in some pane, so it's easy to resume it twice.

## Goals

- A **Sessions** tab in the agents panel: recent Claude, Codex and OpenCode sessions, newest
  first, each with its name (or first prompt), short id, folder and when it was last used.
- **Click a session** that isn't running: a split opens beside the focused pane, in the session's
  folder, and the agent's resume command is typed at the first prompt.
- **Click a session that is running** (in any pane, any group): minmux goes to that pane.
- **Search** the conversations for the exact words typed, ignoring case.
- Zero setup, on by default, and nothing on the terminal hot path: the tab reads nothing until it
  is opened, and the search runs only while you type.

Not in scope: deleting, renaming or exporting sessions; sessions on a remote (ssh) host; Windows
and WSL (the transcripts live inside the distro; a later step, as for the agent integrations).

## UI

The agents panel header gets two tabs: **Live** (today's board, unchanged) and **Sessions**.

```
┌ Agents ───────────── Live · Sessions ┐
│ [search conversations…            ]  │
│ All  Claude  Codex  OpenCode  ☐ here │
│ ● fix quit drain        2f81aa5c  2m │  ● = running: click goes to its pane
│   ~/workspace/term                   │
│   readme refresh        8b6deda1  1d │  click: resume in a split here
│   ~/workspace/term                   │
│   ⚠ folder gone         c0d35d8e  9d │  disabled, says why
└──────────────────────────────────────┘
```

- **Row:** agent icon, name, short id, relative time, folder below it (`~`-abbreviated). The name
  is the user's `/rename` when there is one, else the agent's own title, else the first prompt
  (one line, truncated). The full id is in the tooltip and a copy action.
- **Filters:** agent chips, and "here" (only the focused pane's folder and below). Both persist per
  window like the panel's other toggles.
- **Search:** results replace the list while the box has text, each with the matched line as a
  snippet (the words highlighted). Typing again cancels the running search. Esc clears it.
- **States:** "running" (dot, click jumps), "resumable", "folder gone" (disabled), and for a
  session minmux can't resume safely (an id that fails the agent's id check) "can't resume" with
  the reason.

## Data: one reader per agent, all in main

Rows come from main over one channel, `agents:sessions` (list) and `agents:sessions-search`
(search, below). Each agent gets a reader in `electron/agents/*` (agent specifics stay there), and
a shared module `electron/agent-sessions-index.ts` merges, sorts and caches.

```ts
interface PastSession {
  agent: AgentKind
  sessionId: string
  name?: string // the user's rename, else the agent's title
  firstPrompt?: string // fallback label, one line, ≤ 200 chars
  cwd?: string // where it ran (resume needs it)
  updatedAt: number // ms
  cwdGone?: boolean // the folder no longer exists
}
```

### Claude

`~/.claude/projects/<folder>/<id>.jsonl`, top level only (`<id>/subagents/` holds sub-agent
transcripts, which aren't sessions to resume). Per file:

- `updatedAt` = the file's mtime.
- **Head** (first 64 KB): the first `cwd` field and the first user prompt.
- **Tail** (last 64 KB): the latest `custom-title` (the user's `/rename`; Claude re-appends it as
  the session goes on, so the tail has it) folded with `addMetaLine` from `transcript-meta.ts`.

So a 100 MB transcript costs two 64 KB reads. Cached by `(path, size, mtime)`: a reopen only reads
files that changed. `CLAUDE_CONFIG_DIR` is honoured as the agent integration already does.

### Codex

- `~/.codex/session_index.jsonl`: `{ id, thread_name, updated_at }` per thread, latest line wins
  (the existing `addThreadNameLine` fold).
- `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`: the first line is `session_meta` with
  `cwd` (it also carries the base instructions, so the read is capped at 256 KB). Rollouts not in
  the index (no thread name yet) are listed from the walk, named by their first prompt.
- `archived_sessions/` is skipped. `CODEX_HOME` is honoured.

### OpenCode

`~/.local/share/opencode/opencode.db` (SQLite, OpenCode 1.18), opened **read-only** with
`node:sqlite` (Electron 43 ships Node 24: no new native module):

```sql
select id, title, directory, time_updated from session
where parent_id is null and time_archived is null
order by time_updated desc limit 500
```

`DatabaseSync` is synchronous, and main also carries terminal data, so every query runs in a
`worker_thread`. A missing table or column (OpenCode changed its schema) makes OpenCode's part of
the tab say so; it never throws. OpenCode's placeholder titles (`New session - …`, the existing
`isDefaultTitle`) fall back to the first prompt.

## Running or not

The renderer already knows: a root node `agents.nodes["root:" + sessionId]` with a `paneId` whose
terminal still exists is that session, live in that pane. The rows take that from the store, so a
session that starts or ends updates its row without asking main. Clicking a running row does what
the Live tab does: `focusSession(paneId)` and `TerminalManager.focus(paneId)` (switches group,
brings a hidden surface forward).

## Resume

The resume flow minmux uses on relaunch already does everything a click needs:

1. The renderer asks main for a plan: `agents:resume-one({ agent, sessionId, cwd })`. Main builds
   it with the agent's own `resumeCommand` / `resumeEnv` (ids checked against `SAFE_ID` /
   `SESSION_ID`, cwd checked for control characters and existence), so the command is never built
   from renderer strings. The permission mode isn't carried over: a resumed session starts in the
   user's default mode.
2. `openFolderInSplit(cwd)` opens the split; the new terminal is the tab's active one.
3. In the same tick, `setResume(newId, { phase: "pending", plan })`: the new terminal waits for its
   first prompt mark, types `cd -- '<cwd>' && <command>` (`typeResume`), and the banner confirms on
   the session's `SessionStart`, or offers a retry. Shells without the integration get the timed
   fallback, as on relaunch.

A double click while the first resume is still pending goes to the pane that is resuming it.

## Search

`agents:sessions-search({ query, agents, here })` streams results back on
`agents:sessions-hit` with a request id; a new query cancels the previous one.

- **Matching:** case-insensitive, exact substring, at least 2 characters. Only what the user and
  the agent wrote counts (user prompts, assistant text), never tool output, file contents or JSON
  keys: a candidate line is parsed and the words must be in its text fields.
- **Claude and Codex:** `rg --json -i -F` over the transcript files, newest first, when `rg` is on
  the PATH; otherwise a `worker_thread` streams the files line by line. The query is searched in
  its JSON-escaped form (`JSON.stringify(q).slice(1, -1)`), so quotes and backslashes match what's
  on disk, and each hit is verified on the parsed line.
- **OpenCode:** the same worker runs
  `select session_id, data from part where instr(lower(data), lower(?)) > 0` and verifies text
  parts the same way.
- **Bounds:** 300 ms debounce, stops at 50 sessions, at most one hit snippet per session (±60
  characters around the match), killed on a new query, on closing the tab, and after 20 s.

## Performance and failure modes

- Nothing runs until the Sessions tab is shown. No polling: the list refreshes when the tab opens
  and when a refresh button is pressed. Running state comes from the store.
- Every read is async in main (`fs.promises`, a child `rg`, a worker); main never blocks on a
  transcript or the database. Lists over 500 rows are cut (newest first).
- A file that fails to parse, a locked database, a missing `rg`: that source is skipped and the
  tab says so in a footer line; the other agents still list.
- Measured with the `MINMUX_PERF=1` harness before each step lands: list on a cold cache, list on
  a warm cache, a search over the full corpus, with a busy terminal in another pane.

## Tests

Pure parsers with fixtures: Claude head/tail meta, Codex index + `session_meta`, OpenCode rows,
the hit verifier (text fields only, JSON escaping, case), the merge/sort/limit. Renderer: row
states (running, resumable, folder gone), click → jump vs resume plan, filters. Real app
(`run-minmux`, sandboxed HOME with fixture transcripts): resume in a split, jump to a running
session in another group, search across agents.

## Plan (one PR each, into `epic/agent-sessions`)

1. **Sessions tab for Claude and Codex** (#140): the tab, the readers, running rows jump, others resume
   in a split; agent chips and "here".
2. **Search** for Claude and Codex (#141): `rg` with the worker fallback, snippets, cancellation.
3. **OpenCode** (#142): the database reader in a worker, for both the list and the search.
