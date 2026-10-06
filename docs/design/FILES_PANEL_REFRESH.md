# Files panel: live refresh

Status: **proposal, revised after review** · Scope: `electron/main.ts` (`fs:readdir`, new
`fs:watch`), `src/components/files-panel.tsx`, `src/lib/file-tree.ts`

## Problem

With the Files panel open, new, deleted or renamed files don't appear until the user switches
to another pane and back. Collapsing and re-expanding a folder doesn't help: it shows the cached
listing. When an agent writes files, the tree goes stale within seconds.

Today a folder is read with `fs:readdir` (one level, async) only:

- on first show of a root;
- on expanding a folder **for the first time** (`toggleDir` returns `needsLoad` only when the
  folder has no cached listing);
- on returning to a cached root, when all open folders are re-read (skipped for WSL panes).

There is no watcher and no poll.

## Goals and constraints

- The tree reflects create, delete and rename in **expanded** folders, quickly enough to feel
  live (target under 500 ms).
- **Off the terminal hot path.** Main carries all PTY I/O, and the renderer runs xterm on its
  main thread, so neither may block for more than a few ms. Bounded cost however big the folder
  or however fast the writes. No idle cost (PERF.md: idle 0%).
- Zero setup. WSL, network and remote panes degrade to cheaper triggers, never hang.

## Step 0 (prerequisite, also fixes today's bug): a bounded `fs:readdir`

Measured on a 35k-entry folder of symlinks (`node_modules/.pnpm`), with the handler as it is:

|                 | time       | longest event-loop block |
| --------------- | ---------- | ------------------------ |
| whole handler   | 220–250 ms | **134–176 ms**           |
| `readdir` alone | 26–39 ms   | 1.3 ms                   |
| sort            | 2–9 ms     | —                        |

The block is `ents.map(… fs.promises.stat)`, which issues 35k stats synchronously, and RSS grew
about 100 MB per read. This already stalls keystrokes on a first expand today. Every refresh
trigger below would multiply it, so it's fixed first:

- Sort and cap **before** resolving symlinks, and `stat` only the symlink entries that survive
  `READDIR_CAP`. The rest keep `isDir` from the dirent.
- Stat in batches of 64, yielding (`setImmediate`) between batches. Measured worst gap: 3–10 ms.

## Design

### Main: one watcher per expanded folder (local paths only)

New IPC `fs:watch(dirs: string[])`. The renderer sends the full set of folders it wants watched;
main reconciles, opening watchers for new dirs and closing the rest. The call is idempotent.

- `fs.watch(dir, { persistent: false })`, **non-recursive**. Measured on macOS: 5000 writes in
  an unexpanded subfolder gave 0 JS events and about 1 ms CPU.
- **Only local host paths.** No watcher for WSL (`\\wsl.localhost\`), SSH, or network mounts:
  FSEvents doesn't report remote changes, and a sync `fs.watch` on a hung mount can block main.
- **Cap: 32 watched dirs.** Negligible against Linux `max_user_watches`. Dirs past the cap use
  the fallbacks.
- An event doesn't read anything in main. It marks the dir dirty, and main sends
  `fs:changed { dirs }` with the dirty dirs of one tick, at most one message per 250 ms overall.
- **Re-arm.** On Linux a watch belongs to the inode: when the watched dir is deleted and
  recreated (`rm -rf dist && build`) inotify goes silent with no `error`. When an event names the
  watched dir itself, or a read of it fails, main closes that watcher, and the next successful
  read re-arms it.
- **Cleanup.** All watchers are closed when the renderer navigates, reloads or crashes
  (`did-start-loading`, `render-process-gone`), and when the panel sends an empty set.

### Renderer: one bounded read queue

All Files-panel reads (watcher, expand, focus, Refresh button) go through **one queue**:

- concurrency 1, **at most 4 reads per second** overall;
- a dir already queued or in flight isn't added twice, and a change during its read schedules
  exactly one more read;
- **big folders** (≥ `BIG_FOLDER` entries in their last listing) are read at most once every
  5 s;
- one **settle read** about 2 s after a dir's last event, in case events were dropped (inotify
  queue overflow) or the trailing read landed mid-burst.

Applying results:

- `setListing` returns the **same reference** when the new listing equals the old one, and then
  `setTree` is skipped. This matters on macOS, where appending to a file reports the same event
  as creating one, so a folder holding a growing log, a sqlite db or `~/.zsh_history` (root =
  `$HOME`) fires on every write. Equal listing means no re-render.
- Results that arrive in one tick are applied with one `setTree`.
- On Linux, `change` events (content only) are ignored in main. inotify separates them; macOS
  doesn't.

### Fallback triggers

- **Expand** re-reads the folder through the queue (the cached listing shows at once, then
  updates).
- **Window focus** re-reads only the open dirs that are **not** watched (WSL, past the cap).
  Watched dirs are already current. On WSL these reads go one at a time through the queue: N
  parallel reads over 9p stall the refocus, which is why today's code skips them.
- **WSL:** also re-read open dirs, through the queue, when the polled `git.files` changes.
- A **Refresh** button in the Files header re-reads every open dir, through the queue.

### Big folders in the tree

A folder with ≥ 100 entries shows its first 10 plus "N more". On refresh the count updates and
the preview doesn't reshuffle.

## Cost (after Step 0)

| Case                             | Cost                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| Idle                             | ≤ 32 watchers, no CPU, no reads                                                              |
| One new file                     | event in about 12 ms (macOS measured), 1 message, 1 small read: well under 100 ms end to end |
| Write storm, small folder        | ≤ 4 reads/s overall, each a few ms; equal listings don't re-render                           |
| Write storm, huge folder         | 1 read per 5 s, about 40 ms async with ≤ 10 ms blocks                                        |
| Storm in an unexpanded subfolder | nothing (non-recursive)                                                                      |
| Focus                            | reads only unwatched open dirs, one at a time                                                |

## Alternatives considered

- **Piggyback the 2.5 s git poll** (re-read when `git.files` changes). Almost no code, but
  about 2.5 s latency. It misses gitignored folders (`dist`, `node_modules`) and non-repo roots,
  and polls the wrong repo when the panel root differs from the pane's cwd. Kept as the WSL
  fallback only.
- **Poll open dirs on a timer** while the panel is visible. Steady reads while idle, which
  breaks the idle-0% baseline. Rejected.
- **Recursive watch.** Unbounded on big trees. Rejected.

## Delivery

1. Step 0: bounded `fs:readdir`, as its own PR. It fixes a keystroke stall that exists today.
2. Read queue, equal-listing skip, re-read on expand, Refresh button.
3. Watchers, re-arm, cleanup, focus and WSL fallbacks.

Each step is measured with `MINMUX_PERF=1` on a 35k-entry folder during a write burst.
