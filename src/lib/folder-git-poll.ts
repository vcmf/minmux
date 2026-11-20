// Runs lib/folder-git's plan: the git status of the repos shown folder entries are in, other
// than the focused terminal's. One `git status` per tick, round-robin over the repos, a tick at
// most every FOLDER_GIT_MIN_MS (longer when git is slow): main launches git, and each launch
// blocks it a few ms. Stops, and forgets, when no folder view wants marks.
import { ipc } from "./ipc"
import { useStore } from "../store"
import { nextGitPollDelay } from "./git-poll"
import {
  FOLDER_GIT_MIN_MS,
  forgetOthers,
  gitTargets,
  learn,
  logicalRoot,
  repoKey,
  rootOf,
  type GitWant,
  type Learned,
} from "./folder-git"
import { samePath } from "./agent-dirs"

const wants = new Map<string, GitWant>()
const learned = new Map<string, Learned>()
let running = false
let turn = 0
let wake: (() => void) | null = null // ends the loop's wait early
let lastFocused: string | undefined // the focused terminal's repo at the last tick

/** `owner` (a mounted folder view) wants marks for `want`; null: no longer. A folder never
 *  asked yet is asked right away, not at the next tick. */
export function wantGit(owner: string, want: GitWant | null): void {
  if (want) wants.set(owner, want)
  else wants.delete(owner)
  if (!want) return
  if (!running) void loop()
  else if (rootOf(learned, want) === undefined) wake?.()
}

const focusedRoot = () => {
  const g = useStore.getState().git
  return g?.isRepo ? g.root : undefined
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      wake = null
      r()
    }
    wake = done
  })

async function loop(): Promise<void> {
  running = true
  // Focus left a repo: its folders' marks are as old as the last time it wasn't focused, so it
  // goes first (and now, not at the next tick).
  const off = useStore.subscribe((s, prev) => {
    if (s.git?.root !== prev.git?.root) wake?.()
  })
  try {
    while (wants.size) {
      const t0 = performance.now()
      const focused = focusedRoot()
      const left = lastFocused && lastFocused !== focused ? lastFocused : undefined
      lastFocused = focused
      const all = [...wants.values()]
      forgetOthers(learned, all)
      const targets = gitTargets(all, learned, focused, Date.now())
      // A folder never asked yet first (it was just shown), then the repo focus just left,
      // else the repos in turn.
      const t =
        targets.find((w) => rootOf(learned, w) === undefined) ??
        targets.find((w) => {
          const r = rootOf(learned, w)
          return !!left && !!r && samePath(r, left)
        }) ??
        targets[turn++ % Math.max(1, targets.length)]
      if (t) {
        try {
          const g = await ipc.gitStatus(t.path, t.wsl)
          learn(learned, t, g, Date.now())
          if (g.isRepo) {
            const root = logicalRoot(t.path, g.root) // the folder's spelling, symlinks and all
            useStore.getState().setFolderGit(repoKey(t.wsl, root), { ...g, root })
          }
        } catch {
          // a failed status: try again next round
        }
      }
      prune()
      await sleep(Math.max(FOLDER_GIT_MIN_MS, nextGitPollDelay(performance.now() - t0)))
    }
  } finally {
    off()
    running = false
    learned.clear()
    prune() // nothing shown: no statuses kept
  }
}

/** Drop the statuses no shown folder is in any more. */
function prune(): void {
  const keep = new Set<string>()
  for (const w of wants.values()) {
    const root = rootOf(learned, w)
    if (root) keep.add(repoKey(w.wsl, root))
  }
  const s = useStore.getState()
  for (const key of Object.keys(s.folderGit)) if (!keep.has(key)) s.setFolderGit(key, null)
}
