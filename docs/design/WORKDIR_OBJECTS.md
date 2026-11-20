# Folders and files in panes, and a Workdirs view

Status: **proposal** · Epic branch `epic/workdir-objects` · Scope: `src/types.ts` (pane leaves),
`src/lib/workspace.ts`, `src/store.ts`, `src/components/terminal-pane.tsx`, `sidebar.tsx`,
`files-panel.tsx` (retired), the fs worker (`electron/fs-worker*.ts`)

Markdown rendering (files, PR bodies, comments) is a separate design and PR. Until it lands, a
markdown file opens as source.

## Problem

An agent rarely stays in the folder it started in. Claude makes a worktree with Bash, edits files
there by absolute path, and commits from there; Codex does the same in another checkout. One tab
often has three or four checkouts in play.

The Files panel shows one tree, rooted at the focused pane's folder (or a per-pane override). To
look at the folder an agent writes in, you focus the agent's pane, and the tree resets. The tree
can't sit next to the terminal it belongs to, a file can only be seen in a modal, and nothing in
the app groups work by checkout.

## Idea

Terminals, folders and files are three kinds of the same thing: an **object** that opens in a
pane, as a tab next to other tabs, and can be dragged, split, moved and closed like a terminal
today. There is no explorer panel. A folder is something you open.

Each object opens the others:

| From     | Action                               | Opens                                                      |
| -------- | ------------------------------------ | ---------------------------------------------------------- |
| terminal | ▤+ in the pane header (or ⌘⇧O)       | its folder, as a new tab in the same pane (see below)      |
| terminal | click a path in output               | that file or folder, as a peek                             |
| sidebar  | right-click a terminal › Open folder | the same choices as ▤+                                     |
| folder   | open a file                          | a peek (Enter), a kept tab (⌘Enter)                        |
| folder   | double-click an unsupported file     | the OS default app (see below)                             |
| folder   | new terminal here                    | a terminal in that folder, as a new tab in the same pane   |
| file     | open its folder / terminal there     | a folder with the file revealed / a terminal in its folder |

The app then has two views of the same objects:

- **Groups**: tabs you arrange yourself, as today.
- **Workdirs**: the app groups every object by the checkout it belongs to, one layout per
  checkout.

Switching between them moves and restarts nothing.

## Decisions

### Opening a folder from a terminal

- ▤+ opens the folder **as a new tab in the same pane**, focused. Never a split; you drag it out
  if you want one.
- A folder object is **always a fixed path**. It never follows a terminal: agents wander into
  new worktrees, so you open the folder you want when you want it.
