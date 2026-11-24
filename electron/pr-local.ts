// The pull requests dialog's local checkouts (docs/design/PR_GRAPH.md, step 2): per repo the
// panes are in (roots grouped by their git common dir), its worktrees and its GitHub repo.
// Asked once per dialog refresh, only while the dialog is open; nothing is polled. git runs
// async with a timeout and a small concurrency limit, nowhere near the PTY path.
import { execFile } from "node:child_process"
import path from "node:path"
import { promisify } from "node:util"
import { Limiter } from "./pane-git"
import { repoFromRemotes } from "./pr-dashboard"
import {
  LOCAL_MAX_ROOTS,
  parseWorktrees,
  type LocalRepo,
  type PrLocalRequest,
  type PrLocalResult,
} from "../src/lib/pr-local"

const exec = promisify(execFile)

/** Runs git in a folder; resolves with its stdout. */
export type GitRunner = (args: string[], cwd: string) => Promise<string>

const defaultGit: GitRunner = async (args, cwd) =>
  (await exec("git", args, { cwd, timeout: 10_000, windowsHide: true, maxBuffer: 1024 * 1024 }))
    .stdout

const REPO_TTL = 60_000
const COMMON_MAX = 256

export class PrLocal {
  // root → its repo's common git dir (a worktree's root never moves to another repo)
  private common = new Map<string, string | null>()
  private remotes = new Map<string, { repo: string | null; at: number }>() // common dir → repo
  private git = new Limiter(3)
  private inFlight = new Map<string, Promise<PrLocalResult>>()

  constructor(
    private readonly run: GitRunner = defaultGit,
    private readonly now: () => number = Date.now,
  ) {}

  /** The repos the roots are in, each once (the same request while it runs: that answer). */
  checkouts(req: PrLocalRequest): Promise<PrLocalResult> {
    const roots = [...new Set(req.roots)]
      .filter((r) => path.isAbsolute(r))
      .slice(0, LOCAL_MAX_ROOTS)
    const key = JSON.stringify([...roots].sort())
    let p = this.inFlight.get(key)
    if (!p) {
      p = this.read(roots)
        .catch((): PrLocalResult => ({ ok: false }))
        .finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, p)
    }
    return p
  }

  private async read(roots: string[]): Promise<PrLocalResult> {
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
        return { repo: await this.repoOf(dir, root), worktrees: parseWorktrees(list) }
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

  private async repoOf(dir: string, root: string): Promise<string | null> {
    const hit = this.remotes.get(dir)
    if (hit && this.now() - hit.at < REPO_TTL) return hit.repo
    const repo = await this.git
      .run(() => this.run(["remote", "-v"], root))
      .then(repoFromRemotes)
      .catch(() => undefined)
    // a failure isn't kept: the last answer if there's one, else asked again next refresh
    if (repo === undefined) return hit?.repo ?? null
    if (this.remotes.size >= COMMON_MAX && !this.remotes.has(dir))
      this.remotes.delete(this.remotes.keys().next().value!)
    this.remotes.set(dir, { repo, at: this.now() })
    return repo
  }
}
