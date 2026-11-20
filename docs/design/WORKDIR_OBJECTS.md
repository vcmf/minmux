# Folders and files as entries in panes and the sidebar

Status: **steps 1 and 2 shipped** (#186, #188, #189); **step 3 revised**: file tabs take over the
Changes panel too (see "Git in folder and file tabs") · Epic branch `epic/workdir-objects` · Scope:
`src/types.ts` (pane leaves), `src/lib/pane-tree.ts`, `src/lib/workspace.ts`, `src/store.ts`,
`src/terminal/terminal-manager.ts`, `src/components/terminal-pane.tsx`, `sidebar.tsx`,
`files-panel.tsx` and `diff-panel.tsx` (retired), `electron/main.ts` (open handlers), the fs
worker

Markdown rendering (files, PR bodies, comments) is a separate design and PR. Until it lands, a
markdown file previews as source.

## Problem

An agent rarely stays in the folder it started in. Claude makes a worktree with Bash, edits files
there by absolute path, and commits from there; Codex does the same in another checkout. One tab
often has three or four checkouts in play.

The Files panel shows one tree, rooted at the focused pane's folder (or a per-pane override). To
look at the folder an agent writes in, you focus the agent's pane, and the tree resets. The tree
can't sit next to the terminal it belongs to, and a file can only be seen in a modal.

## Idea

A pane's tabs today are terminals. They become **entries** of three kinds: terminal, folder and
file. A folder or file entry opens, closes, drags and splits like a terminal, and shows in the
sidebar under its group like a terminal does. Groups stay what they are today. There is no
explorer panel: a folder is something you open.

| From               | Action                               | Opens                                                           |
| ------------------ | ------------------------------------ | --------------------------------------------------------------- |
| terminal           | ▤+ in the pane header (or ⌘⇧O)       | its folder, as a new tab in the same pane (see below)           |
| sidebar            | right-click a terminal › Open folder | the same choices as ▤+                                          |
| terminal           | click a path in output               | the file (at its line) or folder, as a new tab in the same pane |
| folder             | open a file                          | the file, as a new tab in the same pane                         |
| folder             | new terminal here                    | a terminal in that folder, as a new tab in the same pane        |
| file               | open its folder / terminal there     | a folder with the file revealed / a terminal in its folder      |
| file (any preview) | Open in editor                       | the editor, as the preview's button does today                  |

## Decisions

### Opening a folder from a terminal

- ▤+ opens the folder **as a new tab in the same pane**, focused. Never a split; you drag it out
  if you want one.
- A folder entry is **always a fixed path**. It never follows a terminal: agents wander into new
  worktrees, so you open the folder you want when you want it.
- Which folder: the ones the sidebar shows for that terminal. **from** (the shell's folder, OSC 7),
  **in** (the agent's folder) and the checkouts the agent **edits** in (`paneWork`: the shown one
  and its `+N` more). When they are all the same folder, ▤+ opens it in one click. When they
  differ, ▤+ shows a menu of the distinct ones, labelled like the sidebar. The sidebar's
  right-click "Open folder in…" lists the same choices, built by the same pure function.

### Opening a file

One rule wherever a file is opened (path click, a folder, the sidebar):

1. **minmux can show it** (a text file, sniffed, up to about 2 MB, or an image): a file tab
   opens, scrolled to the line when the path had one, with an **Open in editor** button as the
   popup has today. A file git marks as changed also gets **Source | Diff** (see "Git in folder
   and file tabs").
2. **A text or code file minmux won't show** (too large) and **Open in editor**: the configured
   editor when one is set, else the OS default app. This is today's `openFile` path.
3. **Anything else**: the OS default app, `shell.openPath` (LaunchServices, `xdg-open`, a WSL path
   through its `\\wsl.localhost\` share).

**Never execute.** An agent can write any file into a folder, and for some types the OS default
action runs them (`.command`, `.app`, `.exe`, `.vbs`, `.js` under Windows Script Host, `.jar`,
`.desktop`, `.webloc`, a file with no extension and the exec bit…). So:

- The check lives in **main**, on every `shell.openPath` call site, including the existing
  `open-path` handler and `openFile`'s OS-default branch, which today open any path unchecked.
- It runs **after resolving symlinks**, compares extensions case-insensitively, and treats the
  exec bit or a bundle directory as runnable.
- It's an **allowlist per platform**: a type goes to the OS default app only when that platform
  opens it (documents, images, media, archives as data, text and code where the default is an
  editor). Everything else is revealed in the file manager. `shell.openPath` failing (no handler,
  no desktop session) also reveals.
- The list itself is a pure, tested function; its exact contents are decided in the
  implementation PR.

### Fewer tabs: peeks

A file opened by a path click or from a folder opens as a **peek**: an italic tab that the next
peek in that pane replaces. It becomes a kept tab when you double-click its tab, pin it or drag
it. Browsing twenty files leaves one tab behind.

### The sidebar

Folder and file entries show in the sidebar under their group, next to the group's terminals,
with their own icon and name. Clicking one shows it, as for a terminal. Today's groups, their
order and drag and drop are unchanged.

### Git in folder and file tabs

The Changes panel shows one repo, the focused terminal's, as a list and a diff off to the side.
Folder tabs already know their own repo and mark changed files (step 2b), so the panel's job moves
into them: what changed shows where it lives, in any repo a tab is open on. Read-only, as the panel
is today (no staging, no commits).

- **Marks** (shipped): M / A / D / ? on files, a tint on folders that hold changes. Folders also
  show **how many** changed files they hold.
- **The breadcrumb bar** shows the tab's repo state: branch, ahead / behind and the total +/−,
  from the status the folder already gets (the focused terminal's poll, or the folder tabs' own).
  A worktree tab shows its own branch.
- **Changes only**: the +/− in the bar toggles the tab into a flat list of the changed files under
  its folder, with their +/− counts. On a repo's root folder that's today's Changes panel list.
- **A changed file opens on Diff** from that list, and on Source from the tree:

  | File                       | Opens on                                    | Toggle        |
  | -------------------------- | ------------------------------------------- | ------------- |
  | Unchanged                  | Source                                      | none          |
  | Modified (M)               | Source with change bars (tree), Diff (list) | Source / Diff |
  | New: untracked (?) / added | Source (the whole file is the change)       | none          |
  | Deleted (D)                | Diff (no file to show)                      | none          |
  | Too large, not supported   | the editor or the OS app (see above)        | n/a           |

- **Diff** is today's bounded `git diff` of one file (too large or too slow says so), read only
  when the Diff view shows, and cached until that repo's status changes. It's **syntax
  highlighted**: each hunk's old and new text is highlighted whole (a multi-line comment or string
  stays right) and split back into lines, so the +/− backgrounds sit under the code's colours.
- **Source change bars**: the same diff's line ranges mark added and modified lines in the
  gutter, so you read the file whole and still see what changed.
- **A live file** (an agent still writing it) refreshes both views, under the same throttle as
  Source.

Later, on the same data: **who changed it** (an agent's icon and "2m ago" on files its hook events
say it edited) and **diff peeks in the tree** (a changed row unfolds its hunks).

### What happens to the Files and Changes panels

Folder and file tabs replace both. Step 4 removes the two panels and their top-bar icons (no
replacement button: folders open from the pane header, the sidebar and path clicks). The right
rail keeps Agents. The status bar keeps the focused terminal's branch.

SSH panes have no local path: no folder or file entries there, as in today's Files panel.

## Model

**Every entry gets its own id.** Today a pane's tabs and its visible tab are session ids
(`sessionIds`, `activeSessionId`), and `Tab.activeSessionId` is also the focus. WebGL
(`visibleSessionIds` → `reconcileRenderers`), unread suppression (`isVisibleIn`), keyboard focus
(`refocusActiveTerminal`), ⌘F, hidden-surface sizing (`syncHiddenSizes`), drag and drop and every
pane-tree operation read those fields. If a folder simply became the visible tab, keys would go
to a parked terminal and resizes would be lost.

- A leaf holds one ordered list of entries (terminals included), each with an id and a kind, and
  one visible entry. `sessionIds` / `activeSessionId` become values derived from it.
- The tab knows its **focused entry** and, separately, its **focused terminal**. Every reader of
  `activeSessionId` (about 50 in the store and components) is audited and moved to the one it
  means.
- This lands first, with terminals only and no visible change (step 1).
- Entry view state (expanded folders, scroll position) is **not** stored in `tabs`: every `tabs`
  change runs a WebGL reconcile and a workspace save. It lives in its own store slice with its own
  save, and scroll is captured when an entry hides.
- Each folder or file entry keeps its WSL context, as `readdir` and the preview read need it.

## Persistence

An older build drops a pane with no terminal, then a tab with no pane left, and if no tab is left
it reads the file as empty, starts fresh and **saves over it**. Today's build does the same.

- `workspace.json` keeps only what an older build understands: the layout with **terminals
  only**. A pane holding only folders and files is left out of that copy.
- The full layout, folders and files included, goes in a separate file next to it. A build that
  knows it reads it; when its terminals don't match `workspace.json` (an older build saved
  since), the terminals-only layout wins and the folder and file entries that still fit are
  re-added.
- Round-trip tests: new → old → new keeps every terminal and never empties the workspace.
- An entry whose path is gone at restore shows a "gone" placeholder.
- `layout.json` keeps one version across folder and file entries. An older build that knows only
  folder entries drops the file entries it can't read and keeps the folders; if it saves, the file
  tabs are gone. Accepted: a version bump would make it skip the whole file, folder tabs included,
  and file tabs are quick to reopen.

## Performance

Every new cost stays off the terminal hot path, and **an entry costs something only while it's
visible**:

| State   | When                  | Holds                                                      | Cost                         |
| ------- | --------------------- | ---------------------------------------------------------- | ---------------------------- |
| Visible | on screen             | DOM, watches on its open folders or its file, live updates | full, a handful at once      |
| Warm    | hidden, recently seen | no DOM, no watches; its listing or text in a shared cache  | memory, inside a fixed limit |
| Cold    | everything else       | a small record: path, expanded folders, scroll position    | none                         |

- **Reads and watches** stay in the fs worker, through today's read queue. A watch costs no CPU
  while nothing changes. **File reads move there too**: today's preview read runs in main.
- **Watches** today have one owner (the Files panel sends its whole set). A small aggregator in
  the renderer merges every visible entry's folders into that set, ref-counted, under today's cap
  of 32; a hidden entry releases its own.
- **No watches** on Windows (as today), WSL shares and network mounts: those refresh on window
  focus, on a git change, or on Refresh. No timer polls.
- **Live files**: a watched file re-reads at most every 200 ms while visible, and highlighting of
  a live file is throttled and runs off the renderer's main thread.
- **Caches are shared by path**: the folder cache is split into listings (shared by path) and
  each entry's expanded folders.
- **Git marks** (shipped): a folder's repo comes from the fs worker's `.git` search up from the
  folder, in its own spelling; `git status` runs only for marks, one repo per tick, in turn over
  every repo shown, at most every 3 s.
- **Diffs and highlighting** run off the renderer's main thread: `git diff` in main as today
  (bounded), highlighting in a worker, under today's 100 KB highlight cap (past it, plain).
  Long files and diffs render only the lines in view, as long folder trees do.
- A folder or file view never joins the WebGL set: showing one parks the pane's terminal through
  the existing park path.

Measured with `MINMUX_PERF=1`. Keystroke latency has no baseline yet (PERF.md), so step 1
measures one before anything changes. A scenario of 200 folder and file entries across 30 tabs
must give 0% CPU at idle, memory within the cache limit, a tab switch within one frame, and
keystroke latency equal to the baseline.

## Steps

1. **Entry ids.** The leaf's entry list, focused entry vs focused terminal, the `activeSessionId`
   audit, a keystroke-latency baseline. Terminals only; nothing visible changes.
2. **Folder entries.** The folder view on today's file tree and read queue, the watch aggregator,
   the three states, the separate layout file, sidebar rows. ▤+ and "Open folder in…".
3. **File entries** (#185), in two PRs:
   - **3a. File tabs.** The Source view (highlighted, line view), file reads in the fs worker,
     peeks, path clicks, "Open in editor", the main-side open check on every `shell.openPath`.
   - **3b. Git in folder and file tabs.** Folder change counts, the repo state in the breadcrumb
     bar, Changes only, the Diff view (highlighted in a worker), Source change bars.
4. **Retire the Files and Changes panels** (#183). Once folder and file tabs cover them, with
   their top-bar icons.

## Not in scope

- Markdown rendering (its own design and PR).
- Editing files; staging or committing.
- Who-changed-it marks and diff peeks in the tree (follow-ups on the same data).
- Grouping or a view by checkout.
- A workdir jumper / fuzzy file finder.
- SSH panes (no local path).
