// The pull requests dialog's data (docs/design/PR_DASHBOARD.md): one `gh api graphql` query per
// refresh, in the focused pane's environment (host, or its WSL distro). Async and on its own
// IPC channel: nowhere near the PTY → renderer path. The user's own gh login; no token here.
import { execFile } from "node:child_process"
import { access } from "node:fs/promises"
import os from "node:os"
import { promisify } from "node:util"
import { wslArgs } from "./git"
import { Limiter } from "./pane-git"
import {
  githubRepoOf,
  parsePrLists,
  parsePrRowAnswer,
  prSearches,
  PER_TAB,
  PR_QUERY,
  PR_ROW_QUERY,
  isGhLogin,
  prErrorText,
  type GhAccount,
  type PrLists,
  type PrListsError,
  type PrListsRequest,
  type PrListsResult,
  type PrRow,
} from "../src/lib/pr-dashboard"
import {
  parsePrDetail,
  PR_DETAIL_QUERY,
  type PrDetailRequest,
  type PrDetailResult,
} from "../src/lib/pr-detail"
import {
  parsePrChecks,
  PR_CHECKS_QUERY,
  type PrChecks,
  type PrChecksRequest,
  type PrChecksResult,
} from "../src/lib/pr-checks"
import {
  parseCandidates,
  PR_CANDIDATES_QUERY,
  QUERY_MAX,
  reviewerEditArgs,
  type PrCandidatesRequest,
  type PrCandidatesResult,
  type PrReviewersRequest,
  type PrReviewersResult,
} from "../src/lib/pr-reviewers"
import type { PrFindRequest, PrFindResult } from "../src/lib/pr-link"
import { mergeArgs, type PrMergeRequest, type PrMergeResult } from "../src/lib/pr-merge"
import {
  branchArgs,
  branchDone,
  parseBehind,
  PR_BEHIND_QUERY,
  pullHeadRef,
  type PrBranchRequest,
  type PrBranchResult,
} from "../src/lib/pr-branch"
import {
  alreadyPosted,
  BODY_MAX,
  MAYBE_SENT,
  norm,
  NOT_CHECKED,
  RECENT_QUERY,
  SAME_WRITE_MS,
  writeArgs,
  type PrWriteRequest,
  type PrWriteResult,
} from "../src/lib/pr-write"

const exec = promisify(execFile)

/** Runs gh / git in `cwd` (host, or inside a WSL distro) → stdout; rejects with execFile's error. */
// `token`: gh runs as that account (GH_TOKEN), never by switching gh's active one.
export type PrRunner = (
  cmd: "gh" | "git",
  args: string[],
  cwd: string,
  wsl?: { distro?: string },
  token?: string,
  input?: string, // written to its stdin (a comment's text: never on the command line)
) => Promise<string>

/** The environment a run gets: GH_TOKEN for one account (into WSL through WSLENV). */
export function tokenEnv(
  base: NodeJS.ProcessEnv,
  token: string | undefined,
  wsl: boolean,
): NodeJS.ProcessEnv | undefined {
  if (!token) return undefined
  const env: NodeJS.ProcessEnv = { ...base, GH_TOKEN: token }
  if (wsl) env.WSLENV = [base.WSLENV, "GH_TOKEN"].filter(Boolean).join(":")
  return env
}

const defaultRunner: PrRunner = async (cmd, args, cwd, wsl, token, input) => {
  const env = tokenEnv(process.env, token, !!wsl)
  const opts = { timeout: 20_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env }
  if (input === undefined) {
    if (wsl) return (await exec("wsl.exe", wslArgs(wsl.distro, cwd, cmd, args, true), opts)).stdout
    return (await exec(cmd, args, { ...opts, cwd })).stdout
  }
  // With stdin (a write): execFile's own callback (its error carries stdout / stderr). A write
  // gets far longer before it's killed: killed after GitHub took it, a retry would post twice.
  const [file, argv] = wsl ? ["wsl.exe", wslArgs(wsl.distro, cwd, cmd, args, true)] : [cmd, args]
  const wopts = { ...opts, timeout: WRITE_TIMEOUT }
  return new Promise((resolve, reject) => {
    const child = execFile(file, argv, wsl ? wopts : { ...wopts, cwd }, (err, stdout, stderr) =>
      err ? reject(Object.assign(err, { stdout, stderr })) : resolve(String(stdout)),
    )
    child.stdin?.on("error", () => {}) // gh gone before reading: its own error says why
    child.stdin?.end(input)
  })
}

/** `gh auth status --json hosts` → github.com's accounts (none: not an answer). */
export function parseAccounts(out: string): GhAccount[] {
  try {
    const list = (JSON.parse(out) as { hosts?: Record<string, unknown> }).hosts?.["github.com"]
    if (!Array.isArray(list)) return []
    return list.flatMap((a: unknown) => {
      const o = a as { login?: unknown; active?: unknown; state?: unknown }
      if (!isGhLogin(o?.login)) return []
      // "error": its token is bad; "timeout" (offline): unknown, so still used
      const acc: GhAccount = { login: o.login, active: o.active === true, ok: o.state !== "error" }
      return [o.state === "timeout" ? { ...acc, offline: true } : acc]
    })
  } catch {
    return []
  }
}

/** Accounts in the order the repo tab tries them: the one that saw it last, gh's active one, the rest. */
export function repoOrder(accounts: GhAccount[], remembered?: string): GhAccount[] {
  const rank = (a: GhAccount) => (a.login === remembered ? 0 : a.active ? 1 : 2)
  return [...accounts].sort((a, b) => rank(a) - rank(b))
}

const hostDirExists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  )

/** The gh environment a cache entry is for: the host, or a WSL distro. */
const envKey = (wsl?: { distro?: string }) => (wsl ? `wsl:${wsl.distro ?? ""}` : "host")

/** A request for an account gh no longer has (or can't vouch for): refused, never rerouted. */
const signedOut = (login: string) =>
  Object.assign(new Error(`@${login} isn't logged in to gh`), {
    code: 4,
    refused: true,
    stderr: `@${login} isn't logged in to gh here: run gh auth login, or pick another account.`,
  })

/** One key per write: the PR, the account, what, and its text (as GitHub would keep it). */
const writeKey = (r: PrWriteRequest) =>
  JSON.stringify([r.repo.toLowerCase(), r.number, r.account ?? "", r.action, norm(r.body)])

