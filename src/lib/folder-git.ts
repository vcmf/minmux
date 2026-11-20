// Git marks for folder tabs in repos other than the focused terminal's (whose status the app
// already polls). Pure planning; lib/folder-git-poll runs it.
//  - A folder's repo comes from the fs worker's `.git` search up from the folder itself, in its
//    own spelling (no git process, no symlink guessing): a nested repo or worktree is its own,
//    and "no .git up the tree" is a sure "not a repo". Looked up again every ROOT_EVERY, so a
//    `git init` or a deleted `.git` shows.
//  - `git status` then runs only for marks: one repo per tick, in turn over every repo shown, a
//    tick at most every FOLDER_GIT_MIN_MS (each launch blocks main a few ms).
import type { WslContext } from "./wsl"
import { pathKey, samePath } from "./agent-dirs"

export const FOLDER_GIT_MIN_MS = 3000
export const ROOT_EVERY = 10_000

/** A shown folder that wants marks. */
export interface GitWant {
  path: string
  wsl?: WslContext
}

/** A folder's repo root (null: in none), and when it was looked up. */
export interface Learned {
  root: string | null
  at: number
}

/** A repo to poll. */
export interface GitRepo {
  root: string
  wsl?: WslContext
}

const scope = (wsl: WslContext | undefined) => (wsl ? `wsl:${wsl.distro ?? ""}` : "")

/** A folder's key (a WSL distro's Linux paths kept apart from the host's). */
export const wantKey = (w: GitWant) => `${scope(w.wsl)}\0${pathKey(w.path)}`

/** The key a repo's status is stored under. */
export const repoKey = (wsl: WslContext | undefined, root: string) =>
  `${scope(wsl)}\0${pathKey(root)}`

/** The folder's repo root as last looked up: undefined unknown, null not a repo. */
export const rootOf = (learned: Map<string, Learned>, w: GitWant): string | null | undefined =>
  learned.get(wantKey(w))?.root

/** The folders whose root to look up now: never looked up, or not for ROOT_EVERY. */
export function rootLookups(wants: GitWant[], learned: Map<string, Learned>, now: number) {
  return wants.filter((w) => {
    const l = learned.get(wantKey(w))
    return !l || now - l.at >= ROOT_EVERY
  })
}

/** Record a lookup's answers; a folder whose search failed (no answer) keeps what it had. */
export function learnRoots(
  learned: Map<string, Learned>,
  asked: GitWant[],
  answers: Record<string, string | null>,
  now: number,
): void {
  for (const w of asked)
    if (w.path in answers) learned.set(wantKey(w), { root: answers[w.path]!, at: now })
}

/** The repos the shown folders are in, each once, other than the focused terminal's. */
export function reposOf(
  wants: GitWant[],
  learned: Map<string, Learned>,
  focusedRoot: string | undefined,
): GitRepo[] {
  const out: GitRepo[] = []
  const seen = new Set<string>()
  for (const w of wants) {
    const root = rootOf(learned, w)
    if (!root) continue
    if (!w.wsl && focusedRoot && samePath(root, focusedRoot)) continue
    const k = repoKey(w.wsl, root)
    if (seen.has(k)) continue
    seen.add(k)
    out.push({ root, ...(w.wsl ? { wsl: w.wsl } : {}) })
  }
  return out
}

/** Forget the folders no longer shown. */
export function forgetOthers(learned: Map<string, Learned>, wants: GitWant[]): void {
  const keep = new Set(wants.map(wantKey))
  for (const k of [...learned.keys()]) if (!keep.has(k)) learned.delete(k)
}
