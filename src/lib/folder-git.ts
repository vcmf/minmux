// Git marks for folder entries in repos other than the focused terminal's (whose status the app
// already polls). Pure planning; lib/folder-git-poll runs it. Off the hot path by budget: one
// repo per tick, round-robin, a tick at most every FOLDER_GIT_MIN_MS (each `git` launch blocks
// main for a few ms), and a folder found not to be a repo isn't asked again for NOT_REPO_TTL.
import type { GitStatus } from "./ipc"
import type { WslContext } from "./wsl"
import { isInside, pathKey, samePath } from "./agent-dirs"

export const FOLDER_GIT_MIN_MS = 3000
export const NOT_REPO_TTL = 60_000
export const MAX_REPOS = 8 // repos polled at all, however many folders are shown

/** A shown folder that wants marks. */
export interface GitWant {
  path: string
  wsl?: WslContext
}

/** What a poll learned about a folder: its repo root (null: not in one), and when. */
export interface Learned {
  root: string | null
  at: number
}

/** Keeps a WSL distro's Linux paths apart from the host's. */
export const gitScope = (wsl: WslContext | undefined) => (wsl ? `wsl:${wsl.distro ?? ""}` : "")
const key = (scope: string, path: string) => `${scope}\0${pathKey(path)}`

/** The key a repo's status is stored under. */
export const repoKey = (wsl: WslContext | undefined, root: string) => key(gitScope(wsl), root)

/** The repo root as `want`'s own spelling: git resolves symlinks (macOS's /var is
 *  /private/var), so a root that isn't above `want` is matched by its trailing segments. */
export function logicalRoot(wantPath: string, root: string): string {
  if (samePath(wantPath, root) || isInside(wantPath, root)) return root
  const sep = wantPath.includes("\\") && !wantPath.includes("/") ? "\\" : "/"
  const parts = wantPath.split(sep)
  for (let n = parts.length; n > 1; n--) {
    const prefix = parts.slice(0, n).join(sep)
    const real = pathKey(root)
    const mine = pathKey(prefix)
    if (real === mine || real.endsWith(mine.startsWith("/") ? mine : `/${mine}`)) return prefix
  }
  return root
}

/** Record a poll's answer for the folder `want`. A known repo answering "not a repo" keeps what
 *  was learned (git timing out on a big repo says the same); a deleted `.git` shows on the next
 *  answer that's sure. */
export function learn(
  learned: Map<string, Learned>,
  want: GitWant,
  status: Pick<GitStatus, "isRepo" | "root">,
  now: number,
): void {
  const k = key(gitScope(want.wsl), want.path)
  const root = status.isRepo && status.root ? logicalRoot(want.path, status.root) : null
  if (root === null && learned.get(k)?.root) return
  learned.set(k, { root, at: now })
}

/** The repo the folder `want` is in, from its own answer only (a folder may be a nested repo or
 *  worktree, so another folder's repo says nothing): undefined unknown, null not a repo. */
export const rootOf = (learned: Map<string, Learned>, want: GitWant): string | null | undefined =>
  learned.get(key(gitScope(want.wsl), want.path))?.root

/** The folders to poll this round: each never asked, and one per known repo other than the
 *  focused terminal's (its own poll covers it); "not a repo" is trusted for NOT_REPO_TTL. */
export function gitTargets(
  wants: GitWant[],
  learned: Map<string, Learned>,
  focusedRoot: string | undefined,
  now: number,
): GitWant[] {
  const out: GitWant[] = []
  const repos = new Set<string>()
  for (const w of wants) {
    const own = learned.get(key(gitScope(w.wsl), w.path))
    if (!own) {
      out.push(w) // never asked: ask this folder itself
      continue
    }
    if (own.root === null) {
      if (now - own.at >= NOT_REPO_TTL) out.push(w)
      continue
    }
    if (!w.wsl && focusedRoot && samePath(own.root, focusedRoot)) continue
    const k = key(gitScope(w.wsl), own.root)
    if (repos.has(k) || repos.size >= MAX_REPOS) continue
    repos.add(k)
    out.push(w)
  }
  return out
}

/** Forget what was learned about folders no longer shown. */
export function forgetOthers(learned: Map<string, Learned>, wants: GitWant[]): void {
  const keep = new Set(wants.map((w) => key(gitScope(w.wsl), w.path)))
  for (const k of [...learned.keys()]) if (!keep.has(k)) learned.delete(k)
}

/** The status covering `path` among polled repos (the innermost), if any. */
export function statusFor(
  folderGit: Record<string, GitStatus>,
  path: string,
  wsl: WslContext | undefined,
): GitStatus | undefined {
  const scope = gitScope(wsl)
  let best: GitStatus | undefined
  for (const [k, g] of Object.entries(folderGit)) {
    if (!k.startsWith(`${scope}\0`)) continue
    if (!samePath(path, g.root) && !isInside(path, g.root)) continue
    if (!best || g.root.length > best.root.length) best = g
  }
  return best
}
