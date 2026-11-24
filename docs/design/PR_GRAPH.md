# Pull requests: graph view

Design canvas (mock-ups): https://claude.ai/artifact/McERCEE9twrhr5M2vY3Q2i

## Problem

The pull requests dialog (`docs/design/PR_DASHBOARD.md`) lists PRs with stacks indented under
their base PR, and its detail says which panes have a PR checked out. Three things are hard to
see from it:

- **The shape of the work.** A stack of four PRs, a second stack beside it and two loose PRs in
  another repo read as one long list. Which PR waits on which, and which repo each belongs to,
  takes reading every row.
- **Where each PR lives locally.** `prPanes()` knows only panes that are open. A worktree with
  the branch checked out and no terminal in it shows nothing.
- **How far along a group PR is.** An epic-style PR (unit PRs squash-merged into it, then merged
  to the default branch) says nothing about how many of its units have landed.

## Goals

- A **Graph** view of the current tab, beside today's list (a List | Graph switch in the dialog
  header). The list stays the default and keeps working as it does.
- **One root per repo**, named `owner/name` with its default branch.
- **A card per PR** whose look says its state at a glance, an approved tick, the comment count,
  and where it's checked out (an agent and its status, a terminal, or a worktree with no
  terminal open); the focused pane's PR keeps the green "here" ring.
- **Two targets on every node:** the card opens it in the dialog, a ↗ opens it on GitHub.
- **Checkouts beyond open panes:** linked worktrees of the repos the panes are in, shown on the
  card and in the detail's "Checked out in" (list view too), with "Open terminal here".
- **A progress estimate** on a PR that has units: `~merged/(merged+open)`, a bar and a label.
- **Performance:** no new polling, no new GitHub request, nothing while the dialog is closed;
  local git work in main, async, bounded, off the terminal path.

Not in scope: drag to restack, retargeting or rebasing from the graph, PRs from other hosts,
pan/zoom, a minimap, animated layout.

## Layout

```
 vcmf/minmux ⑂ main ↗ ●──── #12 path box ✓ 💬4 ~4/7 ──── #14 tab-complete (CI running)
                     │                          └─── #16 //server paths (conflicts)
                     └──── #8 split detail ✓ ──── #10 graph view (draft)
 ─────────────────────────────────────────────────────────────────────────────
 acme/platform ⑂ develop ↗ ●── #88 rate limits (CI running) ── #91 auth mw (conflicts)
                           └── #85 runbook (draft)
```

- **The tree** is today's: `stackRows()` over the tab's rows, the same `stack` memo the list
  uses (so edits shown over lagging search results, held rows and "Include closed" look the
  same in both views). Its roots are regrouped by repo, repos in the order their first PR has
  in the list.
- **Placement** is a tidy tree: column = depth; a PR shares the row of its first child, each
  further child opens a new row below; a repo's block starts on a new row with a separator.
- **Edges** are cubic curves from a parent's right edge to a child's left edge. The path from a
  root to the focused pane's PR is tinted green.
- **A base outside the tab.** When `stackRows()` says a PR is based on a PR another tab lists
  (`on`), a small stub node `#N · Mine` stands between it and the root, and opens that PR
  (`goTo`). A base branch that is neither the default branch nor a known PR (`release/1.2`):
  the PR hangs off the root, the edge labelled with that branch.
- **Forks** follow `basePr`: a fork's head is never a base, but a fork PR is stacked under a
  listed PR whose head is its base.
- The graph scrolls both ways with the browser's own scrolling.

### Card state

- **Colour**, the worst of: red for conflicts, CI failing or changes requested; amber for CI
  running; else neutral. Merge state `unknown` stays neutral.
- **Draft** is a dashed border and a dimmed title over that colour (a draft with CI running is
  dashed and amber).
- **Merged / closed** (only with "Include closed"): muted, with the state icon; never coloured.
- **Approved**: a green tick; independent of the colour (approved and CI failing shows both).

### Clicks and keys

- A PR card opens the list view with it selected; that switch isn't remembered as the view
  (as `setTab(…, remember = false)`). A ↗ opens it on GitHub.
- The **focused pane's repo** root opens the repo tab; any other repo has no tab of its own, so
  its root opens the repo on GitHub.
- A PR link arriving (`prLink`) while the graph is shown switches to the list, not remembered.
- Graph keys: ←/→ parent / first child, ↑/↓ the row above / below, Enter opens in the dialog,
  `o` opens on GitHub, `g` switches the view. Tabs stay on 1/2/3 in the graph (←/→ are taken).
  The list's keys don't change.
- The chosen view is remembered across opens, as the tab is (its own localStorage key; older
  builds ignore it).

## Rendering

DOM cards placed absolutely, one SVG layer under them for the edges; no canvas, no graph
library. A tab holds at most ~90 rows (30 per account), and the DOM keeps text, focus, hover,
tooltips and accessibility. Canvas or WebGL would mean drawing text and hit-testing by hand,
and adds a GPU surface beside xterm's.

