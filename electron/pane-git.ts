// Branch + GitHub PR per terminal for the sidebar. The renderer polls with its terminals'
// cwds; everything here is async, cached and deduped in the main process — nowhere near the
// PTY → renderer path. PRs come from the GitHub CLI (`gh`, the user's own login — minmux
// stores no token); if gh is missing / logged out / there's no PR, the line just stays hidden.

import { execFile } from "node:child_process"
import { access, readFile, realpath } from "node:fs/promises"
import { promisify } from "node:util"
import type { PaneGitInfo, PaneGitRequest, PrInfo, PrState } from "../src/lib/pane-git"
import { wslArgs } from "./git"

const exec = promisify(execFile)

const headFile = (gitDir: string) => `${gitDir}/HEAD`

export interface HeadInfo {
  branch: string | null
  root: string
  gitDir?: string // the checkout's git dir (a worktree's own): its HEAD says if the branch moved
  prefix?: string
}

/** `git rev-parse --abbrev-ref HEAD --show-toplevel --absolute-git-dir --show-prefix` →
 *  branch (null if detached) + repo root + git dir + the folder's place in the repo ("" = the
 *  root; git resolves symlinks). */
export function parseHeadInfo(out: string): HeadInfo | null {
  // git ends its output with a newline: drop that one, so a missing prefix line stays missing
  // (at the root the prefix line is there, just empty).
  const [branch, root, gitDir, prefix] = out.replace(/\r?\n$/, "").split(/\r?\n/)
  if (!branch || !root) return null
  const head: HeadInfo = { branch: branch === "HEAD" ? null : branch, root }
  if (gitDir) head.gitDir = gitDir
  // No prefix line at all: unknown (never taken for the root).
  if (prefix !== undefined) head.prefix = prefix.replace(/\/+$/, "")
  return head
}

/** `gh pr view --json number,state,url,isDraft` → PrInfo (null if unparseable). */
export function parsePrView(out: string): PrInfo | null {
  let o: unknown
  try {
    o = JSON.parse(out)
  } catch {
    return null
  }
  if (!o || typeof o !== "object") return null
  const r = o as { number?: unknown; state?: unknown; url?: unknown; isDraft?: unknown }
  if (typeof r.number !== "number" || typeof r.url !== "string") return null
  const s = typeof r.state === "string" ? r.state.toUpperCase() : ""
  const state: PrState =
    s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : r.isDraft === true ? "draft" : "open"
  return { number: r.number, state, url: r.url }
}

/** Runs a command in `cwd` (host, or inside a WSL distro) → stdout; rejects on failure. */
export type Runner = (
  cmd: "git" | "gh",
  args: string[],
  cwd: string,
  wsl?: { distro?: string },
) => Promise<string>

export const defaultRunner: Runner = async (cmd, args, cwd, wsl) => {
  const opts = { timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }
  if (wsl) {
    // A Linux cwd is only valid inside WSL — run there (same mechanism as the git panel).
    return (await exec("wsl.exe", wslArgs(wsl.distro, cwd, cmd, args), opts)).stdout
  }
  // git's messages in English whatever the user's locale: "not a git repository" is matched.
  const env = cmd === "git" ? { ...process.env, LC_ALL: "C" } : process.env
  return (await exec(cmd, args, { ...opts, cwd, env })).stdout
}

// How long a cached answer is trusted. An open PR can change any time; a merged/closed one
// is effectively final; "no PR" is rechecked sometimes (one may get opened). Past HEAD_TTL a
// branch answer is re-validated by its HEAD file's CONTENTS (read before git ran; no launch
// while unchanged), but git itself re-checks it at least every RENEW_MAX (the folder may have
// left that checkout: a removed worktree, a `git init` inside, a re-pointed symlink). A folder
// that isn't a repo is re-asked every NO_REPO_TTL (it may get `git init`ed).
const HEAD_TTL = 8_000
const RENEW_MAX = 60_000
const NO_REPO_TTL = 30_000
const READ_TIMEOUT = 2_000 // reading a HEAD file: past this, treated as unreadable (relaunch)
const REAL_TTL = 20_000 // a folder's resolved path (symlinks): rarely changes
const PR_TTL: Record<PrState | "none", number> = {
  open: 60_000,
  draft: 60_000,
  merged: 15 * 60_000,
  closed: 15 * 60_000,
  none: 2 * 60_000,
}
const GH_MISSING_BACKOFF = 10 * 60_000
const MAX_GH = 2 // concurrent gh processes (each is a network call)
// Concurrent git launches: a launch blocks main's event loop for a few ms (the spawn itself),
// so a poll over many terminals is spread out instead of landing as one long stall.
const MAX_GIT = 4
const CACHE_MAX = 256 // entries per cache — bounds memory as terminals visit many folders

interface Cached<T> {
  value: T
  at: number
  ttl: number
}

