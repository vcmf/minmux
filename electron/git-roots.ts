// The sidebar's `edits` line: which checkout each folder an agent worked in lies in, by the
// fs worker's `.git` search (no git process). A WSL pane's Linux folders are searched through
// the distro's UNC share, form by form (as the files browser reads them), and mapped back.
import { uncToWslPath } from "./wsl-paths"
import { MAX_GIT_ROOTS, type GitRootRequest } from "../src/lib/pane-git"
import type { WslContext } from "../src/lib/wsl"

/** One batched search: each path's root (null: none); failed paths left out. */
export type SearchFn = (paths: string[], real: boolean) => Promise<Record<string, string | null>>

// Windows spells a root `C:\\x`, git `C:/x`: the search's are given git's spelling, so both
// group as one checkout.
const gitSpelling = (p: string) => (/^[A-Za-z]:\\/.test(p) ? p.replace(/\\/g, "/") : p)

/** Each folder's checkout root (null: in none); a folder whose search failed is left out. */
export async function findGitRoots(
  reqs: GitRootRequest[],
  search: SearchFn,
  targets: (dir: string, wsl: WslContext) => string[],
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {}
  const list = reqs.slice(0, MAX_GIT_ROOTS)
  // Folder tabs want their root in their own spelling (a symlink kept); the sidebar's, resolved.
  const host = list.filter((r) => !r.wsl && !r.spelled).map((r) => r.dir)
  const spelled = list.filter((r) => !r.wsl && r.spelled).map((r) => r.dir)
  const byDistro = new Map<string, GitRootRequest[]>()
  for (const r of list) {
    if (!r.wsl) continue
    const g = byDistro.get(r.wsl.distro ?? "")
    if (g) g.push(r)
    else byDistro.set(r.wsl.distro ?? "", [r])
  }
  const jobs: Promise<void>[] = []
  if (host.length)
    jobs.push(
      search(host, true).then(
        (roots) => {
          for (const [d, r] of Object.entries(roots)) out[d] = r && gitSpelling(r)
        },
        () => {},
      ),
    )
  if (spelled.length)
    jobs.push(
      search(spelled, false).then(
        (roots) => {
          // In the folder's own spelling (C:\\x stays C:\\x): its rows are spelled that way.
          for (const [d, r] of Object.entries(roots)) out[d] = r
        },
        () => {},
      ),
    )
  for (const group of byDistro.values()) jobs.push(searchWsl(group, search, targets, out))
  await Promise.all(jobs)
  return out
}

// Symlinks aren't resolved through the share (its UNC spelling is no Linux path).
async function searchWsl(
  group: GitRootRequest[],
  search: SearchFn,
  targets: (dir: string, wsl: WslContext) => string[],
  out: Record<string, string | null>,
): Promise<void> {
  let left = group
  for (let form = 0; left.length; form++) {
    const asked = new Map<string, string>() // target → folder
    for (const r of left) {
      const t = targets(r.dir, r.wsl!)[form]
      if (t && t !== r.dir) asked.set(t, r.dir) // no share path (distro unknown): git's turn
    }
    if (!asked.size) return
    let roots: Record<string, string | null>
    try {
      roots = await search([...asked.keys()], false)
    } catch {
      return // hung or busy (a stopped distro, a dead share): don't hang the next form too
    }
    for (const [t, dir] of asked) {
      if (!(t in roots)) continue
      const root = roots[t]!
      if (root === null) out[dir] = null
      else {
        const linux = uncToWslPath(root)
        if (linux) out[dir] = linux // (not a share path: no answer)
      }
    }
    left = left.filter((r) => !(r.dir in out))
  }
}