- The layout is a pure function (`src/lib/pr-graph.ts`) of the `stack` rows: `→ { roots, nodes
{x, y}, stubs, edges (path strings) }`, in a `useMemo` on those rows. Unit-tested: depth,
  siblings, repo regrouping, forks, cycles (flat, as `stackRows`), stubs, unknown bases,
  "Include closed".
- No transitions on position or size, no blur, no animated shadows (the dialog sits over WebGL
  panes). Hover is a colour change.
- Nothing graph-related renders in the list view.

## Data

### Repo roots

`PR_FRAGMENT`'s `repository { nameWithOwner }` gains `defaultBranchRef { name }`: a plain
object on a node the query already returns, no extra request or points. An answer kept from
an older build has no branch: the root shows the repo alone.

### Local checkouts beyond open panes

- One `prs:local` request per dialog refresh (the existing loop: on open, then each refresh;
  nothing while the dialog is closed or the window hidden), in either view.
- Main groups the panes' `PaneGitInfo.root`s by repo (`git rev-parse --git-common-dir`, cached
  per root: it doesn't change) and runs `git worktree list --porcelain` once per repo: no cache,
  it's a few ms and a cache keyed on folder mtimes misses branch switches. Entries that are
  `bare`, `detached` or `prunable` are skipped.
- The repo is matched to `owner/name` with the lookup the repo tab already caches per root
  (`repoFromRemotes`: `upstream`, then `origin`).
- A worktree is a PR's checkout when its branch is the PR's head in that repo; **fork PRs are
  never matched by branch name** (their code lives in the fork). A worktree whose path is a
  pane's root is that pane (today's rule) and isn't listed twice, whether or not the pane's own
  PR lookup has answered.
- The rest show as "worktree · not open" with **Open terminal here** (a split beside the
  focused pane, in a host shell, as the agents panel opens a folder).
- Not searched: repos no pane is in, clones elsewhere on disk. SSH panes add nothing. WSL panes
  aren't searched in v1 (their roots are Linux paths main's git can't read); a WSL pane in
  `/mnt/<drive>/…` still counts as having its worktree open.

### Progress estimate

For a PR P in a repo the dialog has locally (any worktree of it), whose head was fetched:

- **open** = the live (open or draft) listed PRs stacked under P at any depth.
- **merged** = commits in `<remote>/<P.base>..<remote>/<P.head>` (remote refs, so no checkout
  is needed and an unpulled local branch doesn't lag), where `<remote>` is the one
  `repoFromRemotes` picked, **committed by GitHub** (committer `noreply@github.com`: what its
  merge button writes), whose subject ends in `(#N)` or reads `Merge pull request #N`, N deduped.
  - The base, not the default branch: a stacked P doesn't count its base PR's units.
  - The committer check drops hand-written `(#123)` subjects and most cherry-picks.
  - At most 500 commits read (`--max-count`); a shallow or odd range shows no bar.
- Shown as `~merged/(merged+open)` and a bar when merged + open > 0; no remote ref, no bar,
  never a guess.
- Cached per (head tip, base tip, default tip), the tips read with one `git for-each-ref` per
  repo for just the refs asked about (plus the remote's HEAD, the default branch when a row
  from an older build doesn't name it); a pair that didn't move costs nothing. A range git
  fails on waits ten minutes before it's tried again.
- Counts, not line-weighted. PRs closed without merging aren't counted.
- Known misses: rebase merges, stack tools that land each child on the default branch (the
  child then isn't under P anyway), a stale fetch. A later step can ask GitHub (merged PRs per
  base branch, one GraphQL query) where it matters.

## Performance budget

- Dialog closed (or window hidden): zero new work.
- Dialog open: one extra IPC per refresh. In main: one `for-each-ref` and one `worktree list`
  per repo the panes are in, one `git log` per PR whose (head, base) tips moved; concurrency
  limited, each with the dialog's gh timeout, never on the PTY path.
- Layout: O(n) over the rows, re-run only when they change.
- Checked with the `MINMUX_PERF=1` harness (dialog open on the graph vs closed), as for the
  dialog's first step.

## Steps

One PR each into `epic/pr-graph`:

1. **Graph view** (#214). The switch, `lib/pr-graph.ts`, roots with their default branch, cards
   (state, tick, comments, today's pane checkouts), stubs, ↗ and open-in-dialog, keys.
2. **Worktrees not open** (#215). `prs:local` (worktree pass), the card line and the detail's
   "Checked out in" in both views, Open terminal here.
3. **Progress estimate** (#216). The remote-ref pass and `git log` count in the same request, the
   bar and label.

## Open questions

- Graph per tab (as designed) or a whole-repo view across tabs?
- Merged base PRs of a stack as ghost nodes when "Include closed" is off?
