# Fleet graph

Design canvas (mock-ups, interactive): https://claude.ai/artifact/LvoCFEHWbDffeYabqVGEx3

## Problem

minmux shows agents in two places that don't meet. The agents panel lists sessions by group,
with status and sub-agents; the pull requests dialog shows PRs per repo, with the panes that have
them checked out. With a dozen agents across five repos, the questions that matter are spread
over both and the sidebar:

- Which repos have work going on right now, and where is someone waiting for me?
- Which PR is each agent working on, and which of my PRs have nobody on them?
- What is a given agent doing, with which sub-agents, MCP servers and skills?

## Goals

- A **Fleet tab** in the top bar, opened from a **Fleet view** button in the agents panel. A
  second click switches to the tab when it's already open.
- An **exploration graph**. It opens on one circle per repo (its default branch). Clicking a
  repo opens its graph: PRs around it, the agents working on each PR, their sub-agents. The
  other repos dock in a strip at the top; one repo is open at a time.
- **Gentle motion**: the open graph turns very slowly while the mouse is idle, dots run along
  the lines of working agents. Moving the mouse stops it, hovering freezes it, dragging pins a
  node.
- A **side panel** for the selection: all repos, one repo (its PRs and sessions), or one agent
  (where it runs, what it's doing, context, sub-agents, MCP servers and skills used vs loaded).
- An **inventory** of MCP servers and skills per agent kind: use counts, and the ones loaded but
  never used, over the live sessions or the last 7 or 30 days.
- **Performance** first: nothing runs while the tab isn't shown, no new GitHub query types,
  nothing on the terminal path, and no extra WebGL context.

Not in scope: the pull requests dialog becoming a tab (a later epic, reusing this one's view
tabs), tab-number shortcuts, history of past sessions (the agents panel has it), plain
terminals without an agent, agents on SSH hosts (none are armed there, so they send no events),
search and filters inside the graph, zoom.

## View tabs

A top-bar tab today is a pane tree (`Tab.root`), with `activeSessionId` naming its terminal
(empty for a folder-only tab). Much of the code reads the active tab's panes to decide what's on
screen, what has focus and what the user is looking at. The fleet has no panes, so it gets a new
kind of tab beside the terminal ones instead of living inside one.

### Model

- A **view tab** has a kind (`fleet` now, `pulls` later) and no panes. There is at most one of
  each kind, which is what makes "click again, switch to it" fall out naturally.
- Terminal tabs stay in `tabs` unchanged. View tabs live beside them, after the terminal tabs,
  in the order they were opened, in their own container: the tab drag list (shared with the
  sidebar) and its gap indices only ever see terminal tabs, so nothing can be dropped onto or
  joined into a view tab. Dragging view tabs among the others waits for a second kind (the
  pulls epic), when a bar order would earn its keep.
- `activeTabId` keeps its meaning: the terminal tab in context (the last one shown). A separate
  `activeView` says a view covers the pane area. **One store-level rule** clears `activeView`
  when an update moves `activeTabId` to another tab that still exists, whatever path does it
  (drag spring, moving a terminal, new tab, `focusSession`). The context tab closing doesn't
  count: the next tab becomes the context, still behind the view. Choosing the context tab
  itself (a click, the drag spring) clears `activeView` explicitly.
- Actions that put something in a pane (splits, new terminal, moving a terminal) run behind the
  view and leave it afterwards only if they changed the context tab; one that did nothing keeps
  the view. Navigation (Go to pane, focusing a pane, opening a folder or file) shows its target
  in the context tab. A switch to another tab leaves the view in the same update, so the context
  tab is never on screen (or counted as seen) in between.
- A selector, `shownTerminalTab(state)`, returns the active terminal tab only when no view is
  shown. Readers that ask "what is on screen" (renderer, attention, highlights, the palette's
  tab list, find, the status bar's driving pane) check the view; readers that ask "which tab is
  in context" (new-tab cwd, `focusedTerminal`, `useGhMissing`) keep `activeTabId`.
- A view tab closes with its ×. No new app-wide shortcuts (the graph's own keys pan it, see below):
  ⌘W stays the window's Close.
- The tab's dot follows the fleet: amber when any agent needs you, green while any works.

### Showing a view hides the terminals

While a view is shown, the context tab's `PaneLayout` isn't rendered, so its terminals park
(GOTCHAS #hidden-terminals). The order matters:

- **WebGL**: renderer reconcile must count a shown view as "no pane visible" and run when
  `activeView` changes, releasing the contexts **before** React unmounts the panes. Today's tab
  switch gets this order from the store subscription; moving a live WebGL canvas into the
  parking lot can lose its context, and a lost context leaves the pane on DOM rendering until
  it restarts. Coming back reattaches and repairs, as switching tabs does today. Checked in the
  real app (run-minmux) with several WebGL panes.
- **Attention**: a shown view means the user isn't looking at any terminal. `isVisibleIn` (and
  so `signalSession`) returns false, and focusing the window while the fleet is shown reveals
  nothing (`setWindowFocused` → `revealTab` is skipped), so "needs you" isn't cleared on panes
  that aren't on screen.

### Audit (step 1)

Each of these reads the active tab and gets a decided, tested behaviour with a view shown:
renderer reconcile, `isVisibleIn` / `signalSession`, `setWindowFocused` → `revealTab`, the
sidebar's active highlight, the agents list's current group (`lib/agents-list`),
`focusActiveEntry` / `refocusActiveTerminal` (never focus a parked terminal), `attach()`'s focus
rule, `useActiveCwd` and the status bar, `useGhMissing`, the new-surface handler, `connectAll`
sizing, the top bar's ssh prompt check, and the window title.

### Persistence

- View tabs go in `layout.json` only. `workspace.json` is unchanged, so older
  builds read it as before (an older build reading `layout.json` skips a tab with no `root`).
  The new state joins the workspace save subscription.
- When `workspace.json` wins over `layout.json` (the stamp check fails), view tabs are appended
  at the end of the bar.
- On relaunch a view tab comes back but is **never the active one**. Terminals start when their
  tab's `PaneLayout` mounts; with a view shown first, the context tab's layout would never mount,
  nothing would start, and the fleet would show an empty fleet. The last terminal tab is shown
  instead.

## The graph

### Overview

One circle per repo that has a live agent session (a repo with only open PRs and no session
isn't shown, for now). The circle's size
grows with its live agents (capped); under it, `owner/name ⑂ default-branch` (the folder name
for a repo with no GitHub remote), PR and agent counts, and "● n working ● n need you". Circles
sit on a ring, in a stable order (first seen).

### An open repo

- The repo moves to the centre; the others shrink into the "Other repos" strip, each with its
  initial and status. Clicking one switches; clicking the open repo, or "All repos", closes it.
- **Radial layout**: each child of the repo (a PR, a branch with no PR, an agent on the default
  branch) gets a slice of the circle sized by the agents under it. PRs sit on an inner ring,
  agents on an outer ring inside their PR's slice and close to it, sub-agents just beyond their
  agent. Rings are ellipses (wider than tall). A repo with very few nodes uses smaller rings.
- Free-form forces were tried on the canvas and gave an unreadable tangle; nodes have computed
  places and only ease toward them, with a light overlap check.
- **The graph may be bigger than the window.** No native scrolling: a camera (the world point in
  the middle of the view) pans one layer of cards with a transform. The wheel or trackpad, a drag
  on empty space and the arrow / Page keys move it, Home centres it again, a focused card glides it into view, opening a repo glides to its
  centre, and it stays over the graph. A resize keeps the middle in the middle; cards coming or
  going never move the others under the user. (Native scrolling was tried and raced React's
  renders on resize and on model updates.)
- **Zoom** (40% to 200%): the camera scales the card layer and draws the edges at the same
  scale. A pinch or ctrl/cmd with the wheel zooms about the pointer; + / − / 0 and the corner
  buttons (− level +) about the middle. Pans and drags are in screen pixels, divided by the zoom.
- While a view (the Fleet) shows, the agents panel is set aside (its state kept): it's back with
  the panes; the Agents button in a view goes back to them with it open.
- PR cards reuse the PR graph's looks (`lib/pr-graph` `cardLook`: red for conflicts, failing CI
  or changes requested, amber for CI running, dashed for a draft, an approved tick). A PR the
  lists don't hold shows its number and state only. PR cards carry the pull-request icon. Agent cards: the agent's icon
  (Claude, Codex, OpenCode), name, sub-agent count; what it's doing as a word coloured by status
  (no dots); a third line with its folder, context and model; amber border when it needs you;
  idle ones dimmed by colour (never see-through: the edges behind stay hidden); a
  thin context meter along the bottom edge, amber past 80% of the window.
- Edges: agent to PR in the agent kind's colour, PR to repo neutral (red when blocked),
  sub-agent dashed. Selecting an agent tints its path to the repo green.
- Sub-agents are the live ones: the agent graph drops a turn's finished sub-agents at the next
  prompt, so counts reset each turn.

### Motion

- When the mouse has been still for a moment, the open graph turns around its repo, every node
  the same way, about one turn in 20 minutes: a few pixels a second at the edge. Repo circles
  never turn. Cards stay upright.
- Moving the mouse stops the turn where it is (nothing snaps back). Hovering a card
  freezes the graph so it can be clicked. Dragging a node pins it; Unpin releases all.
- Dots run along the lines of working agents and sub-agents.
- Opening a repo grows its nodes out of the circle (half a second; the settled layout scaled,
  no overlap checks while they fly out).
- Turning stops when the window loses focus and after ten minutes without input.
- Reduced motion: no turning, no dots, no grow-out.

### Side panel

- **All repos**: one row per repo with its counts; a row opens the repo.
- **A repo**: its PRs with their state, its agent sessions with status; a session selects the
  agent. Open on GitHub.
- **An agent**: repo and PR, status and since when, the pane it runs in (Go to pane switches
  to that terminal tab and focuses it), branch, cwd, current action, context use, sub-agents,
  MCP servers and skills (step 5).
- **Inventory** (step 6), from a Graph | Inventory switch in the header: one column per agent
  kind, each MCP server and skill with its use count, then the loaded but unused ones; window
  Live, 7 days, 30 days or All. Codex skills say "not supported yet". Clicking a row switches
  to the graph with the sessions that used it highlighted.

## Data

The fleet adds a pure model (`lib/fleet-model`) over what minmux already tracks, plus two pieces
of plumbing.

| What                                                | Source                                                                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sessions, status, sub-agents, current tool, tokens  | the agent graph (`lib/agent-graph`, hook-fed)                                                                                                                                                |
| Session name and colour                             | `agent-meta` (per pane)                                                                                                                                                                      |
| Which checkout an agent works in                    | the sidebar's rule (`lib/agent-dirs`): Claude's `in` folder and the pane's work checkouts first, the pane's cwd otherwise                                                                    |
| Branch and PR (number, state, url) of that checkout | `PaneGitInfo`, as the sidebar shows                                                                                                                                                          |
| `owner/name`                                        | the repo lookup the PR dialog caches per root (`repoFromRemotes`)                                                                                                                            |
| Default branch                                      | GitHub's `defaultBranchRef` on a listed PR; else the remote's HEAD (`prs:local`, cached; `origin`'s when the chosen remote has none); else `main`/`master`                                   |
| PR titles, CI, review; my open PRs                  | the PR lists' `mine` list, refreshed while the Fleet tab is shown                                                                                                                            |
| Context use                                         | the session's `tokens.context`; the window from Codex's report, from the model in Claude's transcript (200k, or 1M for a 1M-context model), none for OpenCode (tokens shown without a meter) |

- An agent on its repo's default branch hangs off the repo. A branch with no PR shows as a
  branch node. A PR not in `mine` (someone else's, or past the list's 30) keeps the pane's
  number and state, without title or CI, in v1.
- **Refresh.** One serialized refresher (`lib/fleet-refresh`) runs while the Fleet tab is
  mounted and the window visible: my `mine` list at the dialog's cadence (`nextRefreshMs`), the
  repos' names, worktrees and default branch (`prs:local`) with it, at once each time the tab
  opens, and, debounced, when the panes' checkout roots change. One run at a time; anything asked meanwhile runs next. That's
  one GitHub query a refresh while both the tab and the dialog are open; sharing the dialog's
  loop waits for the pulls epic, which reworks the dialog into a tab.
- WSL agents are shown, keyed by their folder, without GitHub data (main's git can't read their
  roots in v1).
- **PR lookups.** Pane PR lookups (`noPr`) run only while something on screen shows a PR (the
  sidebar or the agents panel). A shown Fleet tab counts, so the existing per-pane lookups run
  while it's shown; nothing new while it isn't.
- Terminals start lazily per tab, so after a relaunch the fleet only knows the tabs that have
  been shown. The overview says so when some tabs haven't started yet.

### MCP servers and skills (step 5)

Researched on real data (2026-11-25):

- **Claude**, exact. Loaded: the transcript's `skill_listing` and `deferred_tools_delta`
  entries (skills; MCP tools as `mcp__<server>__<tool>`; failed servers), plus the servers its
  config gives the folder the session started in (`~/.claude.json` user-wide and per project,
  under `CLAUDE_CONFIG_DIR` when set; the nearest `.mcp.json` up to the repo root when approved
  there or in a settings file). `~/.claude.json` can be many MB and changes every turn: a worker
  thread reads it and sends main only the MCP fields. Used: the transcript's `tool_use` entries
  (`mcp__…` names; `Skill` with its `skill`), the session's and each sub-agent's.
- **Codex**: MCP servers loaded from `~/.codex/config.toml` (`[mcp_servers.*]`; the rollout
  doesn't list them). Used: the rollout's `item_completed` events whose item is a
  `McpToolCall` (`server`, `tool`, `status`; a call refused for want of approval is `failed`).
  Skills: "not supported yet". Codex has no skill tool, and guessing from `SKILL.md` reads isn't
  worth showing.
- **OpenCode**: MCP servers loaded from its config's `mcp` key, its layers merged as OpenCode
  merges them: the global config, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` and
  `OPENCODE_CONFIG_CONTENT` when main has them, and `opencode.json(c)` /
  `.opencode/` from the session's folder up to its repo root (an `enabled: false` server left
  out). Used, through our plugin's tool events: an MCP tool is
  `<server>_<tool>` (matched against the configured servers, since names hold `_`); a skill is
  the `skill` tool with its `name`. Skills loaded: its skill folders (global and `.opencode/`)
  and Claude's (`~/.claude/skills`, `.claude/skills`), which it reads too. Counts live in main
  per session (kept across a switch away and back).
- Verified 2026-11-25 (codex-cli 0.167.1, opencode 1.18.34) with a scratch stdio MCP server.
- Counted in main per session from events it already handles, sent on the agent event channel.
  A sub-agent's uses count for its session: one entry per sub-agent, replaced (never added to)
  by each read of its whole transcript, so a continued or still-running sub-agent counts once.
  Sub-agents are read when they stop: after a relaunch, one that finished before it counts again
  only if it runs again (a session's sub-agent folder can hold gigabytes; it's never re-read). A server's configured name is matched to its tool
  names the way the agents write them (`[^A-Za-z0-9_-]` → `_`); servers the user turned off or
  never approved aren't listed. Config files are re-read at most every 30 s.
  Transcripts are read incrementally (one Codex rollout here is 16 GB).
- **Inventory windows** (step 6): Live adds up the open sessions' toolboxes. 7 days, 30 days and
  All come from a history scan in the sessions worker (a utility process, so no scan touches
  main): Claude's transcripts and their sub-agents', Codex's rollouts (archived ones too), and
  OpenCode's tool calls in its database. Each use goes to its own day (the record's timestamp,
  else the file's), with step 5's line readers; what a session had loaded counts on its file's
  last day, and a window's "loaded" is its sessions' plus what the config gives now.
- **The cache is a ledger**: `inventory-cache.json` in minmux's config folder holds, per session
  file (keyed by its name, unique per session), how far it was read and its per-day counts. A
  file moved (Codex archiving it) keeps its entry; one deleted (Claude's 30-day cleanup) keeps
  its counts, so All means everything since minmux first scanned. It's saved every 20 s during a
  scan and written whole through a temporary file; a newer build's file is never written over.
  OpenCode's database is a ledger of its sessions the same way: each session's fingerprint (its part
  count, from the session index alone, and its own last update) is checked, and only the
  ones that moved are recounted whole, their entry replaced (no reliance on id order or the
  clock). A session that had a call still running at its last count is read again each scan
  until none is, so a call that finishes (or is aborted) without a new part is counted. An MCP
  call is named by its server as configured where it ran when it's read, and the name is kept
  through recounts (so a server removed later keeps its counts); else it stays raw for a later
  config to name; a tool no config names isn't MCP. Checked on real data: forks and resumes
  don't repeat calls across files (0 of 58,873 Claude tool uses, 0 of 2,757 Codex calls). OpenCode's
  fork does copy its parent's parts: a part whose row was made more than a minute after its call
  started is such a copy, and isn't counted again. Days are the user's local ones.
- A scan runs when a history window is shown, one at a time, a result reused for 30 s; never on
  a timer. Measured here: the first scan of all history 90 s (in the worker), the next 0.1 s.
- **The view**: a Graph | Inventory switch at the graph's top right. The inventory covers the
  graph, which stays mounted (camera, open repo, pins keep; its motion pauses). A used row
  marks the open sessions that used it: back to the graph, their repo open, the camera on the
  first one, a bar saying what's marked (Clear).

## Rendering

- **No graph library.** The layout is a pure module of about 150 lines (`lib/fleet-layout`).
  d3-force, React Flow, Cytoscape and the WebGL graph libraries were considered: they solve
  problems we don't have, cost 15 to 110 KB, or add a GPU context beside xterm's.
- **Cards are DOM** (text, focus, hover, accessibility, theme tokens), placed with transforms
  written directly by one animation loop. React renders when the model changes, never per
  frame.
- **Edges and dots are one 2D canvas** the size of the viewport, drawn through the camera,
  under the cards. A 2D canvas isn't a WebGL context, and the CSP allows it and inline
  transforms.
- The view is a tab, so nothing WebGL is on screen while it moves (the reason the PR graph,
  sitting over terminals in a dialog, has no motion).

## Performance budget

- Tab not shown, window hidden: no loop, no requests, nothing.
- Shown: the loop runs only while something moves. The turn moves the cards about 15 times a
  second; the grow-out and the dots run every frame (at 15 they stutter), and a dots-only frame
  redraws just the canvas. Stopped with the mouse active and nothing working, hovered (dots
  aside), reduced motion, window blurred, or ten minutes without input. A frame computes at
  most a few hundred positions and redraws the canvas, budget under 1 ms.
- The agent graph changes on every tool call. The model follows it at most once a second, and
  the layout is redone only when the structure changes (a node added, moved or removed);
  status and text changes only re-render the cards.
- Overlap checks run when the layout changes and once a second while turning (a keyframe;
  frames blend between two), never per frame. A drag runs them at most once a frame.
- GitHub: the lists' existing refresh and the pane PR lookups, run while the tab is shown, as
  they run today while the dialog or the sidebar is.
- Checked with the `MINMUX_PERF=1` harness: tab shown and turning vs another tab, keystroke
  latency in a terminal unchanged, no long tasks.

## Steps

One PR each into `epic/fleet-graph`:

1. **View tabs** (#222). The view tab kind, `activeView` and its one clearing rule,
   `shownTerminalTab`, the audit, renderer and attention behaviour, persistence, the tab dot;
   the Fleet view button opening an empty Fleet tab. Verified in the real app.
2. **Model and data** (#223). `lib/fleet-model`, the `mine` refresh, the default branch in
   `prs:local`, agent placement by checkout, the PR lookup gate. Tests; a plain list stands in
   for the graph.
3. **Graph** (#226). `lib/fleet-layout`, the overview, an open repo, the strip, the side panel,
   the camera; no motion.
4. **Motion** (#224). The loop and its stop rules, turning, dots, hover freeze, drag to pin,
   grow-out; the perf check.
5. **MCP servers and skills** (#225). Verify the two unknown formats first, then the per
   session counts, Claude's config reads and the side panel lists.
6. **Inventory** (#228). The history scan and its cache in the sessions worker, the inventory
   view, highlighting sessions from a row.
