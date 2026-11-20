// Runs lib/folder-git's plan: the git status of the repos shown folder entries are in, other
// than the focused terminal's. One `git status` per tick, round-robin over the repos, a tick at
// most every FOLDER_GIT_MIN_MS (longer when git is slow): main launches git, and each launch
// blocks it a few ms. Stops when no folder view wants marks.
import { ipc } from "./ipc"
import { useStore } from "../store"
import { nextGitPollDelay } from "./git-poll"
import {
  FOLDER_GIT_MIN_MS,
  gitTargets,
  learn,
  repoKey,
  rootOf,
  type GitWant,
  type Learned,
} from "./folder-git"

const wants = new Map<string, GitWant>()
const learned = new Map<string, Learned>()
let running = false
let turn = 0
let wake: (() => void) | null = null // ends the loop's wait early

/** `owner` (a mounted folder view) wants marks for `want`; null: no longer. A folder whose repo
 *  isn't known yet is asked right away, not at the next tick. */
export function wantGit(owner: string, want: GitWant | null): void {
  if (want) wants.set(owner, want)
  else wants.delete(owner)
  if (!want) return
  if (!running) void loop()
  else if (rootOf(learned, want) === undefined) wake?.()
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
  try {
    while (wants.size) {
      const t0 = performance.now()
      const s = useStore.getState()
      const focused = s.git?.isRepo ? s.git.root : undefined
      const targets = gitTargets([...wants.values()], learned, focused, Date.now())
      // A folder never asked yet first (it was just shown); else the repos in turn.
      const fresh = targets.find((w) => rootOf(learned, w) === undefined)
      const t = fresh ?? targets[turn++ % Math.max(1, targets.length)]
      if (t) {
        try {
          const g = await ipc.gitStatus(t.path, t.wsl)
          learn(learned, t, g, Date.now())
          if (g.isRepo) useStore.getState().setFolderGit(repoKey(t.wsl, g.root), g)
        } catch {
          // a failed status: try again next round
        }
      }
      prune()
      await sleep(Math.max(FOLDER_GIT_MIN_MS, nextGitPollDelay(performance.now() - t0)))
    }
  } finally {
    running = false
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
