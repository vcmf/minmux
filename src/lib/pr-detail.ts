// The pull requests dialog's detail (docs/design/PR_DASHBOARD.md, step 2): one PR's body,
// conversation and review threads, parsed from one GraphQL query, plus pure helpers to show
// them. Shared with main; parsing never throws (gh's JSON is an outside format).
import { nodes, obj, str, type PrListsError } from "./pr-dashboard"

/** One comment or review in the conversation, oldest first. */
export interface PrEntry {
  kind: "comment" | "review"
  author: string
  body: string
  at: string
  url: string
  state?: "approved" | "changes" | "commented" | "dismissed" // a review's
}

/** A comment in a review thread. */
export interface PrThreadComment {
  author: string
  body: string
  at: string
  url: string
}

/** A review thread on one line of one file. */
export interface PrThread {
  path: string
  line: number | null // in the PR's current diff (null: outdated, or the whole file)
  removed: boolean // on a deleted line: `line` is the base file's, not the branch's
  resolved: boolean
  outdated: boolean
  hunk: string // the diff lines the thread is on (the first comment's)
  comments: PrThreadComment[]
}

/** A PR or issue by repo and number. */
export type PrRef = { repo: string; number: number }

/** One key per PR or issue (repo names are case-insensitive). */
export const refKey = (r: PrRef) => `${r.repo.toLowerCase()}#${r.number}`

/** A PR or issue linked to this one. */
export interface PrLink {
  url: string
  number: number
  repo: string // owner/name
  title: string // "" when only the body names it
  kind: "pr" | "issue" | null // null: named in the body (#N could be either)
  state: "open" | "draft" | "merged" | "closed" | null
}

/** How the PR links to others: issues it closes, what its body names, what names it. */
export interface PrLinks {
  closes: PrLink[]
  mentions: PrLink[]
  mentionedBy: PrLink[]
}

/** One PR's detail. `more`: GitHub had more than the query asks for (open it there). */
export interface PrDetail {
  url: string
  updatedAt: string
  body: string
  conversation: PrEntry[]
  threads: PrThread[]
  links: PrLinks
  more: boolean
}

/** A `prs:detail` request: which PR, and where gh runs (the focused pane's environment). */
export interface PrDetailRequest {
  repo: string // owner/name
  number: number
  cwd?: string
  wsl?: { distro?: string }
  account?: string // the gh account to run as (the one that listed the PR)
  fresh?: boolean // after a write: its own run, never one already in flight (that predates it)
}

export type PrDetailResult =
  { ok: true; detail: PrDetail } | { ok: false; error: PrListsError; message?: string }

export const THREADS = 100
export const PER_THREAD = 50
export const ENTRIES = 100
export const LINKS = 30

