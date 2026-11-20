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

/** Record a poll's answer for `want` (and its repo root, so other folders in it are known). */
export function learn(
  learned: Map<string, Learned>,
  want: GitWant,
  status: Pick<GitStatus, "isRepo" | "root">,
  now: number,
): void {
  const scope = gitScope(want.wsl)
  const root = status.isRepo && status.root ? status.root : null
  learned.set(key(scope, want.path), { root, at: now })
  if (root) learned.set(key(scope, root), { root, at: now })
}

/** The repo `want` is in, as far as known: undefined unknown, null not a repo. */
export function rootOf(learned: Map<string, Learned>, want: GitWant): string | null | undefined {
  const scope = gitScope(want.wsl)
  const own = learned.get(key(scope, want.path))
  if (own) return own.root
  let best: string | undefined
  for (const [k, l] of learned) {
    if (!l.root || !k.startsWith(`${scope}\0`)) continue
    if (isInside(want.path, l.root) && (!best || l.root.length > best.length)) best = l.root
  }
  return best
}

/** The folders to poll this round, one per repo: unknown ones, and known repos other than the
 *  focused terminal's; a "not a repo" answer is trusted for NOT_REPO_TTL. */
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
    const root = rootOf(learned, w)
    if (root === null && own && now - own.at < NOT_REPO_TTL) continue
    if (root && !w.wsl && focusedRoot && samePath(root, focusedRoot)) continue
    const k = root ? key(gitScope(w.wsl), root) : key(gitScope(w.wsl), w.path)
    if (repos.has(k)) continue
    if (root) {
      if (repos.size >= MAX_REPOS) continue
      repos.add(k)
      out.push({ ...w, path: root })
    } else {
      repos.add(k)
      out.push(w)
    }
  }
  return out
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