- Which folder: the ones the sidebar already shows for that terminal. **from** (the shell's
  folder, OSC 7), **in** (the agent's folder) and the checkout the agent **edits** in. When they
  are all the same folder, ▤+ opens it in one click. When they differ, ▤+ shows a menu of the 2 or
  3 distinct ones, labelled like the sidebar. The sidebar's right-click "Open folder in…" lists
  the same choices.
- One pure function builds that list from what `agent-dirs` already computes, so the button and
  the sidebar can't disagree.

### Peeks

Clicking a path, or Enter on a file in a folder, opens a **peek**: an italic tab that the next
peek in that pane replaces. It becomes a kept tab when you scroll it, pin it or drag it. Browsing
twenty files leaves one tab behind.

### Which files open as objects

Small files of supported types: text, code, config, markdown (as source until the markdown PR)
and images, up to about 2 MB. Anything else opens in the configured editor or the OS.

**Double-click on an unsupported file** opens it with the OS default app: `shell.openPath` (macOS
LaunchServices, Linux `xdg-open`, a WSL path through its `\\wsl.localhost\` share). Two rules:

- **Never execute.** Files whose default action runs them (`.app`, `.command`, `.pkg`, `.exe`,
  `.bat`, `.cmd`, `.ps1`, `.lnk`, `.msi`, `.desktop`, `.AppImage`, …) are revealed in the file
  manager instead. An agent can write any of these into a folder. The denylist is a pure, tested
  function.
- **Never silent.** `shell.openPath` reports failure as a string (no handler, no desktop session);
  on failure the file is revealed instead, as `openFile` already does for editors.

SSH panes have no local path: no folder or file objects there, as in today's Files panel.

### The Workdirs view

- An object's workdir is its checkout root: for a folder or a file, the repo its path is in; for a
  terminal, its shell folder's repo, or the checkout its agent edits in while the agent runs.
  Outside any repo, the folder itself.
- The view lists workdirs in the sidebar; picking one shows its objects in that workdir's
  remembered layout (a default one the first time).
- **Nothing moves while you look.** A terminal whose workdir changes moves to its new group the
  next time the view is shown, never under your hands.
- Closing an object closes it in both views. Arranging objects in Workdirs doesn't change Groups.
- A terminal opened in the Workdirs view also lands in the group that last had focus.

### What happens to the Files panel

Folder objects replace it. The right rail keeps Changes and Agents.

## Performance

Every new cost stays off the terminal hot path (PTY → main → renderer → xterm), and **an object
costs something only while it's visible**:

| State   | When                  | Holds                                                       | Cost                         |
| ------- | --------------------- | ----------------------------------------------------------- | ---------------------------- |
| Visible | on screen             | DOM, watchers on its open folders or its file, live updates | full, a handful at once      |
| Warm    | hidden, recently seen | no DOM, no watchers; its listing or text in a shared cache  | memory, inside a fixed limit |
| Cold    | everything else       | a small record: path, scroll position, expanded folders     | none                         |

- **Reads and watches** stay in the fs worker, through today's read queue (concurrency 1, ≤ 4
  reads/s, big folders backed off, equal listings skip the render). A watch costs no CPU while
  nothing changes; events are batched (≤ 1 message per 250 ms).
- **One watch budget** (today's 32) shared by every visible object and ref-counted; a hidden
  object releases its watches. Showing it again shows the cached copy at once and queues one
  refresh read.
- Places that can't be watched (WSL shares, network mounts) refresh on window focus, on a git
  change, or on Refresh, as today. No timer polls.
- **Caches are shared by path**: two folder tabs on one root share one listing.
- **Git marks** come from one poll per distinct repo among visible folders, piggybacking today's
  git poll; never one per object.
- **Startup** loads only the active tab's objects, like terminals today.
- **Switching tab or view** re-attaches the visible terminals, the same path a tab switch takes
  today; hidden objects stay parked or unmounted.
- A folder or file view never joins the WebGL set: showing one parks the pane's terminal through
  the existing park path.

Each step is measured with `MINMUX_PERF=1`. A new scenario, 200 folder and file objects across 30
tabs, must give 0% CPU at idle, memory within the cache limit, a tab or view switch within one
frame, and keystroke echo equal to the baseline.

## Persistence

- `workspace.json` **stays at version 2**. A version bump would make older builds drop the layout
  entirely (`deserializeWorkspace` refuses a newer file). Folder and file objects are optional
  additions to a leaf; a leaf's `sessionIds` keeps listing its terminals, so an older build opens
  the same terminals and ignores the rest.
- An older build that saves drops the folder and file tabs. Accepted: they are cheap to reopen.
- Workdir layouts are stored under their own key, keyed by checkout root.
- Objects whose path is gone at restore are kept and marked missing, with one-click cleanup.

## Invariants touched

- **`Tab.activeSessionId` is the focus.** It stays the terminal focus. A pane gets an optional
  active object; when set, that object is the visible tab and the terminal is parked. Keyboard
  focus follows the store either way.
- **Started terminals are mounted or parked, never unopened.** Showing a folder or file in a pane
  parks its terminal; it doesn't unmount it.
- **Store actions return the same reference when nothing changed**, including for object state
  (scroll, expanded folders), so a scroll doesn't trigger a workspace save per frame.

## Steps

1. **Folder and file objects in panes.** The leaf model and persistence (v2 compatible), the
   folder view (today's file tree, read queue and watches, behind the shared budget and the three
   states) and the file view (source with today's highlighter). Open, close, drag and split like
   terminals.
2. **Opening things.** ▤+ and the sidebar's "Open folder in…" with from / in / edits; path clicks
   and Enter open peeks; new terminal here; double-click to the OS default app with the denylist.
3. **The Workdirs view.** Grouping by checkout, a layout per workdir, the switch in the top bar.
4. **Retire the Files panel.** Once folder objects cover it.

## Not in scope

- Markdown rendering (its own design and PR).
- Editing files.
- A workdir jumper / fuzzy file finder (a later step; it needs a per-checkout file index in the
  fs worker and a direct channel from the worker to the renderer).
- SSH panes (no local path).