/** A write's failure that may have reached GitHub (never a clear refusal). */
export function unclearFailure(e: unknown): boolean {
  if ((e as { killed?: boolean }).killed) return true
  const stderr = String((e as { stderr?: unknown }).stderr ?? "")
  // never connected (offline, no DNS, refused): nothing reached GitHub
  if (
    /dial tcp|could not resolve|no such host|network is unreachable|connection refused/i.test(
      stderr,
    )
  )
    return false
  return /timeout|deadline exceeded|request canceled|HTTP 5\d\d|\bEOF\b|connection reset|broken pipe|GOAWAY|stream error/i.test(
    stderr,
  )
}

/** Sets a map's entry as the newest, the oldest going past 64. */
function boundedSet<V>(map: Map<string, V>, key: string, value: V) {
  map.delete(key)
  map.set(key, value)
  if (map.size > 64) map.delete(map.keys().next().value!)
}

const WRITE_TIMEOUT = 120_000
const MERGE_UNCLEAR =
  "gh didn't answer in time: it may have merged. Refresh to see before merging again."
const RETRY_PAUSE_MS = 1_500
const ANOTHER_WRITE = "Another change to this pull request is running: try again when it's done."
const BRANCH_UNCLEAR = "gh didn't answer in time: it may have gone through. Refresh to see."
// After an update gh took (or may have): how far behind, asked again after each of these until
// it's none (GitHub merges the base in on its own time; past them, it's said to be on its way).
const UPDATE_LOOKS_MS = [1_500, 3_000]
// GitHub's clock against this machine's, when checking a write. Small on purpose: an identical
// write made on purpose just before must not pass for this one.
const CLOCK_SKEW_MS = 30_000
const REPO_TTL = 60_000
const ACCOUNTS_TTL = 5 * 60_000 // then checked again behind
const WRITE_ACCOUNTS_MS = 60_000 // a write goes on a list at most this old (as before: a minute)
const ACCOUNTS_RETRY = 10_000 // offline, or gh failing: asked again soon, not on every call
const TOKEN_TTL = 10 * 60_000
const DETAIL_QUERY = PR_DETAIL_QUERY.replace(/\s+/g, " ")
const CHECKS_QUERY = PR_CHECKS_QUERY.replace(/\s+/g, " ")
const CANDIDATES_QUERY = PR_CANDIDATES_QUERY.replace(/\s+/g, " ")
const ROW_QUERY = PR_ROW_QUERY.replace(/\s+/g, " ")
const BEHIND_QUERY = PR_BEHIND_QUERY.replace(/\s+/g, " ")
const READ_ORG = /read:org/i
const NOT_FOUND = /Could not resolve to a (?:Repository|PullRequest)/i
const READ_ORG_HINT = "It needs gh's read:org scope: run gh auth refresh -s read:org"
const NO_SCOPE_TTL = 10 * 60_000 // then teams are tried again (`gh auth refresh` may have run)
const QUERY = PR_QUERY.replace(/\s+/g, " ") // one line (newlines don't survive a Windows command line)

// Prefers `upstream` (a fork's PRs live there), then `origin`, then any GitHub remote.
/** `git remote -v` → the checkout's GitHub remote: its name and repo (null: none). */
export function remoteFromRemotes(out: string): { name: string; repo: string } | null {
  const by = new Map<string, string>()
  for (const line of out.split(/\r?\n/)) {
    const [name, url] = line.split(/\s+/)
    const repo = url ? githubRepoOf(url) : null
    if (name && repo && !by.has(name)) by.set(name, repo)
  }
  const name = by.has("upstream")
    ? "upstream"
    : by.has("origin")
      ? "origin"
      : by.keys().next().value
  return name ? { name, repo: by.get(name)! } : null
}

/** `git remote -v` → the checkout's GitHub repo (null: none). */
export const repoFromRemotes = (out: string): string | null => remoteFromRemotes(out)?.repo ?? null

/** Classify a failed gh run: not installed, logged out, offline, or anything else. */
export function ghError(e: unknown): {
  error: "missing" | "unauthenticated" | "offline" | "failed"
  message?: string
} {
  const err = e as { code?: string | number; stderr?: string; killed?: boolean }
  if (err.code === "ENOENT" || err.code === 127) return { error: "missing" }
  // WSL with `-e` (no shell, so no 127): wsl.exe reports the failed exec itself.
  if (/execvpe?\(gh\) failed|gh: (?:command )?not found/i.test(String(err.stderr ?? "")))
    return { error: "missing" }
  const stderr = String(err.stderr ?? "")
  // logged out (gh's exit 4), or a token GitHub refuses (revoked, rotated): with gh's reason
  if (err.code === 4 || /HTTP 401|Bad credentials/i.test(stderr)) {
    const why = stderr
      .split(/\r?\n/)
      .find((l) => l.trim())
      ?.trim()
    return why
      ? { error: "unauthenticated", message: why.slice(0, 300) }
      : { error: "unauthenticated" }
  }
  if (
    err.killed ||
    /could not resolve host|network is unreachable|timeout|ECONN|dial tcp/i.test(stderr)
  )
    return { error: "offline" }
  const message = stderr
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim()
  return message ? { error: "failed", message: message.slice(0, 300) } : { error: "failed" }
}

type Failure = { ok: false } & ReturnType<typeof ghError>
const SUPERSEDED: Failure = { ok: false, error: "failed", message: "Superseded" }

// One run at a time, and only the newest request waits: moving through the list (or typing),
// the requests passed over are skipped (answered "superseded"), never run one after another.
/** A latest-wins queue of one. */
export class LatestLane<Req, Res> {
  private busy = false
  private next: { req: Req; resolve: (r: Res | Failure) => void } | null = null

  constructor(private readonly work: (req: Req) => Promise<Res>) {}

  run(req: Req): Promise<Res | Failure> {
    return new Promise((resolve) => {
      this.next?.resolve(SUPERSEDED)
      this.next = { req, resolve }
      this.pump()
    })
  }

  private pump(): void {
    if (this.busy || !this.next) return
    const { req, resolve } = this.next
    this.next = null
    this.busy = true
    void this.work(req)
      .catch((e): Failure => ({ ok: false, ...ghError(e) })) // an answer, never a hang
      .then(resolve)
      .finally(() => {
        this.busy = false
        this.pump()
      })
  }
}

/** The folder gh runs in: the pane's (home if it's gone; WSL: the distro's home). */
const ghCwd = async (
  req: { cwd?: string; wsl?: { distro?: string } },
  dirExists: (p: string) => Promise<boolean>,
): Promise<string> => {
  if (req.wsl) return "~"
  return req.cwd && (await dirExists(req.cwd)) ? req.cwd : os.homedir()
}

