// Local checkouts for the pull requests dialog (docs/design/PR_GRAPH.md, step 2): the linked
// worktrees of the repos the panes are in, read in main with `git worktree list`, and which PR
// each one has checked out. Shared with main; pure.
import type { PrRow } from "./pr-dashboard"
import { stackedOn } from "./pr-stacks"

/** A PR whose merged units to count (its repo's remote refs, read in main). */
export interface LocalPr {
  repo: string
  head: string
  base: string
  defaultBranch?: string
}

/** A `prs:local` request: the checkout roots the panes are in (host only), and (graph view)
 *  the PRs to count merged units of. */
export interface PrLocalRequest {
  roots: string[]
  prs?: LocalPr[]
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
  merged?: Record<string, number> // head branch → PRs merged into it (from its commits)
}

export type PrLocalResult = { ok: true; repos: LocalRepo[] } | { ok: false }

// Each new root costs one `git rev-parse`, once (its repo is remembered); the worktree list
// is per repo, however many of its roots are open.
/** A renderer's `prs:local` request, checked (null: not one). */
export function parseLocalRequest(v: unknown): PrLocalRequest | null {
  const o = v as { roots?: unknown; prs?: unknown } | null
  if (!o || !Array.isArray(o.roots)) return null
  const str = (x: unknown): x is string => typeof x === "string" && x.length > 0
  const roots = o.roots.filter(str).slice(0, LOCAL_MAX_ROOTS)
  if (!Array.isArray(o.prs)) return { roots }
  const prs: LocalPr[] = []
  for (const p of o.prs.slice(0, LOCAL_MAX_PRS)) {
    const q = p as Partial<Record<keyof LocalPr, unknown>> | null
    if (!q || !str(q.repo) || !str(q.head) || !str(q.base)) continue
    prs.push({
      repo: q.repo,
      head: q.head,
      base: q.base,
      ...(str(q.defaultBranch) ? { defaultBranch: q.defaultBranch } : {}),
    })
  }
  return { roots, prs }
}

/** At most this many roots in one request. */
export const LOCAL_MAX_ROOTS = 128
/** At most this many PRs counted in one request (a tab lists at most 90). */
export const LOCAL_MAX_PRS = 120
/** At most this many commits read per PR (a longer range shows no estimate). */
export const UNITS_MAX_COMMITS = 500

// GitHub's merge button commits as `GitHub <noreply@github.com>`, and writes the PR's number:
// `title (#N)` for a squash, `Merge pull request #N from …` for a merge commit. A hand-written
// `(#123)` (often an issue) or a cherry-pick from elsewhere has another committer.
const GITHUB_COMMITTER = "noreply@github.com"
const SQUASH = /\(#(\d+)\)\s*$/
const MERGE = /^Merge pull request #(\d+)\b/

/** `git log --format=%ce%x00%s` → how many PRs GitHub merged in (each number once). */
export function countMergedUnits(out: string): number {
  const prs = new Set<string>()
  for (const line of out.split(/\r?\n/)) {
    const at = line.indexOf("\0")
    if (at < 0 || line.slice(0, at).trim().toLowerCase() !== GITHUB_COMMITTER) continue
    const subject = line.slice(at + 1)
    const n = MERGE.exec(subject)?.[1] ?? SQUASH.exec(subject)?.[1]
    if (n) prs.add(n)
  }
  return prs.size
}

/** How many open or draft listed PRs are stacked on `row`, at any depth. */
export function openUnder(row: PrRow, rows: PrRow[]): number {
  const seen = new Set<string>([row.url])
  let n = 0
  const walk = (r: PrRow) => {
    for (const k of stackedOn(r, rows)) {
      if (seen.has(k.url)) continue
      seen.add(k.url)
      if (k.state === "open" || k.state === "draft") n++
      walk(k)
    }
  }
  walk(row)
  return n
}

/** A card's estimate: merged / (merged + open); null when there's nothing to show. */
export function progressOf(
  merged: number | undefined,
  open: number,
): { merged: number; open: number } | null {
  if (merged === undefined || merged + open === 0) return null
  return { merged, open }
}

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
