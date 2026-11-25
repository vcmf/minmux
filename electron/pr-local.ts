// The pull requests dialog's local checkouts (docs/design/PR_GRAPH.md, steps 2 and 3): per repo
// the panes are in (roots grouped by their git common dir), its worktrees, its GitHub repo,
// and (graph view) how many PRs were merged into each listed PR's branch, from its commits.
// Asked once per dialog refresh, only while the dialog is open; nothing is polled. git runs
// async with a timeout and a small concurrency limit, nowhere near the PTY path.
import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { Limiter } from "./pane-git"
import { remoteFromRemotes } from "./pr-dashboard"
import {
  countMergedUnits,
  LOCAL_MAX_PRS,
  LOCAL_MAX_ROOTS,
  parseWorktrees,
  UNITS_MAX_COMMITS,
  type LocalPr,
  unitsKey,
  type LocalRepo,
  type PrLocalRequest,
  type PrLocalResult,
} from "../src/lib/pr-local"

const exec = promisify(execFile)

/** Runs git in a folder; resolves with its stdout. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>
export type DirExists = (p: string) => Promise<boolean>

const dirExists: DirExists = (p) =>
  access(p).then(
    () => true,
    () => false,
  )

/** A folder as compared against git's list: resolved, and case-blind on Windows (`c:` vs `C:`). */
const pathId = (p: string) => {
  const r = path.resolve(p)
  return process.platform === "win32" ? r.toLowerCase() : r
}

/** The folders `git worktree list --porcelain` names, whatever their state. */
const listed = (out: string) =>
  new Set(
    out
      .split(/\r?\n/)
      .filter((l) => l.startsWith("worktree "))
      .map((l) => pathId(l.slice(9))),
  )

const defaultGit: GitRunner = async (args, cwd) =>
  (await exec("git", args, { cwd, timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }))
    .stdout

const REPO_TTL = 60_000
const COMMON_MAX = 256
const UNITS_MAX = 2000
const UNITS_RETRY = 10 * 60_000 // a range git failed on (too slow, say): tried again after this

type Remote = { repo: string; name: string } | null

export class PrLocal {
  // root → its repo's common git dir (a worktree's root never moves to another repo)
  private common = new Map<string, string | null>()
  private remotes = new Map<string, { remote: Remote; at: number }>() // common dir → its remote
  // `${common dir}\0${remote}` → its default branch
  private heads = new Map<string, { branch: string | null; at: number }>()
  // (common dir, head tip, base tip, default tip) → merged units; -1: too long a range
  private units = new Map<string, number>()
  private unitsFailed = new Map<string, number>() // the same key → when git failed on it
  private git = new Limiter(3)
  private inFlight = new Map<string, Promise<PrLocalResult>>()

  constructor(
    private readonly run: GitRunner = defaultGit,
    private readonly now: () => number = Date.now,
    private readonly exists: DirExists = dirExists,
  ) {}