export const PR_DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      url updatedAt body
      reviews(last: ${ENTRIES}) { totalCount nodes { author { login } state body submittedAt url } }
      comments(last: ${ENTRIES}) { totalCount nodes { author { login } body createdAt url } }
      closingIssuesReferences(first: ${LINKS}) { nodes { ...link } }
      timelineItems(itemTypes: [CROSS_REFERENCED_EVENT], last: ${LINKS}) {
        nodes { ... on CrossReferencedEvent { source { ...link } } }
      }
      reviewThreads(last: ${THREADS}) {
        totalCount
        nodes {
          isResolved isOutdated path line diffSide
          comments(last: ${PER_THREAD}) { totalCount nodes { author { login } body createdAt url diffHunk } }
        }
      }
    }
  }
}
fragment link on ReferencedSubject {
  __typename
  ... on PullRequest { number title url state isDraft repository { nameWithOwner } }
  ... on Issue { number title url state repository { nameWithOwner } }
}`

const total = (v: unknown): number => {
  const t = obj(v)?.totalCount
  return typeof t === "number" ? t : 0
}
const author = (v: unknown) => str(obj(obj(v)?.author)?.login) || "ghost" // a deleted account

const REVIEW_STATE: Record<string, PrEntry["state"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
}

/** `gh api graphql` output → the PR's detail (null: not an answer). */
export function parsePrDetail(out: string): PrDetail | null {
  let root: unknown
  try {
    root = JSON.parse(out)
  } catch {
    return null
  }
  const pr = obj(obj(obj(obj(root)?.data)?.repository)?.pullRequest)
  if (!pr || !str(pr.url)) return null
  const conversation: PrEntry[] = []
  for (const c of nodes(pr.comments)) {
    const o = obj(c)
    if (o)
      conversation.push({
        kind: "comment",
        author: author(o),
        body: str(o.body),
        at: str(o.createdAt),
        url: str(o.url),
      })
  }
  for (const r of nodes(pr.reviews)) {
    const o = obj(r)
    const state = REVIEW_STATE[str(o?.state)]
    // A review with no summary is only its line comments (shown in their threads), unless
    // it decided something.
    if (!o || !state || (!str(o.body).trim() && state === "commented")) continue
    conversation.push({
      kind: "review",
      author: author(o),
      body: str(o.body),
      at: str(o.submittedAt),
      url: str(o.url),
      state,
    })
  }
  conversation.sort((a, b) => a.at.localeCompare(b.at))
  // Only the newest of a long PR came back: keep the window both lists cover (no reviews
  // sitting in a gap of missing comments, or the reverse).
  const oldest = (kind: PrEntry["kind"]) => conversation.find((e) => e.kind === kind)?.at ?? ""
  const from = [
    total(pr.comments) > ENTRIES ? oldest("comment") : "",
    total(pr.reviews) > ENTRIES ? oldest("review") : "",
  ].reduce((a, b) => (b > a ? b : a), "")
  if (from)
    conversation.splice(
      0,
      conversation.findIndex((e) => e.at >= from),
    )
  const threads: PrThread[] = []
  let more =
    total(pr.comments) > ENTRIES || total(pr.reviews) > ENTRIES || total(pr.reviewThreads) > THREADS
  for (const t of nodes(pr.reviewThreads)) {
    const o = obj(t)
    if (!o || !str(o.path)) continue
    const cs = nodes(o.comments)
    if (total(o.comments) > PER_THREAD) more = true
    const comments = cs.map((c) => {
      const co = obj(c)
      return { author: author(co), body: str(co?.body), at: str(co?.createdAt), url: str(co?.url) }
    })
    threads.push({
      path: str(o.path),
      line: typeof o.line === "number" ? o.line : null,
      removed: str(o.diffSide) === "LEFT",
      resolved: o.isResolved === true,
      outdated: o.isOutdated === true,
      // (the newest comments when there are more: any of them carries the thread's hunk)
      hunk: cs.map((c) => str(obj(c)?.diffHunk)).find(Boolean) ?? "",
      comments,
    })
  }
  const url = str(pr.url)
  const linked = (vs: unknown[]) => {
    const seen = new Set<string>([url])
    const out: PrLink[] = []
    for (const v of vs) {
      const l = parseLink(v)
      if (l && !seen.has(l.url)) {
        seen.add(l.url)
        out.push(l)
      }
    }
    return out
  }
  const sources = nodes(pr.timelineItems).map((t) => obj(t)?.source)
  const closes = linked(nodes(pr.closingIssuesReferences))
  const closed = new Set(closes.map(refKey))
  return {
    url,
    updatedAt: str(pr.updatedAt),
    body: str(pr.body),
    conversation,
    threads,
    links: {
      closes,
      // (an issue it closes is named in its body too: listed once, as closed)
      mentions: bodyRefs(str(pr.body), url).filter((l) => !closed.has(refKey(l))),
      mentionedBy: linked(sources.reverse()).filter((l) => !closed.has(refKey(l))), // newest first
    },
    more,
  }
}

const LINK_STATE: Record<string, PrLink["state"]> = {
  OPEN: "open",
  MERGED: "merged",
  CLOSED: "closed",
}

/** A timeline / closing-reference node → a link (null: not a PR or issue we can see). */
function parseLink(v: unknown): PrLink | null {
  const o = obj(v)
  const kind =
    str(o?.__typename) === "PullRequest" ? "pr" : str(o?.__typename) === "Issue" ? "issue" : null
  if (!o || !kind || typeof o.number !== "number" || !str(o.url)) return null
  const state = LINK_STATE[str(o.state)] ?? null
  return {
    url: str(o.url),
    number: o.number,
    repo: str(obj(o.repository)?.nameWithOwner),
    title: str(o.title),
    kind,
    state: kind === "pr" && state === "open" && o.isDraft === true ? "draft" : state,
  }
}

// `#12`, `owner/name#12`, and github.com/owner/name/pull|issues/12 links, outside code blocks.
/** The PRs and issues a body names, in order, once each (the PR itself left out). */
export function bodyRefs(body: string, self: string): PrLink[] {
  const repo = /github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(self)?.[1] ?? ""
  const out: PrLink[] = []
  const seen = new Set<string>([self.toLowerCase()])
  const add = (r: string, n: number, kind: PrLink["kind"]) => {
    if (!r || !(n > 0)) return
    const url = `https://github.com/${r}/${kind === "issue" ? "issues" : "pull"}/${n}`
    const key = refKey({ repo: r, number: n })
    if (seen.has(key) || seen.has(url.toLowerCase())) return
    seen.add(key)
    out.push({ url, number: n, repo: r, title: "", kind, state: null })
  }
  seen.add(refKey({ repo, number: Number(/\/pull\/(\d+)/.exec(self)?.[1] ?? 0) }))
  // (an HTML comment, as in PR templates, isn't shown: nor are its references)
  const text = bodyBlocks(body.replace(/<!--[\s\S]*?-->/g, " "))
    .filter((b) => !b.code)
    .map((b) => b.text.replace(/`[^`\n]*`/g, " ")) // inline code isn't a reference either
    .join("\n")
  const re =
    /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(pull|issues)\/(\d+)|(?<![\w/#&.:-])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g
  for (const m of text.matchAll(re)) {
    if (m[1]) add(m[1], Number(m[3]), m[2] === "pull" ? "pr" : "issue")
    else add(m[4] ?? repo, Number(m[5]), null)
  }
  return out
}

/** Threads by file (files in path order), open ones first, then by line. */
export function threadsByFile(
  threads: PrThread[],
): { path: string; threads: PrThread[]; open: number }[] {
  const by = new Map<string, PrThread[]>()
  for (const t of threads) {
    const list = by.get(t.path)
    if (list) list.push(t)
    else by.set(t.path, [t])
  }
  const done = (t: PrThread) => Number(t.resolved || t.outdated)
  return [...by]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, ts]) => ({
      path,
      threads: ts.sort((a, b) => done(a) - done(b) || (a.line ?? 0) - (b.line ?? 0)),
      open: ts.filter((t) => !done(t)).length,
    }))
}

/** The last `n` lines of a diff hunk (the lines the thread is on), its `@@` header dropped. */
export function hunkTail(hunk: string, n = 6): string[] {
  const lines = hunk.split(/\r?\n/).filter((l) => !l.startsWith("@@"))
  return lines.slice(-n)
}

/** A body as text and fenced code blocks, in order: shown as text, never as HTML. */
export function bodyBlocks(body: string): { code: boolean; text: string }[] {
  const out: { code: boolean; text: string }[] = []
  body = body.replace(/\r\n?/g, "\n") // GitHub's web editor writes \r\n
  const re = /^```[^\n]*\n([\s\S]*?)^```[ \t]*$/gm
  let at = 0
  for (const m of body.matchAll(re)) {
    const before = body.slice(at, m.index).trim()
    if (before) out.push({ code: false, text: before })
    out.push({ code: true, text: m[1]!.replace(/\n$/, "") })
    at = m.index + m[0].length
  }
  const rest = body.slice(at).trim()
  if (rest) out.push({ code: false, text: rest })
  return out
}

/** When a comment was written, short. */
export function when(at: string, now = Date.now()): string {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return ""
  const m = Math.round((now - t) / 60_000)
  if (m < 1) return "just now"
  if (m < 60) return `${m} min ago`
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`
  return new Date(t).toISOString().slice(0, 10)
}

/** Who a login is to the viewer: one of their gh accounts (`other`: not the acting one), the author. */
export function whoIs(
  login: string,
  ctx: { mine: string[]; acting?: string; author?: string },
): { you: boolean; other: boolean; author: boolean } {
  const l = login.toLowerCase()
  const you = ctx.mine.some((m) => m.toLowerCase() === l)
  return {
    you,
    other: you && !!ctx.acting && ctx.acting.toLowerCase() !== l,
    author: !!ctx.author && ctx.author.toLowerCase() === l,
  }
}
