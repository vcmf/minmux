# Agent processes: what each agent session is running

## Problem

The agents board shows each session and its sub-agents, but not the processes they start. A
Claude session runs test suites, dev servers, watchers and one-off builds, often in the
background; Codex and OpenCode do the same. Today there is no way to see which of them are still
running, what they listen on, or which agent started them, short of `ps` and guesswork. A dev
server an agent left behind keeps its port; a forgotten watcher keeps a core busy.

## Goals

- Under each session in the Live tab, the processes its agent started: command, pid, CPU,
  memory, how long it has run, and (step 2) the ports it listens on.
- Attributed to the agent session that started them, including processes that detached from the
  tree (`nohup … &`, daemons).
- Kill one (with its children), and open a listening port in the browser.
- Processes left running after their agent ended are shown as such, under their pane.
- Cheap: nothing runs while no process list is visible, never in main's terminal path.

Not in scope: which sub-agent started a process (sub-agents run inside the agent's own
process); a history of processes that already exited (polling sees what's running now); Windows
and WSL (different tools; later, as for the rest of the agents board); remote (ssh) panes.

## Measured

On a Mac with 617 processes:

| Command                                                 | Time       |
| ------------------------------------------------------- | ---------- |
| `ps -axo pid,ppid,pgid,etime,%cpu,rss,comm`             | ~30 ms     |
| `ps -axww -o pid,ppid,command` (full command lines)     | ~30 ms     |
| `ps -axEww -o pid,ppid,command` (with environments)     | ~40 ms     |
| `lsof -nP -iTCP -sTCP:LISTEN` (listening ports, step 2) | 100–300 ms |

`ps -axE` showed `MINMUX_PANE_ID` in 28 processes, one of them a `node` re-parented to PID 1:
exactly the detached case the tree alone loses. (`-e` instead of `-E` printed only 3.) Some
processes expose no environment (the pane's own login zsh), so the tree stays the primary source.

## Attribution

Each poll builds one snapshot `pid → { ppid, pgid, command, cpu, rss, started, env pane }` and
attributes each process to at most one agent session, in this order:

1. **The process tree.** Main knows each pane's shell pid (its PTY). Every descendant of it belongs
   to that pane. Within the pane, a process belongs to its nearest **agent ancestor**: the agent
   processes are Codex's and OpenCode's own pids (from their hook drops, as `agent-procs.ts`
   records them) and, for Claude, the `claude` process under the pane's shell (its pid isn't in
   Claude's hook drops). Which session that agent process leads comes from the agent graph.
2. **The pane marker.** A process outside every pane's tree whose environment has
   `MINMUX_PANE_ID=<pane>` was started from that pane and detached (`nohup`, a daemon). It is
   attributed to that pane's agent (when one runs there) and marked **detached**.
3. Anything else isn't shown.

The agent process itself and its own helpers (Claude's tool shells, MCP servers it runs) are
listed too: they are part of what it runs. The list is a tree (children under parents), so a
`bash` running `npm test` running `node` reads as one item with its children.

When an agent session ends, processes still attributed to its pane (by tree or marker) stay
listed under the pane as **left running**, until they exit or are killed.

## Polling and cost

- Only while some process list is expanded on screen (the Live tab open and a session's
  "processes" row expanded). Every 2.5 s; ports every 10 s (step 2).
- One `ps -axEww` per poll, run by the sessions worker (`minmux sessions` utility process), which
  parses it and builds the attribution from the pane roots and agent pids main sends with the
  request. Main forwards the result; the renderer receives only the expanded sessions' lists.
- A poll still running when the next is due is skipped, never stacked. A `ps` over 2 s is killed
  and the list says it couldn't refresh.

## Actions

- **Kill:** SIGTERM to the process and its descendants (deepest first), SIGKILL after 3 s for the
  ones still there. Main re-checks at click time that the pid is still the same process (same
  start time as in the snapshot) and still attributed to that session, so a reused pid is never
  signalled. Processes not owned by the user aren't offered.
- **Open port** (step 2): `http://localhost:<port>` in the OS browser, through the existing link
  opener.

## UI

In the Live tab, each session block gets a row **"N processes"** (with the total CPU when it's
notable), collapsed by default. Expanded, it lists the tree:

```
▾ 4 processes · 63% CPU
   node  vite --port 5173        12%  210 MB  4m   :5173 ↗   ✕
   bash  npm test                 0%    3 MB  1m             ✕
     node  vitest run            51%  480 MB  1m             ✕
   node  server.js  (detached)    0%   40 MB  2h   :8080 ↗   ✕
```

Under a pane whose agent has ended, a **"left running"** group shows what's still attributed to
that pane, with a "kill all" action.

## Tests

The snapshot parser (`ps` output, macOS and Linux formats), the attribution (tree, nearest agent
ancestor, nested agents, detached by marker, pid reuse) and the kill plan (descendants deepest
first, start-time check) are pure functions with fixtures. The worker op and client get the same
coverage as the sessions search. Real app: an agent fixture that starts a background server and a
detached one; both listed under its session, killed from the list.

## Plan (one PR each, into `epic/agent-processes`)

1. **Processes per agent session** (#150): the snapshot, the attribution, polling while expanded, the
   tree in the Live tab, kill.
2. **Ports and leftovers** (#151): listening ports with open-in-browser, the "left running" group after
   an agent ends.
