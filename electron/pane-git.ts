// Branch + GitHub PR per terminal for the sidebar. The renderer polls with its terminals'
// cwds; everything here is async, cached and deduped in the main process — nowhere near the
// PTY → renderer path. PRs come from the GitHub CLI (`gh`, the user's own login — minmux
// stores no token); if gh is missing / logged out / there's no PR, the line just stays hidden.

import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { promisify } from "node:util"
import type { PaneGitInfo, PaneGitRequest, PrInfo, PrState } from "../src/lib/pane-git"
import { wslArgs } from "./git"

const exec = promisify(execFile)

/** `git rev-parse --abbrev-ref HEAD --show-toplevel --show-prefix` → branch (null if
 *  detached) + repo root + the folder's place in it ("" = the root; git resolves symlinks). */
export function parseHeadInfo(
  out: string,
): { branch: string | null; root: string; prefix?: string } | null {
  const [branch, root, prefix] = out.split(/\r?\n/) // the prefix line is empty at the root
  if (!branch || !root) return null
  const head = { branch: branch === "HEAD" ? null : branch, root }
  // No prefix line at all: unknown (never taken for the root).
  return prefix === undefined ? head : { ...head, prefix: prefix.replace(/\/+$/, "") }
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
  return (await exec(cmd, args, { ...opts, cwd })).stdout
}

// How long a cached answer is trusted. An open PR can change any time; a merged/closed one
// is effectively final; "no PR" is rechecked sometimes (one may get opened).
const HEAD_TTL = 8_000
const PR_TTL: Record<PrState | "none", number> = {
  open: 60_000,
  draft: 60_000,
  merged: 15 * 60_000,
  closed: 15 * 60_000,
  none: 2 * 60_000,
}
const GH_MISSING_BACKOFF = 10 * 60_000
const MAX_GH = 2 // concurrent gh processes (each is a network call)
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
  private ghRunning = 0
  private ghQueue: (() => void)[] = []

  constructor(
    private readonly run: Runner = defaultRunner,
    private readonly now: () => number = Date.now,
    private readonly resolve: (p: string) => Promise<string> = realpath,
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
        if (head.branch && !r.noPr) {
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
    return this.cached(this.reals, r.cwd, HEAD_TTL, () => this.resolve(r.cwd).catch(() => null))
  }

  private envKey = (r: PaneGitRequest) => (r.wsl ? `wsl:${r.wsl.distro ?? ""}` : "host")
  private prKey = (r: PaneGitRequest, root: string, branch: string) =>
    `${this.envKey(r)}|${root}|${branch}`

  private head(r: PaneGitRequest) {
    return this.cached(this.heads, `${this.envKey(r)}|${r.cwd}`, HEAD_TTL, async () => {
      try {
        return parseHeadInfo(
          await this.run(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD", "--show-toplevel", "--show-prefix"],
            r.cwd,
            r.wsl,
          ),
        )
      } catch {
        return null // not a repo (or git missing)
      }
    })
  }

  private pr(r: PaneGitRequest, root: string, branch: string) {
    const env = this.envKey(r)
    const ttl = (v: PrInfo | null) => PR_TTL[v?.state ?? "none"]
    return this.cached(this.prs, this.prKey(r, root, branch), ttl, async () => {
      if (this.now() < (this.ghMissingUntil.get(env) ?? 0)) return null
      return this.withGhSlot(async () => {
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
          return parsePrView(json)
        } catch (e) {
          // gh not installed (host: ENOENT; inside WSL: exit 127) → stop spawning it in this
          // environment for a while (no PR line; no noise).
          const code = (e as { code?: string | number }).code
          if (code === "ENOENT" || code === 127) {
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
    const running = this.inflight.get(key) as Promise<T> | undefined
    if (running) return running
    const p = load().then((value) => {
      map.delete(key) // re-insert at the end: Map order = oldest first
      map.set(key, { value, at: this.now(), ttl: typeof ttl === "function" ? ttl(value) : ttl })
      if (map.size > CACHE_MAX) map.delete(map.keys().next().value!)
      this.inflight.delete(key)
      return value
    })
    this.inflight.set(key, p)
    return p
  }

  private async withGhSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.ghRunning >= MAX_GH) await new Promise<void>((res) => this.ghQueue.push(res))
    this.ghRunning++
    try {
      return await fn()
    } finally {
      this.ghRunning--
      this.ghQueue.shift()?.()
    }
  }
}
