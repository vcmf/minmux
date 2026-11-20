// Runs lib/folder-git's plan. Each tick: look up the roots of folders that need it (one batched
// `.git` search in the fs worker), then one `git status`: a repo never polled first, then the
// repo focus just left, else the next in turn. Stops, and forgets, when no folder wants marks.
import { ipc } from "./ipc"
import { useStore } from "../store"
import { nextGitPollDelay } from "./git-poll"
import {
  FOLDER_GIT_MIN_MS,
  forgetOthers,
  learnRoots,
  repoKey,
  reposOf,
  rootLookups,
  rootOf,
  wantKey,
  type GitWant,
  type Learned,
} from "./folder-git"
import { samePath } from "./agent-dirs"

const wants = new Map<string, GitWant>()
const learned = new Map<string, Learned>()
let running = false
let turn = 0
let wake: (() => void) | null = null // ends the loop's wait early
let woken = false // a wake that came mid-tick: the next wait is skipped
const tried = new Set<string>() // repos asked at least once (answered or not)
let lastFocused: string | undefined // the focused terminal's repo at the last tick

/** `owner` (a mounted folder view) wants marks for `want`; null: no longer. */
export function wantGit(owner: string, want: GitWant | null): void {
  if (want) wants.set(owner, want)
  else wants.delete(owner)
  if (!want) return
  if (!running) void loop()
  else if (rootOf(learned, want) === undefined) nudge() // a new folder: now, not next tick
}

const focusedRoot = () => {
  const g = useStore.getState().git
  return g?.isRepo ? g.root : undefined
}

/** End the current wait, or the next one when the loop is mid-tick. */
function nudge(): void {
  if (wake) wake()
  else woken = true
}

const sleep = (ms: number) =>
  new Promise<void>((r) => {
    if (woken) {
      woken = false
      return r()
    }
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
  const off = useStore.subscribe((s, prev) => {
    if (s.git?.root !== prev.git?.root) nudge() // focus left a repo: re-check it now
  })
  try {
    while (wants.size) {
      const t0 = performance.now()
      await tick()
      await sleep(Math.max(FOLDER_GIT_MIN_MS, nextGitPollDelay(performance.now() - t0)))
    }
  } finally {
    off()
    running = false
    learned.clear()
    tried.clear()
    woken = false
    publish([])
  }
}

async function tick(): Promise<void> {
  const all = [...wants.values()]
  forgetOthers(learned, all)
  const ask = rootLookups(all, learned, Date.now())
  if (ask.length) {
    const answers = await ipc
      .gitRoots(ask.map((w) => ({ dir: w.path, wsl: w.wsl, ...(w.wsl ? {} : { spelled: true }) })))
      .catch(() => ({}) as Record<string, string | null>)
    learnRoots(learned, ask, answers, Date.now())
  }
  const focused = focusedRoot()
  const left = lastFocused && lastFocused !== focused ? lastFocused : undefined
  lastFocused = focused
  const repos = reposOf([...wants.values()], learned, focused)
  publish(repos.map((r) => repoKey(r.wsl, r.root)))
  // A repo never asked first, once: one that keeps failing (a timeout, a repo git refuses)
  // must not take every tick from the others.
  const r =
    repos.find((x) => !tried.has(repoKey(x.wsl, x.root))) ??
    repos.find((x) => !!left && !x.wsl && samePath(x.root, left)) ??
    repos[turn++ % Math.max(1, repos.length)]
  if (!r) return
  tried.add(repoKey(r.wsl, r.root))
  try {
    const g = await ipc.gitStatus(r.root, r.wsl)
    // Not a repo now: a timeout on a big one, or a .git just deleted (the next root lookup
    // tells). Either way the marks we had stay until then.
    if (g.isRepo) useStore.getState().setFolderGit(repoKey(r.wsl, r.root), { ...g, root: r.root })
  } catch {
    // a failed status: next turn
  }
}

/** Give the store each shown folder's root, and drop the statuses of repos not in `keep`. */
function publish(keep: string[]): void {
  const s = useStore.getState()
  const roots: Record<string, string | null> = {}
  for (const w of wants.values()) {
    const r = rootOf(learned, w)
    if (r !== undefined) roots[wantKey(w)] = r
  }
  s.setFolderRoots(roots)
  const k = new Set(keep)
  for (const key of Object.keys(s.folderGit)) if (!k.has(key)) s.setFolderGit(key, null)
}
