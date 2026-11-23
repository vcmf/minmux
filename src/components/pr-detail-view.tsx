import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { ArrowSquareOut, Check, PencilSimple } from "@phosphor-icons/react"
import { ipc } from "../lib/ipc"
import { useStore } from "../store"
import {
  hunkTail,
  threadsByFile,
  when,
  type PrDetail,
  type PrDetailResult,
  refKey,
  type PrEntry,
  type PrLink,
  type PrRef,
  type PrLinks,
  type PrThread,
} from "../lib/pr-detail"
import { prErrorText, type PrRow } from "../lib/pr-dashboard"
import { PrReply } from "./pr-reply"
import { PrChecksView } from "./pr-checks-view"
import { usePrWriteSeq } from "./pr-edits"
import { Who } from "./pr-who"
import { MarkdownBlock } from "./markdown-block"
import { prLinkTarget } from "../lib/markdown-links"

// Details already fetched, by PR url: shown at once, and trusted without asking again while
// the PR is unchanged and the answer is under FRESH_MS old (resolving a thread or editing a
// comment may not change the PR's `updatedAt`). Bounded.
const cache = new Map<string, { detail: PrDetail; at: number; seq: number }>()
const CACHE_MAX = 50
const FRESH_MS = 60_000
// per account too: what one account may read, another may not
const cacheKey = (r: PrRow) => `${r.url}\0${r.account ?? ""}`
const DEBOUNCE_MS = 250 // j/k through the list: only the PR it stops on is asked for

// What a body's links need: its repo (for `#12` and relative paths), the dialog's own PRs (a
// reference to one selects it there) and the titles it knows (a reference's tooltip).
const BodyContext = createContext<{
  repo: string
  onGo: (pr: PrRef) => boolean
  titles: Map<string, string>
}>({ repo: "", onGo: () => false, titles: new Map() })

/** A PR's body or comment, rendered as GitHub would (lib/markdown, in a worker). */
function Body({ body }: { body: string }) {
  const { repo, onGo, titles } = useContext(BodyContext)
  const remote = useStore((s) => s.settings.remoteImages)
  const images = useMemo(() => ({ remote }), [remote]) // web images only: no files here
  const decorate = useCallback(
    (el: HTMLElement) => {
      for (const a of el.querySelectorAll<HTMLAnchorElement>("a[data-ref]")) {
        const m = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(a.dataset.ref ?? "")
        const title = m && titles.get(refKey({ repo: m[1]!, number: Number(m[2]) }))
        if (title) a.title = title
      }
    },
    [titles],
  )
  // An untouched template is only comments, which don't show.
  if (!body.replace(/<!--[\s\S]*?(?:-->|$)/g, "").trim()) {
    return <div className="pr-faint">No description.</div>
  }
  const onLink = (href: string, a: HTMLAnchorElement) => {
    const ref = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(a.dataset.ref ?? "")
    if (ref && onGo({ repo: ref[1]!, number: Number(ref[2]) })) return
    const t = prLinkTarget(href, repo)
    if (t?.kind === "external") ipc.openExternal(t.url)
    else if (t?.kind === "anchor") {
      const want = t.anchor.toLowerCase()
      const root = a.closest(".pr-md")
      const h = [...(root?.querySelectorAll<HTMLElement>("[data-anchor]") ?? [])].find(
        (x) => x.dataset.anchor === want,
      )
      h?.scrollIntoView({ block: "start" })
    }
  }
  return (
    <MarkdownBlock
      className="pr-md md-view md-compact"
      text={body}
      repo={repo || undefined}
      onLink={onLink}
      onRendered={decorate}
      images={images}
    />
  )
}

const STATE_WORD: Record<NonNullable<PrEntry["state"]>, [string, string]> = {
  approved: ["approved", "good"],
  changes: ["requested changes", "bad"],
  commented: ["reviewed", ""],
  dismissed: ["review dismissed", ""],
}

function Entry({ e }: { e: PrEntry }) {
  const state = e.state ? STATE_WORD[e.state] : undefined
  return (
    <div className="pr-comment">
      <div className="pr-comment-head">
        <Who login={e.author} bold />
        {state && (
          <span className={`pr-chip ${state[1]}`}>
            {e.state === "approved" && <Check size={10} weight="bold" />}
            {state[0]}
          </span>
        )}
        <span className="pr-faint">{when(e.at)}</span>
        {e.url && (
          <button
            className="pr-link"
            title="Open on GitHub"
            onClick={() => ipc.openExternal(e.url)}
          >
            <ArrowSquareOut size={12} />
          </button>
        )}
      </div>
      {e.body.trim() && <Body body={e.body} />}
    </div>
  )
}

function Hunk({ hunk }: { hunk: string }) {
  const lines = hunkTail(hunk)
  if (!lines.length) return null
  return (
    <pre className="pr-hunk">
      {lines.map((l, i) => (
        <div key={i} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : ""}>
          {l || " "}
        </div>
      ))}
    </pre>
  )
}