  /** The repos the roots are in, each once (the same request while it runs: that answer). */
  checkouts(req: PrLocalRequest): Promise<PrLocalResult> {
    const roots = [...new Set(req.roots)]
      .filter((r) => path.isAbsolute(r))
      .slice(0, LOCAL_MAX_ROOTS)
    const prs = (req.prs ?? []).slice(0, LOCAL_MAX_PRS)
    const key = JSON.stringify([[...roots].sort(), prs])
    let p = this.inFlight.get(key)
    if (!p) {
      p = this.read(roots, prs)
        .catch((): PrLocalResult => ({ ok: false }))
        .finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, p)
    }
    return p
  }

  private async read(roots: string[], prs: LocalPr[]): Promise<PrLocalResult> {
    const dirs = await Promise.all(roots.map((r) => this.commonDir(r)))
    const groups = new Map<string, string[]>() // common dir → its roots
    roots.forEach((r, i) => {
      const d = dirs[i]
      if (d) groups.set(d, [...(groups.get(d) ?? []), r])
    })
    const repos = await Promise.all(
      [...groups].map(async ([dir, rs]): Promise<LocalRepo | null> => {
        // the first of its roots git can run in (a worktree removed since: the next one)
        let list: string | null = null
        let root = rs[0]!
        for (const r of rs) {
          list = await this.git
            .run(() => this.run(["worktree", "list", "--porcelain"], r))
            .catch(() => null)
          if (list !== null) {
            root = r
            break
          }
          this.common.delete(r) // (looked up again next time: it may be gone, or moved)
        }
        if (list === null) return null
        // a root the repo no longer lists (removed, re-cloned as another repo): looked up again
        const named = listed(list)
        for (const r of rs) if (!named.has(pathId(r))) this.common.delete(r)
        // (a locked worktree on a drive that's gone is never marked prunable)
        const all = parseWorktrees(list)
        const here = await Promise.all(all.map((w) => this.exists(w.path)))
        const worktrees = all.filter((_, i) => here[i])
        const remote = await this.remoteOf(dir, root)
        // (only roots the repo still lists: one removed or re-cloned as another repo isn't its)
        const repo: LocalRepo = {
          repo: remote?.repo ?? null,
          worktrees,
          roots: rs.filter((r) => named.has(pathId(r))),
        }
        const mine = remote
          ? prs.filter((p) => p.repo.toLowerCase() === remote.repo.toLowerCase())
          : []
        const [head, merged] = await Promise.all([
          remote ? this.defaultOf(dir, root, remote.name) : null,
          remote && mine.length ? this.mergedUnits(dir, root, remote.name, mine) : undefined,
        ])
        if (head) repo.defaultBranch = head
        if (merged) repo.merged = merged
        return repo
      }),
    )
    return { ok: true, repos: repos.filter((r): r is LocalRepo => r !== null) }
  }

  private async commonDir(root: string): Promise<string | null> {
    if (this.common.has(root)) return this.common.get(root)!
    // (relative to the root when it's the repo's own `.git`; `--path-format` needs git 2.31)
    const out = await this.git
      .run(() => this.run(["rev-parse", "--git-common-dir"], root))
      .catch(() => null)
    const dir = out?.trim() ? path.resolve(root, out.trim()) : null
    // a failure isn't kept (a folder made a repo later, git busy): asked again next refresh
    if (dir) {
      if (this.common.size >= COMMON_MAX) this.common.delete(this.common.keys().next().value!)
      this.common.set(root, dir)
    }
    return dir
  }

  private async remoteOf(dir: string, root: string): Promise<Remote> {
    const hit = this.remotes.get(dir)
    if (hit && this.now() - hit.at < REPO_TTL) return hit.remote
    const remote = await this.git
      .run(() => this.run(["remote", "-v"], root))
      .then(remoteFromRemotes)
      .catch(() => undefined)
    // a failure isn't kept: the last answer if there's one, else asked again next refresh
    if (remote === undefined) return hit?.remote ?? null
    if (this.remotes.size >= COMMON_MAX && !this.remotes.has(dir))
      this.remotes.delete(this.remotes.keys().next().value!)
    this.remotes.set(dir, { remote, at: this.now() })
    return remote
  }

  /** The remote's default branch, from its HEAD ref (cached like the remote). */
  private async defaultOf(dir: string, root: string, remote: string): Promise<string | null> {
    const key = `${dir}\0${remote}`
    const hit = this.heads.get(key)
    if (hit && this.now() - hit.at < REPO_TTL) return hit.branch
    // for-each-ref answers "" (exit 0) when the remote has no HEAD ref: an answer, kept; only a
    // failing git keeps the last one and asks again next time.
    const out = await this.git
      .run(() =>
        this.run(["for-each-ref", "--format=%(symref:short)", `refs/remotes/${remote}/HEAD`], root),
      )
      .catch(() => undefined)
    let branch =
      out === undefined ? (hit?.branch ?? null) : out.trim().replace(`${remote}/`, "") || null
    // A remote added by hand (`upstream` in a fork) has no HEAD ref until `set-head`: origin's
    // HEAD is the next best guess (a clone sets it).
    if (out !== undefined && !branch && remote !== "origin") {
      const o = await this.git
        .run(() =>
          this.run(["for-each-ref", "--format=%(symref:short)", "refs/remotes/origin/HEAD"], root),
        )
        .catch(() => undefined)
      if (o === undefined) return hit?.branch ?? null // a failing git: not kept, asked again
      branch = o.trim().replace("origin/", "") || null
    }
    if (out !== undefined) {
      if (this.heads.size >= COMMON_MAX && !this.heads.has(key))
        this.heads.delete(this.heads.keys().next().value!)
      this.heads.set(key, { branch, at: this.now() })
    }
    return branch
  }

  // From the remote's refs (no checkout needed; a local branch not pulled doesn't lag): the
  // commits on the PR's branch, not on its base nor the default branch (a stacked PR doesn't
  // count its base's units, nor the default branch's merged in by "Update branch").
  /** Each PR's head → the PRs GitHub merged into it (a PR whose refs aren't fetched: none). */
  private async mergedUnits(
    dir: string,
    root: string,
    remote: string,
    prs: LocalPr[],
  ): Promise<Record<string, number>> {
    const prefix = `refs/remotes/${remote}/`
    // only the refs asked about (a repo with thousands of remote branches lists just these),
    // and the remote's HEAD: the default branch when the row doesn't name it (an older answer)
    const names = new Set(["HEAD"])
    for (const p of prs) {
      names.add(p.head)
      names.add(p.base)
      if (p.defaultBranch) names.add(p.defaultBranch)
    }
    const patterns = [...names].map((n) => prefix + n)
    const out = await this.git
      .run(() =>
        this.run(["for-each-ref", "--format=%(refname)%00%(objectname)", ...patterns], root),
      )
      .catch(() => "")
    const tips = new Map<string, string>()
    for (const line of out.split(/\r?\n/)) {
      const [ref, sha] = line.split("\0")
      if (ref?.startsWith(prefix) && sha) tips.set(ref.slice(prefix.length), sha)
    }
    const merged: Record<string, number> = {}
    await Promise.all(
      prs.map(async (p) => {
        const head = tips.get(p.head)
        const base = tips.get(p.base)
        if (!head || !base || head === base) return
        const def = tips.get(p.defaultBranch ?? "HEAD")
        const key = [dir, head, base, def ?? ""].join("\0")
        let n = this.units.get(key)
        const failed = this.unitsFailed.get(key)
        if (n === undefined && failed !== undefined && this.now() - failed < UNITS_RETRY) return
        if (n === undefined) {
          const not = def && def !== base ? [`^${def}`] : []
          const log = await this.git
            .run(() =>
              this.run(
                [
                  "log",
                  "--format=%ce%x00%s",
                  `--max-count=${UNITS_MAX_COMMITS + 1}`,
                  `${base}..${head}`,
                  ...not,
                ],
                root,
              ),
            )
            .catch(() => null)
          if (log === null) {
            // (kept a while: a range too slow for the timeout isn't run again every refresh)
            if (this.unitsFailed.size >= UNITS_MAX)
              this.unitsFailed.delete(this.unitsFailed.keys().next().value!)
            this.unitsFailed.set(key, this.now())
            return
          }
          this.unitsFailed.delete(key)
          const lines = log.split(/\r?\n/).filter(Boolean).length
          n = lines > UNITS_MAX_COMMITS ? -1 : countMergedUnits(log)
          if (this.units.size >= UNITS_MAX) this.units.delete(this.units.keys().next().value!)
          this.units.set(key, n)
        }
        if (n >= 0) merged[unitsKey(p.head, p.base)] = n
      }),
    )
    return merged
  }
}