/** owner/name + number → gh's variables (null: not a PR). */
/** One key per PR and account: a compare that failed for one account isn't another's. */
const behindKey = (r: { repo: string; number: number; account?: string }) =>
  `${r.repo.toLowerCase()}#${r.number}\0${r.account ?? ""}`

/** A GraphQL error about the query's fields (GitHub answered), never a transport failure. */
const fieldError = (e: unknown) => {
  const stderr = String((e as { stderr?: unknown }).stderr ?? "")
  return (
    ghError(e).error === "failed" &&
    /^GraphQL:/m.test(stderr) &&
    !/HTTP \d{3}|rate limit|Could not resolve to a (?:Repository|PullRequest)/i.test(stderr)
  )
}

const prVars = (repo: string, number: number): string[] | null => {
  const [owner, name, extra] = repo.split("/")
  if (!owner || !name || extra !== undefined || !Number.isInteger(number)) return null
  return ["-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`]
}

/** Answers `prs:lists`: one query in flight per request; each checkout's repo cached briefly. */
export class PrDashboard {
  private repos = new Map<string, { repo: string | null; at: number }>()
  private inFlight = new Map<string, Promise<PrListsResult>>()
  private detailsInFlight = new Map<string, Promise<PrDetailResult>>()
  private gh = new Limiter(4) // its own slots (a tab each, in parallel), apart from the sidebar's gh
  private accountsCache = new Map<
    string,
    { list: GhAccount[]; at: number; until: number; failed: boolean }
  >()
  private tokens = new Map<string, { token: string; at: number }>() // in main only, never sent
  private repoAccounts = new Map<string, string>() // owner → the account that saw its repos
  private running = new Map<string, Promise<unknown>>()
  private writesInFlight = new Map<string, Promise<PrWriteResult>>()
  private unclear = new Map<string, number>() // a write whose last try ended unclear → when
  // A PR's detail and the reviewer search: each its own lane (never waits for the lists'
  // refresh), newest request only.
  private detailLane = new LatestLane((r: PrDetailRequest) => this.fetchDetail(r))
  private candidatesLane = new LatestLane((r: PrCandidatesRequest) => this.fetchCandidates(r))
  private checksLane = new LatestLane((r: PrChecksRequest) => this.fetchChecks(r))
  private noTeamScope = new Map<string, number>() // gh environment → when read:org was missing
  private noBehind = new Map<string, number>() // PR + account → when its compare failed
  private prWrites = new Map<string, string>() // PR → its last write's key (running: its own)

  constructor(
    private readonly run: PrRunner = defaultRunner,
    private readonly now: () => number = Date.now,
    private readonly dirExists: (p: string) => Promise<boolean> = hostDirExists,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** The lists for the dialog (the same request asked while it runs gets that one's answer). */
  lists(req: PrListsRequest): Promise<PrListsResult> {
    const key = JSON.stringify([
      req.cwd ?? "",
      req.wsl ? (req.wsl.distro ?? "") : null,
      req.closed,
      req.account ?? null,
      req.part ?? null,
    ])
    let p = this.inFlight.get(key)
    if (!p) {
      p = this.fetch(req).finally(() => this.inFlight.delete(key))
      this.inFlight.set(key, p)
    }
    return p
  }

  private async repoOf(cwd: string, wsl?: { distro?: string }): Promise<string | null> {
    const key = `${wsl ? `wsl:${wsl.distro ?? ""}:` : ""}${cwd}`
    const hit = this.repos.get(key)
    if (hit && this.now() - hit.at < REPO_TTL) return hit.repo
    // (the three tabs ask at once: one `git remote -v`)
    return this.once(`repo:${key}`, async () => {
      const repo = await this.run("git", ["remote", "-v"], cwd, wsl).then(
        repoFromRemotes,
        () => null,
      )
      this.repos.set(key, { repo, at: this.now() })
      if (this.repos.size > 64) this.repos.delete(this.repos.keys().next().value!)
      return repo
    })
  }

  /** gh's accounts on github.com in this environment (cached briefly; none if gh can't say). */
  // `maxAge`: a list older than that is asked for again (a write: the accounts as they are now)
  accounts(wsl?: { distro?: string }, maxAge = Infinity): Promise<GhAccount[]> {
    const key = envKey(wsl)
    const hit = this.accountsCache.get(key)
    if (hit && this.now() < hit.until && this.now() - hit.at < maxAge)
      return Promise.resolve(hit.list)
    return this.once(`accounts:${key}`, async () => {
      const home = wsl ? "~" : os.homedir()
      // (it exits 0 with --json whatever the accounts' state; an old gh without --json: none)
      let failed = false
      const list = await this.run("gh", ["auth", "status", "--json", "hosts"], home, wsl).then(
        parseAccounts,
        () => ((failed = true), []),
      )
      // Offline, or gh itself failing: kept only briefly (back online, asked again soon).
      const ttl = failed || list.some((a) => a.offline) ? ACCOUNTS_RETRY : ACCOUNTS_TTL
      this.accountsCache.set(key, { list, at: this.now(), until: this.now() + ttl, failed })
      return list
    })
  }

  // Stale while revalidating: once known, the list is used at once (asking gh means a network
  // check of each account), and asked again in the background when it's old. An account gone
  // since is still never acted as: its token lookup fails, and the request is refused.
  /** gh's accounts if known (undefined: never asked yet); an old list is refreshed behind. */
  knownAccounts(wsl?: { distro?: string }): GhAccount[] | undefined {
    const hit = this.accountsCache.get(envKey(wsl))
    if (!hit) return undefined
    // (an old list, or an old failure: gh can't say, an old gh: asked again behind, used now)
    if (this.now() >= hit.until) void this.accounts(wsl)
    return hit.list
  }

  /** The same work asked for while it runs: one run, shared. */
  private once<T>(key: string, work: () => Promise<T>): Promise<T> {
    const running = this.running.get(key) as Promise<T> | undefined
    if (running) return running
    const p = work().finally(() => this.running.delete(key))
    this.running.set(key, p)
    return p
  }

  /** gh refused an account's token (revoked, rotated): forget it, and the accounts' state. */
  // (`e`: a thrown gh error, or an answer that classified one; never our own refusal, which
  // gh never saw: forgetting then would only re-ask gh auth status on every request)
  private forget(login: string | undefined, wsl: { distro?: string } | undefined, e: unknown) {
    if (!login || (e as { refused?: boolean })?.refused) return
    const err =
      e && typeof e === "object" && "error" in e
        ? (e as { error: unknown }).error
        : ghError(e).error
    if (err !== "unauthenticated") return
    this.tokens.delete(`${envKey(wsl)}:${login}`)
    this.accountsCache.delete(envKey(wsl))
  }

  /** An account's token changed in gh (a scope added): the next run reads it again. */
  private dropToken(login: string | undefined, wsl?: { distro?: string }) {
    if (login) this.tokens.delete(`${envKey(wsl)}:${login}`)
  }

  /** One account's token, for its runs only (never leaves main). */
  private async token(login: string, wsl?: { distro?: string }): Promise<string> {
    const key = `${envKey(wsl)}:${login}`
    for (const [k, t] of this.tokens) if (this.now() - t.at >= TOKEN_TTL) this.tokens.delete(k)
    const hit = this.tokens.get(key)
    if (hit) return hit.token
    return this.once(`token:${key}`, async () => {
      const args = ["auth", "token", "--hostname", "github.com", "--user", login]
      const token = (await this.run("gh", args, wsl ? "~" : os.homedir(), wsl)).trim()
      if (!token || /\s/.test(token)) throw signedOut(login)
      this.tokens.set(key, { token, at: this.now() })
      return token
    })
  }

  // Strict: a request for an account runs as it or not at all, never as gh's active account
  // (a reviewer request would go out as someone else than the dialog says).
  /** The token a PR request runs with: its account's (none: gh's active, as it listed it). */
  // `fresh`: a write checks the accounts as they are now (an account logged out a moment ago
  // isn't written as, its cached token notwithstanding); a read may use the known list.
  private async tokenFor(req: { account?: string; wsl?: { distro?: string } }, fresh = false) {
    if (!req.account) return undefined
    const list =
      (!fresh && this.knownAccounts(req.wsl)) ||
      (await this.accounts(req.wsl, fresh ? WRITE_ACCOUNTS_MS : Infinity))
    const acc = list.find((a) => a.login === req.account)
    if (!acc || !acc.ok) throw signedOut(req.account)
    return this.token(req.account, req.wsl)
  }

  private async fetch(req: PrListsRequest, retried = false): Promise<PrListsResult> {
    // A folder that's gone (a removed worktree): gh runs from home, else its ENOENT would read
    // as "gh isn't installed". (WSL: wsl.exe starts either way; a gone folder fails git.)
    const there = !!req.cwd && (!!req.wsl || (await this.dirExists(req.cwd)))
    const cwd = there ? req.cwd! : req.wsl ? "~" : os.homedir()
    // gh's accounts: known (cached), or looked up now. Only a picked account waits for them:
    // otherwise gh's active account lists at once, and the others follow (accountsPending).
    const known = req.account ? undefined : this.knownAccounts(req.wsl)
    if (!known && !req.account) void this.accounts(req.wsl)
    const [repo, accounts] = await Promise.all([
      there ? this.repoOf(req.cwd!, req.wsl) : null,
      known ?? (req.account ? this.accounts(req.wsl) : Promise.resolve(null)),
    ])
    // The repo's tab for a checkout with no GitHub repo: nothing to ask gh.
    if (req.part === "repo" && !repo)
      return { ok: true, lists: { mine: [], review: [], ...(accounts ? { accounts } : {}) } }
    const want = {
      mine: !req.part || req.part === "mine",
      review: !req.part || req.part === "review",
      repo: (!req.part || req.part === "repo") && !!repo,
    }
    // No repo there (a WSL folder that's gone too): gh runs from home.
    const at = repo || !req.wsl ? cwd : "~"
    // gh can't say (an old gh, or gh failing): its active account, as it is, untagged. Not
    // for a picked account, though: those lists would act as someone else.
    if (!accounts?.length) {
      if (req.account)
        return {
          ok: false,
          error: "failed",
          message: "Couldn't ask gh which accounts are logged in.",
        }
      const res = await this.fetchAs(req, repo, at, undefined, want)
      if (!accounts) {
        if (res.ok) return { ok: true, lists: { ...res.lists, accountsPending: true } }
        // gh's active account failed (signed out, say): the others may not; asked properly
        if (!retried && (await this.accounts(req.wsl)).length) return this.fetch(req, true)
        return res
      }
      if (res.ok) res.lists.accounts = accounts
      return res.ok ? res : { ...res, accounts }
    }
    const owner = repo?.split("/")[0]?.toLowerCase() ?? ""
    // A picked account that's signed out: every account's lists (the picker shows why).
    const picked = accounts.find((a) => a.login === req.account && a.ok)
    const order = picked
      ? [picked]
      : repoOrder(
          accounts.filter((a) => a.ok),
          this.repoAccounts.get(owner),
        )
    if (!order.length) return { ok: false, error: "unauthenticated", accounts }
    const as = async (a: GhAccount, what: { mine: boolean; review: boolean; repo: boolean }) => {
      try {
        const res = await this.fetchAs(req, repo, at, await this.token(a.login, req.wsl), what)
        if (!res.ok) this.forget(a.login, req.wsl, res) // a refused token: read again next time
        return { a, res }
      } catch (e) {
        this.forget(a.login, req.wsl, e)
        return { a, res: { ok: false, ...ghError(e) } as PrListsResult }
      }
    }
    // The repo is asked of the first account only (the one that saw it last, or gh's active);
    // the others are asked only when it can't see it.
    // (the repo alone: only the first account asked here)
    const askOf = want.mine || want.review ? order : order.slice(0, 1)
    const answers = await Promise.all(
      askOf.map((a, i) => as(a, { ...want, repo: want.repo && i === 0 })),
    )
    const okOf = (x: (typeof answers)[number]) =>
      x.res.ok ? (x as { a: GhAccount; res: { ok: true; lists: PrLists } }) : null
    let seer =
      want.repo && answers[0] && okOf(answers[0])?.res.lists.repoVisible ? okOf(answers[0]) : null
    const repoNotes: typeof answers = []
    // (only the repo part; an account whose lists just failed isn't asked again)
    if (want.repo && !seer)
      for (const a of order.slice(1).filter((_, i) => answers[i + 1]?.res.ok ?? true)) {
        const x = await as(a, { mine: false, review: false, repo: true })
        if (okOf(x)?.res.lists.repoVisible) {
          seer = okOf(x)
          break
        }
        if (!x.res.ok) repoNotes.push(x)
      }
    const good = answers.map(okOf).filter((x) => !!x)
    if (!good.length && !seer) {
      const first = answers[0]!.res as Exclude<PrListsResult, { ok: true }>
      // every account failed: each one's reason
      const message = answers
        .map(
          (x) =>
            `@${x.a.login}: ${prErrorText(x.res as { error: PrListsError; message?: string })}`,
        )
        .join(" ")
      return { ok: false, error: first.error, message, accounts }
    }
    // Mine and review requested: every account's, each PR once (tagged with its account).
    const lists: PrLists = { mine: [], review: [], accounts }
    const seen = new Set<string>()
    const tag = (rows: PrRow[], account: string) =>
      rows.filter((r) => !seen.has(r.url) && seen.add(r.url)).map((r) => ({ ...r, account }))
    for (const t of ["mine", "review"] as const) {
      if (!want[t]) continue
      seen.clear()
      for (const { a, res } of good) lists[t].push(...tag(res.lists[t], a.login))
      lists[t].sort((x, y) => y.updatedAt.localeCompare(x.updatedAt)) // newest first, as each was
    }
    if (want.repo) {
      lists.repoName = repo!
      seen.clear()
      lists.repo = seer ? tag(seer.res.lists.repo ?? [], seer.a.login) : []
      // Unknown (not "nobody") when an account that might see it failed.
      const failed = answers.some((x) => !x.res.ok) || repoNotes.length > 0
      if (seer || !failed) lists.repoVisible = !!seer
      // Remembered (tried first next time) only when the ones before it said they can't see
      // the repo: one that just failed (a 504) doesn't hand the repo to another account.
      const first = answers[0] ? okOf(answers[0]) : null
      const plain =
        !!first &&
        (first === seer || first.res.lists.repoVisible === false) &&
        answers.every((x) => x.res.ok) // (an account that failed might have seen it)
      if (seer) lists.repoAccount = seer.a.login
      if (seer && plain && !repoNotes.length) boundedSet(this.repoAccounts, owner, seer.a.login)
    }
    const notes = [
      ...[...answers, ...repoNotes]
        .filter((x) => !x.res.ok)
        .map(
          (x) =>
            `@${x.a.login}: ${prErrorText(x.res as { error: PrListsError; message?: string })}`,
        ),
      ...good
        .filter((x) => x.res.lists.warning)
        .map((x) => `@${x.a.login}: ${x.res.lists.warning}`),
    ]
    if (notes.length) lists.warning = [...new Set(notes)].join(" ")
    const left = good.map((x) => x.res.lists.remaining).filter((n): n is number => n !== undefined)
    if (left.length) {
      const low = good.find((x) => x.res.lists.remaining === Math.min(...left))!
      lists.remaining = low.res.lists.remaining
      lists.resetAt = low.res.lists.resetAt
    }
    return { ok: true, lists }
  }

  /** The lists as one account (`token`; none: gh's active one). */
  private async fetchAs(
    req: PrListsRequest,
    repo: string | null,
    at: string,
    token: string | undefined,
    what: { mine: boolean; review: boolean; repo: boolean }, // which tabs' searches
  ): Promise<PrListsResult> {
    if (!what.repo) repo = null
    const s = prSearches(repo ?? undefined, req.closed, this.now())
    const [owner = "", name = ""] = repo?.split("/") ?? []
    const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `n=${PER_TAB}`]
    args.push("-f", `mine=${s.mine}`, "-f", `review=${s.review}`, "-f", `repo=${s.repo}`)
    args.push(
      "-F",
      `withMine=${what.mine}`,
      "-F",
      `withReview=${what.review}`,
      "-F",
      `withRepo=${repo ? "true" : "false"}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
    )
    try {
      // (GitHub's 502 / 503, a passing hiccup: asked once more after a pause, it's only a
      // read. Not a 504: GitHub already gave up on that search, it'd likely time out again.)
      const ask = () => this.gh.run(() => this.run("gh", args, at, req.wsl, token))
      const out = await ask().catch(async (e) => {
        const stderr = String((e as { stderr?: unknown }).stderr ?? "")
        const partial = (e as { stdout?: unknown }).stdout
        if (!/HTTP 50[23]/.test(stderr) || partial) throw e
        await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS))
        return ask()
      })
      const lists = parsePrLists(out, !!repo)
      if (!lists) return { ok: false, error: "failed", message: "Unexpected answer from gh" }
      if (repo) lists.repoName = repo
      return { ok: true, lists }
    } catch (e) {
      // A GraphQL error in one part (a repo this account can't see, a search it may not run)
      // fails the run, but gh still printed the rest: those tabs show, with the error as a note.
      const stdout = (e as { stdout?: unknown }).stdout
      const lists = typeof stdout === "string" && stdout ? parsePrLists(stdout, !!repo) : null
      const err = ghError(e)
      if (!lists) return { ok: false, ...err }
      if (repo) lists.repoName = repo
      // The repo not resolving (and its search) is said by repoVisible, not as a failure; any
      // other error gh printed is the note.
      const unseen = lists.repoVisible === false
      const note = String((e as { stderr?: unknown }).stderr ?? "")
        .split(/\r?\n/)
        .map((l) => l.replace(/^gh:\s*/, "").trim())
        .find(
          (l) => l && !(unseen && /Could not resolve to a Repository|cannot be searched/i.test(l)),
        )
      if (note) lists.warning = note.slice(0, 300)
      return { ok: true, lists }
    }
  }

  /** One PR's body, conversation and review threads (the same request in flight: shared). */
  detail(req: PrDetailRequest): Promise<PrDetailResult> {
    const key = JSON.stringify([
      "detail",
      req.repo,
      req.number,
      req.wsl ? (req.wsl.distro ?? "") : null,
      req.account ?? null,
    ])
    if (req.fresh) return this.detailLane.run(req)
    let p = this.detailsInFlight.get(key)
    if (!p) {
      p = this.detailLane.run(req).finally(() => this.detailsInFlight.delete(key))
      this.detailsInFlight.set(key, p)
    }
    return p
  }

  private async fetchDetail(req: PrDetailRequest): Promise<PrDetailResult> {
    const vars = prVars(req.repo, req.number)
    if (!vars) return { ok: false, error: "failed", message: "Not a pull request" }
    // gh needs no checkout here: the pane's folder only picks its environment.
    const cwd = await ghCwd(req, this.dirExists)
    try {
      const token = await this.tokenFor(req)
      const args = ["api", "graphql", "-f", `query=${DETAIL_QUERY}`, ...vars]
      const out = await this.run("gh", args, cwd, req.wsl, token)
      const detail = parsePrDetail(out)
      return detail
        ? { ok: true, detail }
        : { ok: false, error: "failed", message: "Unexpected answer from gh" }
    } catch (e) {
      this.forget(req.account, req.wsl, e)
      return { ok: false, ...ghError(e) }
    }
  }

  /** A PR's checks (latest commit) and commits: light, asked again while checks run. */
  checks(req: PrChecksRequest): Promise<PrChecksResult> {
    return this.checksLane.run(req)
  }

  private async fetchChecks(req: PrChecksRequest): Promise<PrChecksResult> {
    const vars = prVars(req.repo, req.number)
    if (!vars) return { ok: false, error: "failed", message: "Not a pull request" }
    // How far behind its base: only for the chips that need it, and never at the checks' cost
    // (a compare GitHub can't make fails the whole query: asked again without it, for a while).
    const key = behindKey(req)
    const failedAt = this.noBehind.get(key)
    const withBehind =
      req.behind === true && (failedAt === undefined || this.now() - failedAt >= NO_SCOPE_TTL)
    const ask = async (behind: boolean) => {
      const cwd = await ghCwd(req, this.dirExists)
      const more = ["-f", `pull=${pullHeadRef(req.number)}`, "-F", `withBehind=${behind}`]
      const args = ["api", "graphql", "-f", `query=${CHECKS_QUERY}`, ...vars, ...more]
      return parsePrChecks(await this.run("gh", args, cwd, req.wsl, await this.tokenFor(req)))
    }
    try {
      let checks: PrChecks | null
      try {
        checks = await ask(withBehind)
      } catch (e) {
        // Only GitHub refusing a field (HTTP 200, "GraphQL: …"): anything else (gh, the
        // network, a 5xx, the rate limit, a PR gone) fails the same without the compare.
        if (!withBehind || !fieldError(e)) throw e
        checks = await ask(false)
        boundedSet(this.noBehind, key, this.now())
      }
      return checks
        ? { ok: true, checks }
        : { ok: false, error: "failed", message: "Unexpected answer from gh" }
    } catch (e) {
      this.forget(req.account, req.wsl, e)
      return { ok: false, ...ghError(e) }
    }
  }

  /** Who can review a PR: suggestions (when the search is empty), people, and teams. */
  candidates(req: PrCandidatesRequest): Promise<PrCandidatesResult> {
    return this.candidatesLane.run(req)
  }

  private async fetchCandidates(req: PrCandidatesRequest): Promise<PrCandidatesResult> {
    const vars = prVars(req.repo, req.number)
    if (!vars) return { ok: false, error: "failed", message: "Not a pull request" }
    const cwd = await ghCwd(req, this.dirExists)
    // Per owner: only an org's teams need read:org (a user's repo has none to hide).
    const env = `${envKey(req.wsl)}:${req.account ?? ""}:${req.repo.split("/")[0]}`
    const missingAt = this.noTeamScope.get(env)
    let teams = missingAt === undefined || this.now() - missingAt >= NO_SCOPE_TTL
    const q = req.query.trim().slice(0, QUERY_MAX)
    const ask = async (): Promise<PrCandidatesResult> => {
      const args = ["api", "graphql", "-f", `query=${CANDIDATES_QUERY}`, ...vars, "-f", `q=${q}`]
      args.push("-F", `suggest=${q ? "false" : "true"}`, "-F", `teams=${teams}`)
      const out = await this.run("gh", args, cwd, req.wsl, await this.tokenFor(req))
      const candidates = parseCandidates(out, teams)
      return candidates
        ? { ok: true, candidates }
        : { ok: false, error: "failed", message: "Unexpected answer from gh" }
    }
    try {
      return await ask()
    } catch (e) {
      // Teams need read:org: without it, people only, and a hint (`gh auth refresh`).
      if (!teams || !READ_ORG.test(String((e as { stderr?: unknown }).stderr ?? ""))) {
        this.forget(req.account, req.wsl, e)
        return { ok: false, ...ghError(e) }
      }
      // (remembered only when people alone then answer: another scope's error isn't this)
      const remember = () => {
        this.noTeamScope.set(env, this.now())
        if (this.noTeamScope.size > 64)
          this.noTeamScope.delete(this.noTeamScope.keys().next().value!)
      }
      teams = false
      // gh still printed the rest of the answer: no second run when it's there.
      const stdout = (e as { stdout?: unknown }).stdout
      const partial = typeof stdout === "string" && stdout ? parseCandidates(stdout, false) : null
      if (partial) {
        remember()
        return { ok: true, candidates: partial }
      }
      try {
        const res = await ask()
        if (res.ok) remember()
        return res
      } catch (e2) {
        return { ok: false, ...ghError(e2) }
      }
    }
  }

  /** Requests (or un-requests) reviews, then fetches the PR's row again. Never skipped. */
  async reviewers(req: PrReviewersRequest): Promise<PrReviewersResult> {
    const args = reviewerEditArgs(req)
    const vars = prVars(req.repo, req.number)
    if (!args || !vars) return { ok: false, error: "failed", message: "Not a reviewer" }
    try {
      const cwd = await ghCwd(req, this.dirExists)
      await this.run("gh", args, cwd, req.wsl, await this.tokenFor(req, true))
    } catch (e) {
      // On an org's repo gh may look up its teams for any reviewer: that needs read:org.
      if (READ_ORG.test(String((e as { stderr?: unknown }).stderr ?? ""))) {
        this.dropToken(req.account, req.wsl) // after `gh auth refresh -s read:org`: the new one
        return { ok: false, error: "failed", message: READ_ORG_HINT }
      }
      this.forget(req.account, req.wsl, e)
      return { ok: false, ...ghError(e) }
    }
    return { ok: true, row: await this.row(req) }
  }

  /** Comments on a PR, or reviews it, as its account; then fetches its row again. */
  write(req: PrWriteRequest): Promise<PrWriteResult> {
    // The same write already running (a second window, a reload mid-send): its answer, once.
    const key = writeKey(req)
    let p = this.writesInFlight.get(key)
    if (!p) {
      p = this.doWrite(req, key).finally(() => this.writesInFlight.delete(key))
      this.writesInFlight.set(key, p)
    }
    return p
  }

  // Never posted twice, yet a repeat on purpose (a "/retest", a verdict changed back) goes
  // out: only a write whose last try ended unclear is checked against GitHub before sending.
  private async doWrite(req: PrWriteRequest, key: string): Promise<PrWriteResult> {
    if (req.body.length > BODY_MAX)
      return {
        ok: false,
        error: "failed",
        message: `Too long for GitHub (over ${BODY_MAX} characters)`,
      }
    const args = writeArgs(req)
    const vars = prVars(req.repo, req.number)
    if (!args || !vars) return { ok: false, error: "failed", message: "Nothing to send" }
    let cwd: string
    let token: string | undefined
    try {
      cwd = await ghCwd(req, this.dirExists)
      token = await this.tokenFor(req, true)
    } catch (e) {
      // (nothing sent yet: a plain failure, a slow `gh auth` included)
      this.forget(req.account, req.wsl, e)
      return { ok: false, ...ghError(e) }
    }
    // Is this write on GitHub, made by this account since `since`? (null: can't say)
    const there = (since: number) =>
      this.run(
        "gh",
        ["api", "graphql", "-f", `query=${RECENT_QUERY}`, ...vars],
        cwd,
        req.wsl,
        token,
      )
        .then((out) => alreadyPosted(out, req, since))
        .catch(() => null)
    for (const [k, at] of this.unclear) if (this.now() - at >= SAME_WRITE_MS) this.unclear.delete(k)
    const prior = this.unclear.get(key)
    if (prior !== undefined) {
      // A retry of a try that ended unclear: did that one land?
      const landed = await there(prior - CLOCK_SKEW_MS)
      if (landed === true) {
        this.unclear.delete(key)
        return { ok: true, row: await this.row(req), already: true }
      }
      if (landed === null) return { ok: false, error: "failed", message: NOT_CHECKED } // not blind
    }
    const started = this.now()
    try {
      // (only the end trimmed: a first line's indent is Markdown, an indented code block)
      await this.run("gh", args, cwd, req.wsl, token, req.body.trimEnd())
    } catch (e) {
      const err = ghError(e)
      // gh missing or the token refused: nothing reached GitHub
      if (err.error === "missing" || err.error === "unauthenticated") {
        this.forget(req.account, req.wsl, e)
        return { ok: false, ...err }
      }
      // A clear refusal (GitHub said no): this try posted nothing, safe to try again. (An
      // earlier unclear try stays remembered: it may still land.)
      if (!unclearFailure(e)) return { ok: false, ...err }
      // Killed waiting, a timeout, a 5xx, a dropped connection: it may have landed (or land
      // a moment later). Seen there: it went through. Otherwise remembered as unclear, so a
      // retry asks GitHub first, and said so, never "try again".
      if ((await there(started - CLOCK_SKEW_MS)) === true) {
        this.unclear.delete(key)
        return { ok: true, row: await this.row(req) }
      }
      boundedSet(this.unclear, key, started)
      return { ok: false, error: "failed", message: MAYBE_SENT }
    }
    this.unclear.delete(key)
    return { ok: true, row: await this.row(req) }
  }

  // A link names a PR, not an account: each of gh's accounts is asked in turn (the one that
  // saw the owner's repos last first), and the first that sees it lists it (acts as it).
  /** A PR by its link, as the first of gh's accounts that can see it. */
  find(req: PrFindRequest): Promise<PrFindResult> {
    // (the same link clicked again while it's looked up: one sweep)
    const key = JSON.stringify([req.repo.toLowerCase(), req.number, envKey(req.wsl), req.cwd ?? ""])
    return this.once(`find:${key}`, () => this.doFind(req))
  }

  private async doFind(req: PrFindRequest): Promise<PrFindResult> {
    const vars = prVars(req.repo, req.number)
    if (!vars) return { ok: false, error: "failed", message: "Not a pull request" }
    const cwd = await ghCwd(req, this.dirExists)
    const accounts = this.knownAccounts(req.wsl) ?? (await this.accounts(req.wsl))
    const ok = accounts.filter((a) => a.ok)
    if (accounts.length && !ok.length) return { ok: false, error: "unauthenticated" }
    const owner = req.repo.split("/")[0]!.toLowerCase()
    // (gh can't say which accounts: its active one, untagged)
    const order = ok.length
      ? repoOrder(ok, this.repoAccounts.get(owner)).map((a) => a.login)
      : [undefined]
    const args = ["api", "graphql", "-f", `query=${ROW_QUERY}`, ...vars]
    type Ask = { row: PrRow } | { unseen: true } | { failure: Exclude<PrFindResult, { ok: true }> }
    const ask = async (login: string | undefined): Promise<Ask> => {
      try {
        const token = login ? await this.token(login, req.wsl) : undefined
        const out = await this.gh.run(() => this.run("gh", args, cwd, req.wsl, token))
        const row = parsePrRowAnswer(out)
        // (an answer that doesn't parse isn't "can't see")
        if (!row)
          return { failure: { ok: false, error: "failed", message: "Unexpected answer from gh" } }
        return { row: login ? { ...row, account: login } : row }
      } catch (e) {
        if (NOT_FOUND.test(String((e as { stderr?: unknown }).stderr ?? "")))
          return { unseen: true }
        this.forget(login, req.wsl, e)
        const err = ghError(e)
        return {
          failure: login
            ? { ok: false, ...err, message: `@${login}: ${prErrorText(err)}` }
            : { ok: false, ...err },
        }
      }
    }
    // The likeliest first (it saw the owner's repos last); the rest at once only if it can't.
    const first = await ask(order[0])
    // (gh missing, or offline: every account would fail the same way)
    const stop = "failure" in first && ["missing", "offline"].includes(first.failure.error)
    const answers =
      "row" in first || stop ? [first] : [first, ...(await Promise.all(order.slice(1).map(ask)))]
    for (const [i, x] of answers.entries())
      if ("row" in x) {
        // Remembered (asked first next time) only when the one before said it can't see it:
        // one that just failed doesn't hand the owner to another account.
        if (order[i] && (i === 0 || "unseen" in first))
          boundedSet(this.repoAccounts, owner, order[i]!)
        return { ok: true, row: x.row }
      }
    // (one that failed might have seen it: said, never "nobody can")
    const failed = answers.find((x) => "failure" in x)
    if (failed && "failure" in failed) return failed.failure
    return {
      ok: false,
      error: "failed",
      notFound: true,
      tried: order.filter((l): l is string => !!l),
    }
  }

  /** Merges a PR as its account; then fetches its row again. The same merge asked while it
   *  runs (a reload, a second window) joins it; another (way, account) runs, and is told. */
  merge(req: PrMergeRequest): Promise<PrMergeResult> {
    const key = JSON.stringify([req.repo.toLowerCase(), req.number, req.method, req.account ?? ""])
    return this.onePerPr(req, `merge:${key}`, () => this.doMerge(req))
  }

  // A merge and any other write on its state (a branch update, draft, close…) on one PR never go
  // out together: the same one asked again joins it (a reload, a second window); another is
  // refused while it runs.
  /** Runs a write on a PR unless another write on it runs. */
  private onePerPr<T>(
    req: { repo: string; number: number },
    key: string,
    work: () => Promise<T>,
  ): Promise<T | PrBranchResult> {
    const pr = `${req.repo.toLowerCase()}#${req.number}`
    const other = this.prWrites.get(pr)
    if (other && other !== key && this.running.has(other))
      return Promise.resolve({ ok: false, error: "failed", message: ANOTHER_WRITE })
    boundedSet(this.prWrites, pr, key)
    return this.once(key, work)
  }

  private async doMerge(req: PrMergeRequest): Promise<PrMergeResult> {
    const args = mergeArgs(req)
    if (!args) return { ok: false, error: "failed", message: "Not a merge" }
    // From home, never the pane's checkout: with --repo, gh touches no local branch.
    const home = req.wsl ? "~" : os.homedir()
    let token: string | undefined
    try {
      token = await this.tokenFor(req, true)
    } catch (e) {
      // (nothing sent yet: a plain failure, a slow gh auth included)
      this.forget(req.account, req.wsl, e)
      return { ok: false, ...ghError(e) }
    }
    try {
      // (empty stdin: a write's long timeout; killed after GitHub took it would read as failed)
      await this.run("gh", args, home, req.wsl, token, "")
    } catch (e) {
      const err = ghError(e)
      if (err.error === "missing" || err.error === "unauthenticated") {
        this.forget(req.account, req.wsl, e)
        return { ok: false, ...err }
      }
      // Merged already (an earlier unclear try, or someone else, maybe another way): said so.
      if (/already merged/i.test(String((e as { stderr?: unknown }).stderr ?? ""))) {
        const row = await this.row(req)
        if (row?.state === "merged") return { ok: true, row, already: true }
      }
      // Ended unclear (killed, a 5xx): the PR itself says whether it merged.
      if (unclearFailure(e)) {
        const row = await this.row(req)
        if (row?.state === "merged") return { ok: true, row }
        return { ok: false, error: "failed", message: MERGE_UNCLEAR }
      }
      return { ok: false, ...err }
    }
    return { ok: true, row: await this.row(req) }
  }

  /** Updates a PR's branch, draft state, or open / closed, as its account; then its row. */
  // The same action asked while it runs joins it.
  branch(req: PrBranchRequest): Promise<PrBranchResult> {
    const key = JSON.stringify([req.repo.toLowerCase(), req.number, req.action, req.account ?? ""])
    return this.onePerPr(req, `branch:${key}`, () => this.doBranch(req)) as Promise<PrBranchResult>
  }

  private async doBranch(req: PrBranchRequest): Promise<PrBranchResult> {
    const args = branchArgs(req)
    if (!args) return { ok: false, error: "failed", message: "Not a pull request action" }
    // From home, never the pane's checkout: with --repo, gh touches no local branch.
    const home = req.wsl ? "~" : os.homedir()
    let token: string | undefined
    try {
      token = await this.tokenFor(req, true)
    } catch (e) {
      this.forget(req.account, req.wsl, e)
      return { ok: false, ...ghError(e) }
    }
    let unclear = false
    try {
      // (empty stdin: a write's long timeout)
      await this.run("gh", args, home, req.wsl, token, "")
    } catch (e) {
      const err = ghError(e)
      if (err.error === "missing" || err.error === "unauthenticated") {
        this.forget(req.account, req.wsl, e)
        return { ok: false, ...err }
      }
      // Ended unclear (killed, a 5xx): each action is safe to ask again; the PR says if it took.
      if (!unclearFailure(e)) return { ok: false, ...err }
      unclear = true
    }
    if (req.action !== "update") {
      const row = await this.row(req)
      if (!unclear || (row && branchDone(req.action, row, null))) return { ok: true, row }
      return { ok: false, error: "failed", message: BRANCH_UNCLEAR }
    }
    // An update: done once GitHub counts none behind (it merges the base in on its own time).
    let behind = await this.behind(req)
    for (const ms of UPDATE_LOOKS_MS) {
      if (behind === 0 || behind === null) break // (no count: the row's merge state says)
      await this.sleep(ms)
      behind = await this.behind(req)
    }
    const row = await this.row(req)
    // GitHub's count says; none (it can't count): the row's merge state, but never for a run
    // that ended unclear (in a repo with no "up to date" rule it never says behind).
    const done = behind === 0 || (!unclear && !!row && branchDone("update", row, behind))
    if (done) return { ok: true, row, behind: behind ?? undefined }
    if (unclear) return { ok: false, error: "failed", message: BRANCH_UNCLEAR }
    return { ok: true, row, pending: true, behind: behind ?? undefined }
  }

  /** How many commits a PR is behind its base (null: GitHub didn't say). */
  private async behind(req: PrBranchRequest): Promise<number | null> {
    const vars = prVars(req.repo, req.number)
    const failedAt = this.noBehind.get(behindKey(req))
    if (!vars || (failedAt !== undefined && this.now() - failedAt < NO_SCOPE_TTL)) return null
    try {
      const cwd = await ghCwd(req, this.dirExists)
      const pull = ["-f", `pull=${pullHeadRef(req.number)}`]
      const args = ["api", "graphql", "-f", `query=${BEHIND_QUERY}`, ...vars, ...pull]
      return parseBehind(await this.run("gh", args, cwd, req.wsl, await this.tokenFor(req)))
    } catch {
      return null
    }
  }

  /** One PR's row, asked for directly (search answers lag behind edits). null: no answer. */
  async row(req: PrDetailRequest): Promise<PrRow | null> {
    const vars = prVars(req.repo, req.number)
    if (!vars) return null
    try {
      const cwd = await ghCwd(req, this.dirExists)
      const args = ["api", "graphql", "-f", `query=${ROW_QUERY}`, ...vars]
      const token = await this.tokenFor(req)
      const row = parsePrRowAnswer(await this.run("gh", args, cwd, req.wsl, token))
      // (as the account that listed it: its next requests go out as that one too)
      return row && req.account ? { ...row, account: req.account } : row
    } catch (e) {
      this.forget(req.account, req.wsl, e)
      return null
    }
  }
}