export class PaneGitService {
  private heads = new Map<string, Cached<ReturnType<typeof parseHeadInfo>>>()
  private reals = new Map<string, Cached<string | null>>()
  private prs = new Map<string, Cached<PrInfo | null>>()
  private inflight = new Map<string, Promise<unknown>>()
  // Per environment ("host" / "wsl:<distro>"): gh can be missing in one and present in another.
  private ghMissingUntil = new Map<string, number>()
  private gh = new Limiter(MAX_GH)
  private git = new Limiter(MAX_GIT)
  // head cache key → its HEAD file's contents as git answered, and when git last ran there
  private stamps = new Map<string, { stamp: string; since: number }>()
  private noRepo = new Set<string>() // head keys git said aren't in a repo (the longer TTL)
  private ghLoggedOut = new Set<string>() // environments where gh said "not logged in"

  constructor(
    private readonly run: Runner = defaultRunner,
    private readonly now: () => number = Date.now,
    private readonly resolve: (p: string) => Promise<string> = realpath,
    private readonly files: {
      read: (p: string) => Promise<string | null>
      exists: (p: string) => Promise<boolean>
    } = {
      read: (p) =>
        readFile(p, "utf8").then(
          (t) => t,
          () => null,
        ),
      exists: (p) =>
        access(p).then(
          () => true,
          () => false,
        ),
    },
  ) {}

  /** Branch + PR for each requested terminal, plus its real path (symlinks resolved — host
   *  only) so the renderer can tell two spellings of one folder apart, repo or not. Returns
   *  as soon as the (fast, local) branches are known: a PR not cached yet is fetched in the
   *  background and flagged `prPending`, so the caller re-asks shortly instead of waiting on
   *  the network behind other panes' gh calls. */
  async lookup(reqs: PaneGitRequest[]): Promise<Record<string, PaneGitInfo>> {
    const out: Record<string, PaneGitInfo> = {}
    await Promise.all(
      reqs.map(async (r) => {
        const [head, real] = await Promise.all([this.head(r), this.real(r)])
        const info: PaneGitInfo = {}
        if (real) info.real = real
        out[r.paneId] = info
        if (!head) return // not a repo: just the real path
        if (head.branch) info.branch = head.branch
        info.root = head.root
        if (head.prefix !== undefined) info.prefix = head.prefix
        // Why no PR line can show here (the sidebar says so on hover).
        const env = this.envKey(r)
        if (head.branch && !r.noPr) {
          if (this.now() < (this.ghMissingUntil.get(env) ?? 0)) info.gh = "missing"
          else if (this.ghLoggedOut.has(env)) info.gh = "unauthenticated"
          const hit = this.prs.get(this.prKey(r, head.root, head.branch))
          if (hit?.value) info.pr = hit.value // (a stale value beats a blank while refreshing)
          if (!hit || this.now() - hit.at >= hit.ttl) {
            info.prPending = true
            void this.pr(r, head.root, head.branch)
          }
        }
      }),
    )
    return out
  }

  // The folder's real path (host only: a WSL path can't be resolved from Windows).
  private real(r: PaneGitRequest) {
    if (r.wsl) return Promise.resolve(null)
    return this.cached(this.reals, r.cwd, REAL_TTL, () => this.resolve(r.cwd).catch(() => null))
  }

  private envKey = (r: PaneGitRequest) => (r.wsl ? `wsl:${r.wsl.distro ?? ""}` : "host")
  private prKey = (r: PaneGitRequest, root: string, branch: string) =>
    `${this.envKey(r)}|${root}|${branch}`

  private async head(r: PaneGitRequest) {
    const key = `${this.envKey(r)}|${r.cwd}`
    const hit = this.heads.get(key)
    if (hit && this.now() - hit.at < hit.ttl) return hit.value
    // Expired, but HEAD's contents unchanged since git answered (no checkout, no branch
    // rename): still right — renew without a launch, up to RENEW_MAX. (WSL: a Linux path
    // can't be read from Windows; relaunch.)
    const st = this.stamps.get(key)
    const gitDir = hit?.value?.gitDir
    let read: string | null | undefined // a renewal's read of HEAD, reused below as `before`
    // Renew only while the renewed answer still ends within RENEW_MAX of git's last run.
    if (hit && gitDir && st && !r.wsl && this.now() - st.since + HEAD_TTL <= RENEW_MAX) {
      read = await this.once(`stamp|${key}`, () => this.readHead(gitDir))
      // Unchanged — and nothing newer landed while we read (a parallel git answer wins).
      if (
        read !== null &&
        read === st.stamp &&
        this.heads.get(key) === hit &&
        this.stamps.get(key) === st
      ) {
        hit.at = this.now()
        this.heads.delete(key) // re-insert: a renewed entry is a recently used one
        this.heads.set(key, hit)
        return hit.value
      }
    }
    const ttl = (v: HeadInfo | null) => (v || !this.noRepo.has(key) ? HEAD_TTL : NO_REPO_TTL)
    return this.cached(this.heads, key, ttl, async () => {
      // HEAD's contents BEFORE git runs: a checkout landing after this read makes them differ
      // next time (read after, it could pair the new HEAD with the old branch).
      const before =
        read !== undefined ? read : gitDir && !r.wsl ? await this.readHead(gitDir) : null
      let out: HeadInfo | null = null
      try {
        out = parseHeadInfo(
          await this.git.run(() =>
            this.run(
              "git",
              [
                "rev-parse",
                "--abbrev-ref",
                "HEAD",
                "--show-toplevel",
                "--absolute-git-dir",
                "--show-prefix",
              ],
              r.cwd,
              r.wsl,
            ),
          ),
        )
        this.noRepo.delete(key)
      } catch (e) {
        // Not a repo: re-asked less often. Anything else (no commit yet, a timeout): soon.
        const msg = String((e as { stderr?: string }).stderr ?? e)
        this.noRepo.delete(key)
        if (/not a git repository/i.test(msg)) this.noRepo.add(key)
      }
      // The stamp: what HEAD said when git answered. First answer for this folder (no git dir
      // known before): read now — a checkout in that tiny window is caught by RENEW_MAX.
      const stamp =
        !out?.gitDir || r.wsl
          ? null
          : out.gitDir === gitDir
            ? before
            : await this.readHead(out.gitDir)
      // Reftable repos keep a fixed stub in HEAD (the real HEAD lives in reftable/): no shortcut.
      this.stamps.delete(key) // (re-)insert at the end: eviction drops the least recently used
      if (stamp !== null && !stamp.includes("refs/heads/.invalid"))
        this.stamps.set(key, { stamp, since: this.now() })
      if (this.stamps.size > CACHE_MAX) this.stamps.delete(this.stamps.keys().next().value!)
      if (this.noRepo.size > CACHE_MAX) this.noRepo.delete(this.noRepo.values().next().value!)
      return out
    })
  }

