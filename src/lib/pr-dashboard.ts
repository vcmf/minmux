// The pull requests dialog (docs/design/PR_DASHBOARD.md): the GraphQL query, its answer parsed
// into rows with their status, and pure helpers for the dialog. Shared with main (the query
// and parser run there); parsing never throws — gh's JSON is an outside format.

import { LABELS, type PrLabel } from "./pr-labels"

export type PrTab = "mine" | "review" | "repo"
export const PR_TABS: PrTab[] = ["mine", "review", "repo"]

export type PrRowState = "open" | "draft" | "merged" | "closed"
export type PrReview = "approved" | "changes" | "required" | null
export type PrMerge = "clean" | "behind" | "conflicts" | "blocked" | "unstable" | "unknown"
export type PrCi = "success" | "failure" | "pending" | null

/** One PR in a list, with what its status line shows. */
export interface PrRow {
  number: number
  title: string
  url: string
  repo: string // owner/name
  defaultBranch?: string // the repo's (the graph's root); none in an answer from an older build
  author: string
  state: PrRowState
  head: string
  fork: boolean // from another repo: a local branch of the same name isn't its code
  base: string
  review: PrReview
  reviewers: { login: string; state: "approved" | "changes" | "commented" | "dismissed" }[]
  requested: string[] // logins, or org/team slugs
  labels?: PrLabel[] // (none in an answer kept from an older build)
  moreLabels?: number // beyond the ones asked for
  merge: PrMerge
  ci: PrCi
  comments: number // conversation + review threads
  additions: number
  deletions: number
  updatedAt: string
  account?: string // the gh account that listed it (several logged in): it acts as that one
}

/** A GitHub login (never an option, never a path). */
export const isGhLogin = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9][\w-]*$/.test(v)

/** A GitHub account logged in to gh (github.com). */
export interface GhAccount {
  login: string
  active: boolean // gh's active account (what gh in a terminal runs as)
  ok: boolean // its token works (or gh couldn't check: offline isn't signed out)
  offline?: boolean // gh couldn't reach GitHub to check it
}

/** A refresh's answer: each tab's rows (no repo tab when there's no repo). */
export interface PrLists {
  mine: PrRow[]
  review: PrRow[]
  repo?: PrRow[]
  repoName?: string // owner/name the repo tab lists
  warning?: string // a search that failed while the others answered
  remaining?: number // GraphQL points left this hour
  resetAt?: string
  repoVisible?: boolean // false: the account can't see the repo (the repo tab is empty)
  accounts?: GhAccount[] // gh's accounts (none: gh can't say, or an old gh)
  accountsPending?: boolean // listed as gh's active account while gh's accounts are looked up
  answered?: Partial<Record<PrTab, boolean>> // the tabs that answered (each asked on its own)
  pending?: Partial<Record<PrTab, boolean>> // the tabs listed before gh's accounts were known
  warnings?: Partial<Record<PrTab, string>> // each tab's note (`warning`: them together)
  repoAccount?: string // the account the repo tab is listed as (several accounts)
}

export type PrListsError = "missing" | "unauthenticated" | "offline" | "failed"

/** What the dialog says for each gh failure (the lists' and a PR's detail alike). */
export const PR_ERRORS: Record<PrListsError, string> = {
  missing:
    "GitHub CLI (gh) isn't installed. Install it from cli.github.com, then run gh auth login.",
  unauthenticated: "gh isn't logged in. Run `gh auth login` in a terminal.",
  offline: "Can't reach GitHub.",
  failed: "gh couldn't load this from GitHub.",
}

/** A gh failure as the dialog says it: the friendly words, then gh's own. */
export const prErrorText = (e: { error: PrListsError; message?: string }) =>
  `${PR_ERRORS[e.error]}${e.message ? ` ${e.message}` : ""}`

/** What main answers `prs:lists` with. */
export type PrListsResult =
  | { ok: true; lists: PrLists }
  | { ok: false; error: PrListsError; message?: string; accounts?: GhAccount[] } // (the picker stays)

/** A `prs:lists` request: the focused pane's checkout (for the repo tab and gh's environment). */
export interface PrListsRequest {
  cwd?: string
  wsl?: { distro?: string }
  closed: boolean // include PRs closed or merged in the last CLOSED_DAYS
  account?: string // one gh account's lists (none: every account's)
  part?: PrTab // one tab's list only (none: all three): each tab shows as soon as it answers
}

export const PER_TAB = 30
export const CLOSED_DAYS = 14