function Thread({ t, onOpen }: { t: PrThread; onOpen?: () => void }) {
  const done = t.resolved || t.outdated
  return (
    <details className={`pr-thread${done ? " done" : ""}`} open={!done}>
      <summary>
        <span>
          {t.line === null
            ? t.outdated
              ? "earlier version"
              : "whole file"
            : t.removed
              ? `removed line ${t.line}`
              : `line ${t.line}`}
        </span>
        {t.resolved && <span className="pr-chip good">resolved</span>}
        {t.outdated && !t.resolved && <span className="pr-chip">outdated</span>}
        <span className="pr-faint">
          {t.comments.length} comment{t.comments.length === 1 ? "" : "s"}
        </span>
        {onOpen && !t.outdated && (
          <button
            className="pr-link"
            title="Open in editor at this line"
            onClick={(e) => {
              e.preventDefault()
              onOpen()
            }}
          >
            <PencilSimple size={12} />
          </button>
        )}
      </summary>
      <Hunk hunk={t.hunk} />
      {t.comments.map((c, i) => (
        <Entry key={c.url || i} e={{ kind: "comment", ...c }} />
      ))}
    </details>
  )
}

const notListed = () => false
const NONE: PrRow[] = []

const LINK_STATE: Record<NonNullable<PrLink["state"]>, string> = {
  open: "",
  draft: "draft",
  merged: "merged",
  closed: "closed",
}

/** Linked PRs and issues: one in the dialog's lists is selected there, others open on GitHub. */
function Links(props: {
  links: PrLinks
  repo: string // this PR's: a link in it shows as #N
  listed: PrRow[] // the dialog's lists, every PR once
  onGo: (pr: PrRef) => boolean
}) {
  const { links, repo, listed, onGo } = props
  const groups: [string, PrLink[]][] = [
    ["Closes", links.closes],
    ["Mentions", links.mentions],
    ["Mentioned by", links.mentionedBy],
  ]
  if (!groups.some(([, ls]) => ls.length)) return null
  // A link the timeline titled, or a listed PR: the body's bare #N gets their title.
  const known = new Map([...links.closes, ...links.mentionedBy].map((l) => [refKey(l), l]))
  const rows = new Map(listed.map((r) => [refKey(r), r]))
  return (
    <>
      <h4>Links</h4>
      {groups.map(
        ([label, ls]) =>
          ls.length > 0 && (
            <div key={label} className="pr-links">
              <span className="pr-faint">{label}</span>
              <ul>
                {ls.map((l) => {
                  const row = rows.get(refKey(l))
                  const k = known.get(refKey(l))
                  const title = l.title || row?.title || k?.title || ""
                  const state = row?.state ?? l.state ?? k?.state ?? null
                  const kind = l.kind ?? k?.kind ?? (row ? "pr" : null)
                  const url = k?.url ?? l.url // a bare #N: the timeline knows if it's an issue
                  const sameRepo = l.repo.toLowerCase() === repo.toLowerCase()
                  return (
                    <li key={l.url}>
                      <button
                        className="pr-ref"
                        title={row ? "Show it here" : "Open on GitHub"}
                        onClick={() => onGo(l) || ipc.openExternal(url)}
                      >
                        {sameRepo ? "" : l.repo}#{l.number}
                      </button>{" "}
                      {title && <span>{title}</span>}
                      {state && LINK_STATE[state] && (
                        <span className="pr-chip">{LINK_STATE[state]}</span>
                      )}
                      {kind === "issue" && <span className="pr-faint">issue</span>}
                    </li>
                  )
                })}
              </ul>
            </div>
          ),
      )}
    </>
  )
}