  /** A checkout's HEAD file, or null — given up after READ_TIMEOUT (a dead mount mustn't hang
   *  the lookup; the read itself may stay stuck, but nothing waits on it). */
  private readHead(gitDir: string): Promise<string | null> {
    return Promise.race([
      this.files.read(headFile(gitDir)),
      new Promise<null>((r) => setTimeout(() => r(null), READ_TIMEOUT).unref?.()),
    ])
  }

  /** One in-flight run per key (a read of the same file is shared, never stacked). */
  private once<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const running = this.inflight.get(key) as Promise<T> | undefined
    if (running) return running
    const p = fn().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  private pr(r: PaneGitRequest, root: string, branch: string) {
    const env = this.envKey(r)
    const ttl = (v: PrInfo | null) => PR_TTL[v?.state ?? "none"]
    return this.cached(this.prs, this.prKey(r, root, branch), ttl, async () => {
      if (this.now() < (this.ghMissingUntil.get(env) ?? 0)) return null
      return this.gh.run(async () => {
        try {
          // No branch argument: gh resolves the checked-out branch's PR from its tracking
          // config and matches the head REPO too. `gh pr view <name>` matches by head-branch
          // name only — on `main` it could show a fork's unrelated PR from its own `main`.
          const json = await this.run(
            "gh",
            ["pr", "view", "--json", "number,state,url,isDraft"],
            root,
            r.wsl,
          )
          this.ghLoggedOut.delete(env)
          return parsePrView(json)
        } catch (e) {
          const code = (e as { code?: string | number }).code
          if (code === 4) {
            this.ghLoggedOut.add(env) // gh's "not logged in" exit code
          } else if (
            /no pull requests found/i.test(String((e as { stderr?: string }).stderr ?? e))
          ) {
            this.ghLoggedOut.delete(env) // gh ran logged in, this branch just has no PR
          } else if (
            // gh not installed (host: ENOENT; inside WSL: exit 127) → stop spawning it in this
            // environment for a while (no PR line; no noise). But a spawn whose cwd is gone
            // also says ENOENT — a deleted worktree mustn't switch PRs off for every pane.
            code === 127 ||
            (code === "ENOENT" && (r.wsl || (await this.files.exists(root))))
          ) {
            this.ghMissingUntil.set(env, this.now() + GH_MISSING_BACKOFF)
          }
          return null // no PR for this branch / not logged in / offline / no GitHub remote
        }
      })
    })
  }

  // TTL cache + in-flight dedupe: panes sharing a folder/branch share one process.
  private async cached<T>(
    map: Map<string, Cached<T>>,
    key: string,
    ttl: number | ((v: T) => number),
    load: () => Promise<T>,
  ): Promise<T> {
    const hit = map.get(key)
    if (hit && this.now() - hit.at < hit.ttl) return hit.value
    return this.once(key, () =>
      load().then((value) => {
        map.delete(key) // re-insert at the end: Map order = oldest first
        map.set(key, { value, at: this.now(), ttl: typeof ttl === "function" ? ttl(value) : ttl })
        if (map.size > CACHE_MAX) map.delete(map.keys().next().value!)
        return value
      }),
    )
  }
}

/** At most `max` runs at once; a finished run hands its slot straight to the next waiter (so
 *  a newcomer can't slip in between and exceed the cap). */
class Limiter {
  private running = 0
  private queue: (() => void)[] = []
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((res) => this.queue.push(res))
    else this.running++
    try {
      return await fn()
    } finally {
      const next = this.queue.shift()
      if (next)
        next() // the slot passes on: `running` unchanged
      else this.running--
    }
  }
}