export const PR_FRAGMENT = `fragment pr on PullRequest {
  number title url state isDraft updatedAt
  author { login }
  repository { nameWithOwner defaultBranchRef { name } }
  headRefName baseRefName isCrossRepository
  reviewDecision mergeStateStatus
  additions deletions
  comments { totalCount }
  reviewThreads { totalCount }
  latestOpinionatedReviews(first: 10) { nodes { author { login } state } }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { combinedSlug } } } }
  labels(first: ${LABELS}) { totalCount nodes { name color description } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
}`

export const PR_QUERY = `query($mine: String!, $review: String!, $repo: String!, $n: Int!, $withMine: Boolean!, $withReview: Boolean!, $withRepo: Boolean!, $owner: String!, $name: String!) {
  mine: search(type: ISSUE, query: $mine, first: $n) @include(if: $withMine) { nodes { ...pr } }
  review: search(type: ISSUE, query: $review, first: $n) @include(if: $withReview) { nodes { ...pr } }
  repo: search(type: ISSUE, query: $repo, first: $n) @include(if: $withRepo) { nodes { ...pr } }
  visible: repository(owner: $owner, name: $name) @include(if: $withRepo) { id }
  rateLimit { remaining resetAt }
}
${PR_FRAGMENT}`

/** One PR's row, asked for directly (after an edit: search answers can lag behind). */
export const PR_ROW_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ...pr } }
}
${PR_FRAGMENT}`

/** Each tab's search: open PRs, or (`closed`) any updated in the last CLOSED_DAYS. */
export function prSearches(
  repo: string | undefined,
  closed: boolean,
  now = Date.now(),
): Record<PrTab, string> {
  const since = new Date(now - CLOSED_DAYS * 86_400_000).toISOString().slice(0, 10)
  const scope = closed ? `updated:>=${since}` : "is:open"
  const q = (who: string) => `is:pr ${scope} ${who} sort:updated-desc`
  return {
    mine: q("author:@me"),
    review: q("review-requested:@me"),
    repo: repo ? q(`repo:${repo}`) : "",
  }
}

// Reading gh's JSON without trusting its shape (shared with pr-detail).
type Obj = Record<string, unknown>
export const obj = (v: unknown): Obj | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined
export const str = (v: unknown): string => (typeof v === "string" ? v : "")
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0)
export const nodes = (v: unknown): unknown[] => {
  const n = obj(v)?.nodes
  return Array.isArray(n) ? n : []
}

const REVIEW: Record<string, PrReview> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  REVIEW_REQUIRED: "required",
}
const MERGE: Record<string, PrMerge> = {
  CLEAN: "clean",
  HAS_HOOKS: "clean",
  BEHIND: "behind",
  DIRTY: "conflicts",
  BLOCKED: "blocked",
  UNSTABLE: "unstable",
}
const CI: Record<string, PrCi> = {
  SUCCESS: "success",
  FAILURE: "failure",
  ERROR: "failure",
  PENDING: "pending",
  EXPECTED: "pending",
}
const REVIEWER: Record<string, PrRow["reviewers"][number]["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
}

/** The repo's default branch, when GitHub named one (an empty repo has none). */
const defaultBranchOf = (repo: unknown): { defaultBranch?: string } => {
  const name = str(obj(obj(repo)?.defaultBranchRef)?.name)
  return name ? { defaultBranch: name } : {}
}

/** One search node → a row (null: not a PR, or missing what a row needs). */
export function parsePrRow(v: unknown): PrRow | null {
  const o = obj(v)
  if (!o || typeof o.number !== "number" || !str(o.url)) return null
  const s = str(o.state)
  const state: PrRowState =
    s === "MERGED" ? "merged" : s === "CLOSED" ? "closed" : o.isDraft === true ? "draft" : "open"
  const reviewers: PrRow["reviewers"] = []
  for (const r of nodes(o.latestOpinionatedReviews)) {
    const login = str(obj(obj(r)?.author)?.login)
    const st = REVIEWER[str(obj(r)?.state)]
    if (login && st) reviewers.push({ login, state: st })
  }
  const requested: string[] = []
  for (const r of nodes(o.reviewRequests)) {
    const who = obj(obj(r)?.requestedReviewer)
    const name = str(who?.login) || str(who?.combinedSlug)
    if (name) requested.push(name)
  }
  const commit = obj(obj(nodes(o.commits)[0])?.commit)
  return {
    number: o.number,
    title: str(o.title),
    url: str(o.url),
    repo: str(obj(o.repository)?.nameWithOwner),
    ...defaultBranchOf(o.repository),
    author: str(obj(o.author)?.login),
    state,
    head: str(o.headRefName),
    fork: o.isCrossRepository === true,
    base: str(o.baseRefName),
    review: REVIEW[str(o.reviewDecision)] ?? null,
    reviewers,
    requested,
    ...labelsOf(o.labels),
    // GitHub computes it lazily: UNKNOWN (or none) until then — never shown as a problem.
    merge: MERGE[str(o.mergeStateStatus)] ?? "unknown",
    ci: CI[str(obj(commit?.statusCheckRollup)?.state)] ?? null,
    comments: num(obj(o.comments)?.totalCount) + num(obj(o.reviewThreads)?.totalCount),
    additions: num(o.additions),
    deletions: num(o.deletions),
    updatedAt: str(o.updatedAt),
  }
}

/** The query's `labels` connection → the labels, and how many there are in all. */
export function parseLabels(v: unknown): { labels: PrLabel[]; total: number } {
  const labels = nodes(v).flatMap((n) => {
    const o = obj(n)
    const name = str(o?.name)
    if (!name) return []
    const color = str(o?.color).toLowerCase()
    return [
      { name, color: /^[0-9a-f]{6}$/.test(color) ? color : "", description: str(o?.description) },
    ]
  })
  const t = obj(v)?.totalCount
  return { labels, total: typeof t === "number" && t >= labels.length ? t : labels.length }
}

/** A row's labels (left out when it has none: rows stay as small as they were). */
function labelsOf(v: unknown): { labels?: PrLabel[]; moreLabels?: number } {
  const { labels, total } = parseLabels(v)
  if (!labels.length) return {}
  return total > labels.length ? { labels, moreLabels: total - labels.length } : { labels }
}

/** `gh api graphql` output → the lists (null: not an answer). */
export function parsePrLists(out: string, withRepo: boolean): PrLists | null {
  let root: unknown
  try {
    root = JSON.parse(out)
  } catch {
    return null
  }
  const data = obj(obj(root)?.data)
  if (!data) return null
  const rows = (k: string) =>
    nodes(data[k])
      .map(parsePrRow)
      .filter((r): r is PrRow => !!r)
  const lists: PrLists = { mine: rows("mine"), review: rows("review") }
  if (withRepo) {
    lists.repo = rows("repo")
    // (a search of a repo it can't see finds nothing, silently: the repository says)
    lists.repoVisible = !!obj(data.visible)
  }
  const rate = obj(data.rateLimit)
  if (rate && typeof rate.remaining === "number") lists.remaining = rate.remaining
  if (rate && str(rate.resetAt)) lists.resetAt = str(rate.resetAt)
  return lists
}

/** A GitHub remote URL → owner/name (null: not github.com). */
export function githubRepoOf(remote: string): string | null {
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    )
  return m ? `${m[1]}/${m[2]}` : null
}

/** The row's status line, in reading order (empty parts left out). */
export function statusParts(r: PrRow): string[] {
  const out: string[] = []
  if (r.state === "merged" || r.state === "closed") out.push(r.state)
  else {
    if (r.state === "draft") out.push("draft")
    if (r.review === "approved") out.push("approved")
    else if (r.review === "changes") out.push("changes requested")
    else if (r.requested.length) out.push(`review requested`)
    else if (r.review === "required") out.push("review required")
    if (r.merge === "behind") out.push("behind base")
    else if (r.merge === "conflicts") out.push("conflicts")
  }
  if (r.ci === "failure") out.push("CI failing")
  else if (r.ci === "pending") out.push("CI running")
  else if (r.ci === "success" && r.state !== "merged" && r.state !== "closed") out.push("CI passed")
  if (r.comments) out.push(`${r.comments} comment${r.comments === 1 ? "" : "s"}`)
  return out
}

/** A status part's colour: good, warn or bad (none: plain). */
export function chipTone(part: string): string {
  if (part === "approved" || part === "CI passed") return "good"
  if (/changes requested|conflicts|failing|closed/.test(part)) return "bad"
  if (/behind|running|review/.test(part)) return "warn"
  return ""
}

// Backs off on errors (60 s → 5 min); waits for the reset when the budget runs low.
/** Milliseconds until the next automatic refresh. */
export function nextRefreshMs(lists: PrLists | null, failures: number, now = Date.now()): number {
  const EVERY = 60_000
  if (failures > 0) return Math.min(EVERY * 2 ** (failures - 1), 5 * 60_000)
  if (lists?.remaining !== undefined && lists.remaining < 500 && lists.resetAt) {
    const reset = Date.parse(lists.resetAt)
    if (Number.isFinite(reset) && reset > now) return Math.max(EVERY, reset - now)
  }
  return EVERY
}

/** A key's tab move (1/2/3 or ←/→), within the tabs shown. */
export function tabFor(key: string, cur: PrTab, tabs: PrTab[]): PrTab | null {
  if (key >= "1" && key <= "3") return tabs[Number(key) - 1] ?? null
  const i = tabs.indexOf(cur)
  if (key === "ArrowRight") return tabs[(i + 1) % tabs.length]!
  if (key === "ArrowLeft") return tabs[(i - 1 + tabs.length) % tabs.length]!
  return null
}

/** `gh api graphql` output of PR_ROW_QUERY → the row (null: not an answer). */
export function parsePrRowAnswer(out: string): PrRow | null {
  try {
    return parsePrRow(obj(obj(obj(JSON.parse(out))?.data)?.repository)?.pullRequest)
  } catch {
    return null
  }
}

/** The lists shown, with one tab's answer (or failure) in: tabs answer one by one. */
export function mergePart(prev: PrLists | null, part: PrTab, res: PrListsResult): PrLists | null {
  if (!res.ok) {
    // a tab that failed while others answer: answered, with its own note (never "Loading…")
    const base = prev ?? { mine: [], review: [] }
    const warnings = { ...base.warnings, [part]: prErrorText(res) }
    return {
      ...base,
      answered: { ...base.answered, [part]: true },
      warnings,
      warning: joinWarnings(warnings),
    }
  }
  const got = res.lists
  const out: PrLists = { ...(prev ?? { mine: [], review: [] }) }
  if (part === "repo") {
    // the repo's fields are the repo answer's alone (none: this checkout has no GitHub repo)
    for (const k of ["repo", "repoName", "repoVisible", "repoAccount"] as const) delete out[k]
    Object.assign(out, {
      ...(got.repo ? { repo: got.repo } : {}),
      ...(got.repoName ? { repoName: got.repoName } : {}),
      ...(got.repoVisible !== undefined ? { repoVisible: got.repoVisible } : {}),
      ...(got.repoAccount ? { repoAccount: got.repoAccount } : {}),
    })
  } else out[part] = got[part]
  out.answered = { ...prev?.answered, [part]: true }
  if (got.accounts) out.accounts = got.accounts
  // pending per tab: one tab answered with every account doesn't make another's untagged rows so
  const pending = { ...prev?.pending, [part]: !!got.accountsPending }
  out.pending = pending
  if (Object.values(pending).some(Boolean)) out.accountsPending = true
  else delete out.accountsPending
  // The budget left: a new hour's reading replaces the last one; within the hour, the lowest.
  if (got.remaining !== undefined) {
    const sameHour = !!got.resetAt && got.resetAt === out.resetAt
    if (!sameHour || out.remaining === undefined || got.remaining < out.remaining) {
      out.remaining = got.remaining
      out.resetAt = got.resetAt
    }
  }
  const warnings = { ...prev?.warnings }
  if (got.warning) warnings[part] = got.warning
  else delete warnings[part]
  out.warnings = warnings
  const w = joinWarnings(warnings)
  if (w) out.warning = w
  else delete out.warning
  return out
}

const joinWarnings = (w: Partial<Record<PrTab, string>>) =>
  [...new Set(Object.values(w).filter(Boolean))].join(" ") || undefined

const done = (r: PrRow) => r.state === "closed" || r.state === "merged"

// GitHub's search lags behind a close or merge (made here, or anywhere), and a PR's own row
// shown over its list copy says it's done: in lists of open ones, neither stays.
/** The lists with their closed and merged PRs left out (the same lists when there are none). */
export function openOnly<T extends Pick<PrLists, "mine" | "review" | "repo">>(lists: T): T {
  const tabs = [lists.mine, lists.review, lists.repo ?? []]
  if (!tabs.some((rows) => rows.some(done))) return lists
  const keep = (rows: PrRow[]) => rows.filter((r) => !done(r))
  return {
    ...lists,
    mine: keep(lists.mine),
    review: keep(lists.review),
    ...(lists.repo ? { repo: keep(lists.repo) } : {}),
  }
}