/** The selected PR's description, conversation and review threads (fetched on selection). */
export const PrDetailView = memo(function PrDetailView(props: {
  row: PrRow
  cwd?: string // the focused pane's folder: gh's environment
  wsl?: { distro?: string }
  checkout?: string // this PR's branch checked out on the host: threads open in the editor
  listed?: PrRow[] // the dialog's lists, every PR once (a new answer re-renders the links)
  onGo?: (pr: PrRef) => boolean // select it there (false: it isn't listed)
  onChecksSettled?: () => void // its running checks finished (the dialog's lists catch up)
}) {
  const { row, cwd, wsl, checkout, listed = NONE, onGo = notListed } = props
  const [detail, setDetail] = useState<PrDetail | undefined>(() => cache.get(cacheKey(row))?.detail)
  const [error, setError] = useState<string | null>(null)
  const [missing, setMissing] = useState<string | null>(null)
  // Each write on this PR that finished (through or not, from any box, even one gone since):
  // an answer asked for before it is stale, so the conversation is asked for again (its own
  // run), the one shown meanwhile staying put.
  const seq = usePrWriteSeq(row.url)

  useEffect(() => {
    const key = cacheKey(row)
    const cached = cache.get(key)
    const stale = seq > 0 && (cached?.seq ?? -1) < seq // (a write since it was asked)
    const hit = stale ? undefined : cached
    setDetail(cached?.detail)
    setError(null)
    setMissing(null)
    // (the detail, fetched after the list, can be newer than its row: still fresh)
    if (hit && hit.detail.updatedAt >= row.updatedAt && Date.now() - hit.at < FRESH_MS) return
    let live = true
    const timer = setTimeout(() => {
      const asked = { at: Date.now(), seq } // (stamped when asked: an answer predating a write never passes as newer)
      void ipc
        .prDetail({
          repo: row.repo,
          number: row.number,
          cwd,
          wsl,
          account: row.account,
          ...(stale ? { fresh: true } : {}), // (its own run only right after a write)
        })
        .catch((): PrDetailResult => ({ ok: false, error: "failed" }))
        .then((res) => {
          // Cached even when the view moved on: coming back shows it at once.
          // (never over a newer one: an answer asked before a write lands after the one after)
          if (res.ok && (cache.get(key)?.seq ?? -1) <= asked.seq) {
            cache.delete(key)
            cache.set(key, { detail: res.detail, ...asked })
            if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!)
          }
          if (!live) return
          if (!res.ok) return setError(prErrorText(res))
          setDetail(res.detail)
        })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
    }
    // env is the focused pane's (a link's PR: fixed): a new one doesn't change the PR's comments
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.url, row.updatedAt, row.account, seq])

  const open = (path: string, line: number | null) => {
    if (!checkout) return
    void ipc.pathExists(checkout, path).then((ok) => {
      setMissing(ok ? null : path)
      if (ok) ipc.openFile(checkout, path, line ?? undefined)
    })
  }

  // (the checks have their own light query, asked again while they run)
  const checksView = (
    <PrChecksView row={row} cwd={cwd} wsl={wsl} onSettled={props.onChecksSettled} />
  )
  if (!detail)
    return (
      <>
        {checksView}
        <div className="pr-faint pr-loading">{error ?? "Loading comments…"}</div>
      </>
    )
  return (
    <>
      {checksView}
      <DetailBody
        detail={detail}
        row={row}
        error={error}
        missing={missing}
        onOpen={checkout ? open : undefined}
        listed={listed}
        onGo={onGo}
        reply={<PrReply row={row} cwd={cwd} wsl={wsl} account={row.account} />}
      />
    </>
  )
})

// Parsed once per answer: a re-render of the dialog (its clock, a store update) costs nothing.
function DetailBody(props: {
  detail: PrDetail
  row: PrRow
  error: string | null
  missing: string | null
  onOpen?: (path: string, line: number | null) => void
  listed: PrRow[]
  onGo: (pr: PrRef) => boolean
  reply: React.ReactNode
}) {
  const { detail, row, error, missing, onOpen, listed, onGo, reply } = props
  const files = useMemo(() => threadsByFile(detail.threads), [detail])
  const openThreads = files.reduce((n, f) => n + f.open, 0)
  const bodies = useMemo(() => {
    const { closes, mentions, mentionedBy } = detail.links
    const titles = new Map<string, string>()
    for (const r of listed) if (r.title) titles.set(refKey(r), r.title) // the dialog's own PRs
    for (const l of [...closes, ...mentions, ...mentionedBy]) {
      if (l.title) titles.set(refKey(l), l.title)
    }
    return { repo: row.repo, onGo, titles }
  }, [detail.links, listed, row.repo, onGo])
  return (
    <BodyContext.Provider value={bodies}>
      <div className="pr-detail-body">
        {error && <div className="pr-error stale">{error} Showing the last answer.</div>}
        <h4>Description</h4>
        <Body body={detail.body} />
        <Links links={detail.links} repo={row.repo} listed={listed} onGo={onGo} />
        {files.length > 0 && (
          <>
            <h4>
              Review threads ({detail.threads.length}
              {openThreads ? `, ${openThreads} open` : ""})
            </h4>
            {missing && <div className="pr-faint">{missing} isn't in this checkout.</div>}
            {files.map((f) => (
              <div key={f.path} className="pr-file">
                <div className="pr-file-path">
                  <code>{f.path}</code>
                </div>
                {f.threads.map((t, i) => (
                  <Thread
                    key={t.comments[0]?.url || i}
                    t={t}
                    onOpen={onOpen && !t.removed ? () => onOpen(f.path, t.line) : undefined}
                  />
                ))}
              </div>
            ))}
          </>
        )}
        <h4>Conversation ({detail.conversation.length})</h4>
        {detail.conversation.length === 0 ? (
          <div className="pr-faint">No comments yet.</div>
        ) : (
          detail.conversation.map((e, i) => <Entry key={e.url || i} e={e} />)
        )}
        {detail.more && (
          <div className="pr-faint">
            Some comments aren't shown here.{" "}
            <a
              href={row.url}
              onClick={(e) => {
                e.preventDefault()
                ipc.openExternal(row.url)
              }}
            >
              See them all on GitHub
            </a>
          </div>
        )}
        {reply}
      </div>
    </BodyContext.Provider>
  )
}
