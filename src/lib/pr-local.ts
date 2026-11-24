// Local checkouts for the pull requests dialog (docs/design/PR_GRAPH.md, step 2): the linked
// worktrees of the repos the panes are in, read in main with `git worktree list`, and which PR
// each one has checked out. Shared with main; pure.
import type { PrRow } from "./pr-dashboard"

/** A `prs:local` request: the checkout roots the panes are in (host only). */
export interface PrLocalRequest {
  roots: string[]
}

/** A worktree with a branch checked out (bare, detached and prunable ones are left out). */
export interface LocalWorktree {
  path: string
  branch: string
}

/** One repo the panes are in: its GitHub repo (null: no GitHub remote) and its worktrees. */
export interface LocalRepo {
  repo: string | null
  worktrees: LocalWorktree[]
}

export type PrLocalResult = { ok: true; repos: LocalRepo[] } | { ok: false }

// Each new root costs one `git rev-parse`, once (its repo is remembered); the worktree list
// is per repo, however many of its roots are open.
/** At most this many roots in one request. */
export const LOCAL_MAX_ROOTS = 128

/** `git worktree list --porcelain` → the worktrees on a branch (never throws). */
export function parseWorktrees(out: string): LocalWorktree[] {
  const list: LocalWorktree[] = []
  for (const block of out.split(/\r?\n\r?\n/)) {
    let path = ""
    let branch = ""
    let skip = false
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) path = line.slice(9)
      else if (line.startsWith("branch refs/heads/")) branch = line.slice(18)
      else if (line === "bare" || line === "detached" || line.startsWith("prunable")) skip = true
    }
    if (path && branch && !skip) list.push({ path, branch })
  }
  return list
}

// Trailing separators dropped, `\\` as `/`, a drive letter in upper case (git on Windows
// writes `C:/…`; a pane's root may say `c:\\…`).
const norm = (p: string) =>
  p
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)

/** A WSL path on a Windows drive (`/mnt/c/w/r`) as Windows writes it (`C:/w/r`); else null. */
export function hostPathOfWsl(p: string): string | null {
  const m = /^\/mnt\/([a-zA-Z])(\/.*)?$/.exec(p)
  return m ? `${m[1]!.toUpperCase()}:${m[2] ?? "/"}` : null
}

/** A folder's last part ("~/w/term/.worktrees/x" → "x"). */
export const folderName = (p: string) => norm(p).split(/[\\/]/).pop() || p

// `known`: the folders panes are in (any of their checkouts). A fork's PR is never matched: a
// branch of the same name isn't its code.
/** Each PR url → the worktrees with its branch checked out and no pane in them. */
export function worktreeCheckouts(
  repos: LocalRepo[],
  rows: PrRow[],
  known: Iterable<string>,
): Map<string, string[]> {
  const inPane = new Set([...known].map(norm))
  const byKey = new Map<string, string[]>() // repo + branch → folders
  for (const r of repos) {
    if (!r.repo) continue
    for (const w of r.worktrees) {
      if (inPane.has(norm(w.path))) continue
      const k = `${r.repo.toLowerCase()}\0${w.branch}`
      const had = byKey.get(k) ?? []
      if (!had.includes(w.path)) byKey.set(k, [...had, w.path])
    }
  }
  const out = new Map<string, string[]>()
  for (const row of rows) {
    if (row.fork || !row.head) continue
    const paths = byKey.get(`${row.repo.toLowerCase()}\0${row.head}`)
    if (paths) out.set(row.url, paths)
  }
  return out
}
