import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  ArrowClockwise,
  ArrowSquareOut,
  Check,
  Copy,
  GitMerge,
  GithubLogo,
  GitPullRequest,
  Graph,
  ListBullets,
  TerminalWindow,
  X,
} from "@phosphor-icons/react"
import { useStore } from "../store"
import { useShallow } from "zustand/react/shallow"
import { agentIcon } from "./agent-icon"
import { AGENT_STATUS_STILL as DOT } from "../lib/agent-status-ui"
import { agentInfo } from "../lib/agent-kinds"
import type { AgentGraph, AgentKind, AgentStatus } from "../lib/agent-graph"
import { herePr, prPanes, type PrPane } from "../lib/pr-panes"
import type { PaneGitInfo } from "../lib/pane-git"
import type { Session } from "../types"
import { ipc } from "../lib/ipc"
import { displaySessionTitle } from "../lib/session-label"
import {
  mergePart,
  openOnly,
  nextRefreshMs,
  prErrorText,
  PR_TABS,
  statusParts,
  tabFor,
  type GhAccount,
  type PrLists,
  type PrListsError,
  type PrListsRequest,
  type PrListsResult,
  type PrRow,
  type PrTab,
} from "../lib/pr-dashboard"
import { prStateUi } from "../lib/pane-git"
import { refocusActiveTerminal } from "./refocus-terminal"
import { PrDetailView } from "./pr-detail-view"
import { PrPeople } from "./pr-people"
import { Who } from "./pr-who"
import { PrReviewers } from "./pr-reviewers"
import { PrStatusLine, StatusChip } from "./pr-status-line"
import { PrLabels } from "./pr-labels"
import { ROW_LABELS } from "../lib/pr-labels"
import { PrClosedBanner } from "./pr-closed-banner"
import type { PrBranchAction } from "../lib/pr-branch"
import { withHeld } from "../lib/pr-reviewers"
import { heldRows, usePrEdits } from "./pr-edits"
import { refKey, type PrRef } from "../lib/pr-detail"
import { repoUrl, findErrorText, prUrl, type PrFindResult } from "../lib/pr-link"
import { ghEnvOf, paneGhEnv } from "../lib/open-link"
import { baseOf, stackedOn, stackRows, type StackRow } from "../lib/pr-stacks"
import { graphLayout, graphMove, type GraphKey } from "../lib/pr-graph"
import { PrGraphView } from "./pr-graph-view"
import { toDialog } from "./to-dialog"

// gh's accounts as last answered (a failed answer too): the picker stays to pick another.
let knownAccounts: GhAccount[] = []
// The last answer, kept across opens: shown at once (with its age) while a refresh runs.
// Kept across restarts too (a few kB): the first open after launch shows it at once.
type Last = { lists: PrLists; at: number; closed: boolean; key: string }
const LAST_KEY = "minmux.prDialog.last"
const readLast = (): Last | null => {
  try {
    const v = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null") as Last | null
    return v && typeof v.key === "string" && v.lists && Array.isArray(v.lists.mine) ? v : null
  } catch {
    return null
  }
}
let last: Last | null = readLast()
const saveLast = () => {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(last))
  } catch {
    // per-viewer convenience only
  }
}
const TAB_KEY = "minmux.prDialog.tab"
// List or graph (docs/design/PR_GRAPH.md): the one picked, kept across opens.
type PrView = "list" | "graph"
const VIEW_KEY = "minmux.prDialog.view"
const readView = (): PrView => {
  try {
    return localStorage.getItem(VIEW_KEY) === "graph" ? "graph" : "list"
  } catch {
    return "list"
  }
}
const GRAPH_KEYS: Record<string, GraphKey> = {
  ArrowLeft: "left",
  h: "left",
  ArrowRight: "right",
  l: "right",
  ArrowUp: "up",
  k: "up",
  ArrowDown: "down",
  j: "down",
}
const TEXT_FIELD =
  "textarea, select, input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])"

const readTab = (): PrTab => {
  try {
    const t = localStorage.getItem(TAB_KEY) as PrTab | null
    return t && PR_TABS.includes(t) ? t : "mine"
  } catch {
    return "mine"
  }
}

const keyOf = (r: PrListsRequest) =>
  JSON.stringify([r.cwd ?? "", r.wsl ? (r.wsl.distro ?? "") : null, r.closed, r.account ?? null])

/** Whether a tab's search has answered (an answer kept from before, asked at once: all). */
const answered = (l: PrLists, t: PrTab) => !l.answered || !!l.answered[t]

const ACCOUNT_KEY = "minmux.prDialog.account"
const readAccount = (): string | undefined => {
  try {
    return localStorage.getItem(ACCOUNT_KEY) || undefined
  } catch {
    return undefined
  }
}

const FIND_AGAIN_MS = 5_000

/** A PR a link named (in `pane`): asked for on its own until the lists have it. */
type Linked = {
  ref: PrRef
  at: number
  pane?: string
  // gh's environment, fixed when the link was clicked: the one that found it (as its account)
  // is the one its detail, checks and writes run in, whatever happens to the pane since
  env: { cwd?: string; wsl?: { distro?: string } }
  row?: PrRow
  error?: string
}

const ago = (ms: number) =>
  ms < 10_000
    ? "just now"
    : ms < 60_000
      ? `${Math.round(ms / 1000)} s ago`
      : `${Math.round(ms / 60_000)} min ago`

// Each PR's panes, the agent working on it in each, and the panes' titles, as flat
// primitives [url, pane, agent, status, title, …]: the shallow compare re-renders the dialog
// only when one of these changes. Computed again only when what it reads changes (the agents
// tree, a pane's git, a session: an agent hook does change the tree; the work is per pane,
// small). Cleared when the dialog closes (no store snapshot kept).
let flatMemo: { args: unknown[]; out: string[] } | null = null
const forgetFlat = () => {
  flatMemo = null
}
function paneFlatOf(
  graph: AgentGraph,
  paneGit: Record<string, PaneGitInfo>,
  sessions: Record<string, Session>,
  home: string,
): string[] {
  const args = [graph, paneGit, sessions, home]
  if (flatMemo && flatMemo.args.every((a, i) => a === args[i])) return flatMemo.out
  const panes = Object.values(sessions).map((x) => ({ id: x.id, cwd: x.cwd }))
  const out: string[] = []
  for (const [url, ps] of prPanes(graph, paneGit, panes))
    for (const p of ps)
      out.push(
        url,
        p.pane,
        p.agent ?? "",
        p.status ?? "",
        displaySessionTitle(sessions[p.pane], home),
      )
  flatMemo = { args, out }
  return out
}

/** The focused pane (the active tab's focused terminal). */
const useFocusedPane = () =>
  useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId)

/** The focused pane's checkout root and branch, once its git lookup answered. */
function useFocusedCheckout(): { root?: string; branch?: string } {
  const sid = useFocusedPane()
  const root = useStore((s) => (sid ? s.paneGit[sid]?.root : undefined))
  const branch = useStore((s) => (sid ? (s.paneGit[sid]?.branch ?? undefined) : undefined))
  return useMemo(() => ({ root, branch }), [root, branch])
}

/** The focused pane's checkout: the repo tab's repo, and gh's environment (WSL or host). */
function useFocusedRequest(closed: boolean, account: string | undefined): PrListsRequest {
  const sid = useFocusedPane()
  const session = useStore((s) => (sid ? s.sessions[sid] : undefined))
  const root = useStore((s) => (sid ? s.paneGit[sid]?.root : undefined))
  return useMemo(() => {
    const who = account ? { account } : {}
    return { ...ghEnvOf(session, root), closed, ...who } // (an ssh pane has no checkout)
  }, [session, root, closed, account])
}

/** The pull requests dialog: mine, review requested, the focused pane's repo. */
export function PrDialog() {
  const [closed, setClosed] = useState(last?.closed ?? false)
  // One gh account's lists, or (none) every account's.
  const [account, setAccountState] = useState<string | undefined>(readAccount)
  const setAccount = (a: string | undefined) => {
    setAccountState(a)
    try {
      if (a) localStorage.setItem(ACCOUNT_KEY, a)
      else localStorage.removeItem(ACCOUNT_KEY)
    } catch {
      // per-viewer convenience only
    }
  }
  const req = useFocusedRequest(closed, account)
  const checkout = useFocusedCheckout()
  // Only for the same request (the same repo and "closed"): another pane's repo isn't shown.
  const mine = last?.key === keyOf(req) ? last : null
  const [answer, setAnswer] = useState<PrLists | null>(mine?.lists ?? null)
  const [at, setAt] = useState(mine?.at ?? 0)
  const [error, setError] = useState<{ error: PrListsError; message?: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const [tab, setTabState] = useState<PrTab>(readTab)
  const [view, setViewState] = useState<PrView>(readView)
  // `remember`: a view the user picked (a card or a link switching to the list isn't kept).
  const setView = (v: PrView, remember = true) => {
    setViewState(v)
    if (!remember) return
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      // per-viewer convenience only
    }
  }
  const [selUrl, setSelUrl] = useState<string | null>(null) // by PR: a reorder keeps it
  const [now, setNow] = useState(Date.now())
  // The answer with the PRs just changed from here in place (their own rows: search lags).
  const edits = usePrEdits()
  const lists = useMemo(
    () => {
      if (!answer) return null
      const held = withHeld(answer, heldRows())
      return closed ? held : openOnly(held) // (open ones only: a PR closed or merged leaves)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `edits` / `now`: when to look again
    [answer, edits, now, closed],
  )
  const answerRef = useRef(answer) // the lists as merged so far (the parts answer one by one)
  const failures = useRef(0)
  const pendingAsked = useRef(false) // asked again once gh's accounts were known (per request)
  const busy = useRef(false)
  const again = useRef(false)
  const halted = useRef(false)
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
      forgetFlat()
    },
    [],
  )
  const reqRef = useRef(req)
  reqRef.current = req
  const listRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => {
    useStore.getState().setPrDialogOpen(false)
    refocusActiveTerminal()
  }, [])

  // Not installed / logged out: no more automatic tries (the button still asks).
  const [accounts, setAccounts] = useState<GhAccount[]>(knownAccounts)
  const setLists = (l: PrLists | null) => {
    answerRef.current = l
    setAnswer(l)
  }

  // One tab's answer, merged in as it comes (the other tabs keep theirs).
  const applyPart = useCallback((res: PrListsResult, r: PrListsRequest, part: PrTab) => {
    const accs = res.ok ? res.lists.accounts : res.accounts
    if (accs) {
      knownAccounts = accs
      setAccounts(accs)
    }
    if (!r.wsl && res.ok) useStore.getState().setGhMissing(false)
    const merged = mergePart(answerRef.current, part, res)
    if (merged && merged !== answerRef.current) setLists(merged)
    if (res.ok) setAt(Date.now())
  }, [])

  // All three answered: errors, backoff, and the answer kept (across restarts too).
  const finish = useCallback((results: PrListsResult[], r: PrListsRequest) => {
    const failed = results.filter((x): x is Exclude<PrListsResult, { ok: true }> => !x.ok)
    if (failed.length === results.length) {
      failures.current++
      const err =
        failed.find((x) => x.error === "missing" || x.error === "unauthenticated") ?? failed[0]!
      halted.current = err.error === "missing" || err.error === "unauthenticated"
      if (!r.wsl && err.error === "missing") useStore.getState().setGhMissing(true)
      setError({ error: err.error, message: err.message })
      return
    }
    failures.current = 0
    halted.current = false
    setError(null)
    // (rows listed before gh's accounts were known aren't kept: they'd act as whoever is
    // gh's active account later)
    if (answerRef.current && !answerRef.current.accountsPending) {
      last = { lists: answerRef.current, at: Date.now(), closed: r.closed, key: keyOf(r) }
      saveLast()
    }
  }, [])

  // One at a time. Asked again meanwhile (the repo changed, "closed" toggled): once more
  // right after; an answer for a request that's no longer the one shown is dropped. The
  // three tabs are asked at once, each shown as soon as it answers (one slow search doesn't
  // hold the others).
  const refresh = useCallback(async (): Promise<void> => {
    if (busy.current) {
      again.current = true
      return
    }
    busy.current = true
    setLoading(true)
    const r = reqRef.current
    const current = () => alive.current && keyOf(reqRef.current) === keyOf(r)
    const before = answerRef.current // (every tab failing: back to it, not a list of notes)
    const results = await Promise.all(
      PR_TABS.map((part) =>
        ipc
          .prLists({ ...r, part })
          .catch((): PrListsResult => ({ ok: false, error: "failed" }))
          .then((res) => {
            if (current()) applyPart(res, r, part)
            return res
          }),
      ),
    )
    busy.current = false
    if (!alive.current) return
    setLoading(false)
    if (current()) {
      if (results.every((x) => !x.ok)) setLists(before)
      finish(results, r)
    }
    if (!current() || again.current) {
      again.current = false
      return refresh()
    }
    // Listed as gh's active account while gh's accounts were looked up (that's slow: a
    // network check of each): once they're known, asked again, so every account's PRs join.
    if (
      !r.account &&
      !pendingAsked.current &&
      results.some((x) => x.ok && x.lists.accountsPending)
    ) {
      pendingAsked.current = true
      const accs = await ipc.prAccounts(r.wsl).catch(() => [])
      if (!accs.length || !current()) return
      // gh's active account is the only one: what was listed is already everything (tagged
      // now, and kept), no second round
      const l = answerRef.current
      if (accs.length === 1 && accs[0]!.active && l) {
        const login = accs[0]!.login
        const tag = (rows: PrRow[]) => rows.map((x) => ({ ...x, account: login }))
        const done: PrLists = {
          ...l,
          mine: tag(l.mine),
          review: tag(l.review),
          ...(l.repo ? { repo: tag(l.repo) } : {}),
          accounts: accs,
          pending: {},
        }
        delete done.accountsPending
        setLists(done)
        finish(results, r)
        return
      }
      return refresh()
    }
  }, [applyPart, finish])

  // On open, and when the repo or "closed" changes: at once; then by nextRefreshMs while open
  // (nothing runs while it's closed, nor while the window is hidden).
  const reqKey = keyOf(req)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stop = false
    // Another request: its own last answer or none, and gh is asked again even if it was
    // missing or logged out before (maybe fixed since).
    halted.current = false
    pendingAsked.current = false
    // This request's own answer, or none: never what another one merged so far.
    setLists(last?.key === reqKey ? last.lists : null)
    setAt(last?.key === reqKey ? last.at : 0)
    const loop = async () => {
      if (document.visibilityState !== "hidden" && !halted.current) await refresh()
      if (stop) return
      timer = setTimeout(() => void loop(), nextRefreshMs(last?.lists ?? null, failures.current))
    }
    void loop()
    return () => {
      stop = true
      clearTimeout(timer)
    }
  }, [reqKey, refresh])

  // The "updated … ago" label.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(t)
  }, [])

  // Each PR's panes, the agent working on it in each and its status, and the panes' titles,
  // as flat primitives [url, pane, agent, status, title, …]: the shallow compare re-renders
  // the dialog only when one of these changes (not on every agent hook, every terminal title
  // of an unrelated pane, nor a pane's agent with no PR).
  const paneFlat = useStore(useShallow((s) => paneFlatOf(s.agents, s.paneGit, s.sessions, s.home)))
  const { panes, titles } = useMemo(() => {
    const panes = new Map<string, PrPane[]>()
    const titles = new Map<string, string>()
    for (let i = 0; i + 4 < paneFlat.length; i += 5) {
      const [url, pane, agent, status, title] = paneFlat.slice(i, i + 5) as string[]
      const list = panes.get(url!) ?? []
      list.push({
        pane: pane!,
        ...(agent ? { agent: agent as AgentKind, status: status as AgentStatus } : {}),
      })
      panes.set(url!, list)
      titles.set(pane!, title!)
    }
    return { panes, titles }
  }, [paneFlat])
  const titleOf = (id: string) => titles.get(id) ?? id
  // The focused pane, and the PR it's on (the "here" marker; selected once when it opens).
  const focusedPane = useFocusedPane()
  const hereUrl = useStore((s) =>
    herePr(
      s.agents,
      s.paneGit,
      focusedPane ? { id: focusedPane, cwd: s.sessions[focusedPane]?.cwd } : undefined,
    ),
  )

  // No repo tab once the repo's answer says there's none (before it answers: shown, loading).
  const noRepo = !!lists && !lists.repoName && answered(lists, "repo") && !lists.warnings?.repo
  const tabs: PrTab[] = noRepo ? ["mine", "review"] : PR_TABS
  const shownTab = tabs.includes(tab) ? tab : "mine"
  // Every PR the lists know (each once): a stack's base or a link may be in another tab.
  const all = useMemo(() => {
    const seen = new Map<string, PrRow>()
    for (const t of PR_TABS)
      for (const r of lists?.[t] ?? []) if (!seen.has(r.url)) seen.set(r.url, r)
    return [...seen.values()]
  }, [lists])
  const stack = useMemo(
    () => stackRows((lists?.[shownTab] ?? []) as PrRow[], all),
    [lists, shownTab, all],
  )
  const rows = useMemo(() => stack.map((s) => s.row), [stack])
  // (laid out only while the graph is shown: the list view does no graph work)
  const graph = useMemo(
    () => (view === "graph" ? graphLayout(stack, hereUrl) : null),
    [view, stack, hereUrl],
  )
  const selIdx = rows.findIndex((r) => r.url === selUrl)
  const row = rows[selIdx] ?? rows[0] // gone from the list: the first
  // When the list first shows rows, the PR the focused pane is on is selected if it's there;
  // decided then, once: the selection never moves on its own later (a refresh, a poll).
  const herePicked = useRef(false)
  // (before paint: the first PR's detail never flashes up first)
  useLayoutEffect(() => {
    if (herePicked.current || rows.length === 0) return
    herePicked.current = true
    if (selUrl === null && hereUrl && rows.some((r) => r.url === hereUrl)) setSelUrl(hereUrl)
  }, [hereUrl, rows, selUrl])
  // A PR link clicked (a terminal's, the sidebar's): that PR, selected where the lists have
  // it; otherwise asked for on its own (as an account that can see it) and shown apart.
  const prLink = useStore((s) => s.prLink)
  const [linked, setLinked] = useState<Linked | null>(null)
  // the detail's PR (a linked one with any change made here since: its own row, as the lists')
  const shown = linked
    ? linked.row && withHeld({ mine: [linked.row], review: [] }, heldRows()).mine[0]
    : row
  const select = (url: string) => {
    setSelUrl(url)
    setLinked(null)
  }
  // Asked for with the link's pane's gh (a WSL pane's own), else the focused pane's.
  const lastFind = useRef(0) // (a refresh right after a lookup asks nothing more)
  const find = useCallback((l: Linked, quiet = false) => {
    lastFind.current = Date.now()
    const env = l.env
    void ipc
      .prFind({ ...l.ref, cwd: env.cwd, wsl: env.wsl })
      .catch((): PrFindResult => ({ ok: false, error: "failed" }))
      .then((res) => {
        if (!alive.current) return
        setLinked((cur) =>
          cur?.at !== l.at
            ? cur
            : res.ok
              ? { ...cur, row: res.row, error: undefined }
              : quiet && cur.row
                ? cur // (a refresh that failed: the row shown stays)
                : { ...cur, error: findErrorText(res, l.ref) },
        )
      })
  }, [])
  useEffect(() => {
    if (!prLink) return
    herePicked.current = true // (the link's PR, not the focused pane's)
    setViewState("list") // (its detail is the list's; the view picked stays saved)
    const l: Linked = {
      ref: { repo: prLink.repo, number: prLink.number },
      at: prLink.at,
      pane: prLink.pane,
      // (the link's pane's gh; none named, or gone: the focused pane's)
      env:
        prLink.pane && useStore.getState().sessions[prLink.pane]
          ? paneGhEnv(useStore.getState(), prLink.pane)
          : { cwd: reqRef.current.cwd, wsl: reqRef.current.wsl },
    }
    if (goToRef.current(l.ref)) return setLinked(null) // listed already: nothing to ask
    setLinked(l)
    find(l)
  }, [prLink, find])
  // A refresh done (every minute, after a change, a CI run settling): the linked PR too.
  const linkedRef = useRef(linked)
  linkedRef.current = linked
  // (one that failed is asked again too: back online, signed in since)
  useEffect(() => {
    const l = linkedRef.current
    if (!loading && (l?.row || l?.error) && Date.now() - lastFind.current > FIND_AGAIN_MS)
      find(l, true)
  }, [loading, find])
  // gh's environment for the PR shown: the link's pane's when it came from a link (the one
  // that found it, as its account), else the focused pane's.
  const env = linked ? linked.env : req
  // Listed (now, or once the lists answer): selected there instead.
  useEffect(() => {
    // (by the answer's own repo too: a renamed repo's old link answers with its new name)
    if (!linked || !lists || goToRef.current(linked.ref)) return
    if (linked.row) goToRef.current(linked.row)
  }, [linked, lists])

  const move = (by: number) => {
    const at = row && !linked ? rows.indexOf(row) : -1 // (from the row shown; a link's: the top)
    const next = rows[Math.min(Math.max(at + by, 0), rows.length - 1)]
    if (next) select(next.url)
  }

  // `remember`: a tab the user picked (one a link moved to isn't kept for the next open).
  const setTab = (t: PrTab, sel: string | null = null, remember = true) => {
    setTabState(t)
    setSelUrl(sel)
    setLinked(null)
    if (!remember) return
    try {
      localStorage.setItem(TAB_KEY, t)
    } catch {
      // per-viewer convenience only
    }
  }

  // A PR named in the dialog (a stack, a link): selected where it's listed, this tab first.
  // Not in any list: false (the caller opens it on GitHub).
  const goTo = (pr: PrRef): boolean => {
    const key = refKey(pr)
    const here = rows.find((r) => refKey(r) === key)
    if (here) {
      select(here.url)
      return true
    }
    const t = tabs.find((t) => (lists?.[t] ?? []).some((r) => refKey(r) === key))
    const r = t && lists?.[t]?.find((r) => refKey(r) === key)
    if (!t || !r) return false
    setTab(t, r.url, false)
    return true
  }
  // Stable for the memoised detail view (it re-renders for its own PR, and new lists).
  const goToRef = useRef(goTo)
  goToRef.current = goTo
  const goToStable = useCallback((pr: PrRef) => goToRef.current(pr), [])
  const refreshSoon = useCallback(() => void refresh(), [refresh])
  // A PR closed here leaves the open lists: never selected again when a list has it once more
  // (a lagging search, a reopen); the detail moves on to the list's first.
  const onChanged = (action: PrBranchAction, pr: PrRow) => {
    if (action === "close" && !closed) setSelUrl((u) => (u === pr.url ? null : u))
    refreshSoon()
  }

  // A card: its PR in the list view (not kept as the view picked).
  const openInList = (url: string) => {
    select(url)
    setView("list", false)
  }
  // A repo's root: the repo tab when it's that repo's (the only repo with a tab), else GitHub.
  const openRoot = (repo: string) => {
    if (tabs.includes("repo") && lists?.repoName?.toLowerCase() === repo.toLowerCase()) {
      setTab("repo", null, false)
      setView("list", false)
    } else ipc.openExternal(repoUrl(repo))
  }

  const goToPane = (id: string) => {
    useStore.getState().setPrDialogOpen(false)
    useStore.getState().focusSession(id)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = e.key
    if (k === "Escape") {
      e.preventDefault()
      return close()
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return // app and OS shortcuts stay theirs
    // A focused button or checkbox keeps Enter and Space; the dialog's other keys still work.
    const target = e.target as HTMLElement
    // typing, not commands
    if (target.isContentEditable || target.matches?.(TEXT_FIELD)) return
    const control = target.closest("button, input, select, textarea, a")
    if (control && (k === "Enter" || k === " ")) return
    // (the graph's arrows move in it: tabs stay on 1/2/3 there)
    const moves = !!graph && graph.nodes.length > 0 // (an empty graph: arrows switch tabs)
    const t = !moves || !GRAPH_KEYS[k] ? tabFor(k, shownTab, tabs) : null
    if (t) {
      e.preventDefault()
      return setTab(t)
    }
    if (k === "g") {
      e.preventDefault()
      return setView(view === "graph" ? "list" : "graph")
    }
    if (moves && GRAPH_KEYS[k]) {
      e.preventDefault()
      const next = graphMove(graph, linked ? null : (row?.url ?? null), GRAPH_KEYS[k])
      if (next) select(next)
      return
    }
    if (graph && k === "Enter" && row && !linked) {
      e.preventDefault()
      return openInList(row.url)
    }
    if (k === "ArrowDown" || k === "j") {
      e.preventDefault()
      move(1)
    } else if (k === "ArrowUp" || k === "k") {
      e.preventDefault()
      move(-1)
    } else if ((k === "o" || k === "Enter") && (shown || linked)) {
      e.preventDefault()
      ipc.openExternal(shown?.url ?? prUrl(linked!.ref))
    } else if (k === "r") {
      e.preventDefault()
      void refresh()
    }
  }

  // Keyboard focus lives in the dialog while it's open; the selected row stays in view.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => rootRef.current?.focus(), [])
  const refocusDialog = useCallback(() => rootRef.current?.focus(), [])
  // A focused control that went away (the picker, a removed request, a detail link): focus
  // falls to the page, and the dialog's keys with it.
  const onBlur = () =>
    setTimeout(() => {
      if (alive.current && document.activeElement === document.body) refocusDialog()
    })
  useEffect(() => {
    listRef.current?.querySelector(".pr-row.sel")?.scrollIntoView?.({ block: "nearest" })
  }, [row?.url, shownTab, view]) // (back from the graph too: its pick may be far down)

  const several = accounts.length > 1
  // Names in the detail: yours (any of gh's accounts) marked, the PR's author with a chip.
  const shownAccount = shown?.account
  const shownAuthor = shown?.author
  // Whose: gh's accounts where the PR shown came from (a link from a pane with another gh,
  // a WSL distro: that gh's own), else the dialog's; before they're known, the last answer's.
  const linkedAccounts = useLinkedAccounts(linked, req.wsl)
  const known = linkedAccounts ?? (accounts.length ? accounts : (last?.lists.accounts ?? []))
  const mineKey = known.map((a) => a.login).join(" ")
  const activeLogin = known.find((a) => a.active)?.login
  const people = useMemo(
    () => ({
      mine: mineKey ? mineKey.split(" ") : [],
      acting: shownAccount ?? activeLogin,
      author: shownAuthor,
    }),
    [mineKey, activeLogin, shownAccount, shownAuthor],
  )
  // The saved pick when gh here has it, signed in (else every account's: main does the same).
  // The pick itself stays saved: another pane's gh (a WSL distro), or a moment offline,
  // doesn't forget it.
  const picked = accounts.some((a) => a.login === account && a.ok) ? account : undefined
  const label = (t: PrTab) =>
    t === "mine"
      ? "Mine"
      : t === "review"
        ? "Review requested"
        : `${lists?.repoName ?? "Repo"}${several && lists?.repoAccount ? ` · @${lists.repoAccount}` : ""}`

  // What an empty tab says (the list's and the graph's alike).
  const empty =
    lists && rows.length === 0
      ? !answered(lists, shownTab)
        ? "Loading…" // (this tab's search still running; the others may be in)
        : shownTab === "review"
          ? "No pull requests wait for your review."
          : shownTab === "repo" && lists.repoVisible === false && lists.accountsPending
            ? "Checking which of gh's accounts can see it…"
            : shownTab === "repo" && lists.repoVisible === false
              ? `${picked ? `@${picked} can't` : several ? "No logged-in gh account can" : "gh's account can't"} see ${lists.repoName}.${several && picked ? " Pick another account, or All accounts." : ""}`
              : "No pull requests."
      : !lists && !error
        ? "Loading…"
        : null
  // The tab listing a stack's base PR that this tab doesn't (a graph stub names it).
  const tabOf = (pr: PrRow) => {
    const t = tabs.find((t) => (lists?.[t] ?? []).some((r) => r.url === pr.url))
    return t ? label(t) : undefined
  }

  const dialog = (
    <div className="settings-overlay" onMouseDown={close}>
      <div
        ref={rootRef}
        className="pr-dialog"
        role="dialog"
        aria-label="Pull requests"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="pr-header">
          <GithubLogo size={16} />
          <h2>Pull requests</h2>
          <AccountPicker accounts={accounts} account={picked} onPick={setAccount} />
          <div className="pr-views" role="group" aria-label="View">
            {(["list", "graph"] as const).map((v) => (
              <button
                key={v}
                className={`pr-view${view === v ? " on" : ""}`}
                aria-pressed={view === v}
                title={`${v === "list" ? "List" : "Graph"} (g)`}
                onClick={(e) => {
                  setView(v)
                  toDialog(e.currentTarget)
                }}
              >
                {v === "list" ? <ListBullets size={13} /> : <Graph size={13} />}
                {v === "list" ? "List" : "Graph"}
              </button>
            ))}
          </div>
          <span className="pr-age">
            {loading ? "Refreshing…" : at ? `Updated ${ago(now - at)}` : ""}
          </span>
          <button className="iconbtn" title="Refresh (r)" onClick={() => void refresh()}>
            <ArrowClockwise size={15} />
          </button>
          <button className="iconbtn" title="Close (Esc)" onClick={close}>
            <X size={16} />
          </button>
        </div>
        <div className="pr-tabs" role="tablist">
          {tabs.map((t, i) => (
            <button
              key={t}
              role="tab"
              aria-selected={t === shownTab}
              className={`pr-tab${t === shownTab ? " on" : ""}`}
              title={`${label(t)} (${i + 1})`}
              onClick={() => setTab(t)}
            >
              {label(t)}
              {lists && answered(lists, t) && (
                <span className="pr-count">{(lists[t] ?? []).length}</span>
              )}
            </button>
          ))}
          <label className="pr-closed">
            <input type="checkbox" checked={closed} onChange={(e) => setClosed(e.target.checked)} />
            Include closed (14 days)
          </label>
        </div>
        {error && (
          <div className={`pr-error${lists ? " stale" : ""}`}>
            {prErrorText(error)}
            {lists ? " Showing the last answer." : ""}
          </div>
        )}
        {/* (the lists, open ones only, drop a PR closed here at once: the way back is here) */}
        <PrClosedBanner now={now} listed={all} onReopened={refreshSoon} />
        {lists?.warning && !error && (
          <div className="pr-error stale">Some pull requests couldn't load: {lists.warning}</div>
        )}
        {graph && empty ? (
          <div className="pr-graph">
            <div className="pr-empty">{empty}</div>
          </div>
        ) : graph ? (
          <PrGraphView
            graph={graph}
            selected={linked ? null : (row?.url ?? null)}
            hereUrl={hereUrl}
            panes={panes}
            titleOf={titleOf}
            focusedRepo={tabs.includes("repo") ? lists?.repoName : undefined}
            onOpen={openInList}
            onRoot={openRoot}
            onGo={goTo}
            tabOf={tabOf}
          />
        ) : (
          <div className="pr-body">
            <div className="pr-list" ref={listRef} role="listbox" aria-label={label(shownTab)}>
              {empty && <div className="pr-empty">{empty}</div>}
              {stack.map((s) => (
                <PrListRow
                  key={s.row.url}
                  stack={s}
                  selected={!linked && s.row === row}
                  showRepo={shownTab !== "repo"}
                  showAccount={several && !picked}
                  panes={panes.get(s.row.url) ?? []}
                  here={s.row.url === hereUrl ? focusedPane : undefined}
                  titleOf={titleOf}
                  onSelect={() => select(s.row.url)}
                  onGo={goTo}
                />
              ))}
            </div>
            <div className="pr-detail">
              {linked && (
                <LinkedNote
                  linked={linked}
                  listed={!!lists && PR_TABS.every((t) => answered(lists, t))}
                />
              )}
              {shown ? (
                <>
                  <PrSummary
                    row={shown}
                    panes={(panes.get(shown.url) ?? []).map((p) => ({
                      ...p,
                      title: titleOf(p.pane),
                    }))}
                    focused={focusedPane}
                    onPane={goToPane}
                    base={baseOf(shown, all)}
                    above={stackedOn(shown, all)}
                    onGo={goTo}
                    env={env}
                    onChanged={onChanged}
                    reviewers={
                      <PrReviewers
                        key={shown.url}
                        row={shown}
                        cwd={env.cwd}
                        wsl={env.wsl}
                        account={shown.account}
                        showAccount={several}
                      />
                    }
                  />
                  <PrDetailView
                    key={shown.url}
                    row={shown}
                    listed={all}
                    onGo={goToStable}
                    onChecksSettled={refreshSoon}
                    cwd={env.cwd}
                    wsl={env.wsl}
                    // Threads open in the editor when the focused checkout is this PR's repo on
                    // its branch (the threads' lines are the PR's), at the repo's root; host
                    // only (the editor can't open a WSL pane's Linux path).
                    // (a linked PR: only when its link came from the focused pane, whose checkout this is)
                    checkout={
                      (!linked || !linked.pane || linked.pane === focusedPane) &&
                      !req.wsl &&
                      checkout.root &&
                      checkout.branch === shown.head &&
                      !shown.fork &&
                      lists?.repoName?.toLowerCase() === shown.repo.toLowerCase()
                        ? checkout.root
                        : undefined
                    }
                  />
                </>
              ) : (
                !linked && <div className="pr-empty">Select a pull request.</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
  return <PrPeople.Provider value={people}>{dialog}</PrPeople.Provider>
}

/** gh's accounts in a linked PR's own environment, when that's another gh than the dialog's
 *  (null: the dialog's accounts are the ones). */
function useLinkedAccounts(
  linked: Linked | null,
  wsl: { distro?: string } | undefined,
): GhAccount[] | null {
  const envKey = (w?: { distro?: string }) => (w ? `wsl:${w.distro ?? ""}` : "host")
  const other = !!linked && envKey(linked.env.wsl) !== envKey(wsl)
  const linkWsl = linked?.env.wsl
  const [got, setGot] = useState<{ at: number; list: GhAccount[] } | null>(null)
  const at = other ? linked!.at : 0
  useEffect(() => {
    if (!at) return
    let live = true
    void ipc
      .prAccounts(linkWsl)
      .catch(() => [])
      .then((list) => live && setGot({ at, list }))
    return () => {
      live = false
    }
    // (asked once per link: `at` names it, and its env is fixed)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [at])
  return other && got?.at === at ? got.list : null
}

/** Above a linked PR's detail: it's not in these lists, it's loading, or it can't be shown. */
function LinkedNote({ linked, listed }: { linked: Linked; listed: boolean }) {
  const { ref, row, error } = linked
  const name = `${ref.repo}#${ref.number}`
  const url = prUrl(ref)
  // ("not in these lists" only once they've all answered)
  if (row)
    return (
      <div className="pr-faint pr-linked">From a link{listed ? ": not in these lists." : "."}</div>
    )
  if (!error) return <div className="pr-empty">Loading {name}…</div>
  return (
    <div className="pr-linked-error">
      <div className="pr-error">{error}</div>
      <button className="pr-open" onClick={() => ipc.openExternal(url)}>
        <ArrowSquareOut size={13} /> Open {name} on GitHub
      </button>
    </div>
  )
}

/** Which gh account the dialog runs as: gh's only one, or a pick among several (all: each). */
function AccountPicker(props: {
  accounts: GhAccount[]
  account: string | undefined
  onPick: (account: string | undefined) => void
}) {
  const { accounts, account, onPick } = props
  if (accounts.length === 0) return null
  if (accounts.length === 1)
    return (
      <span className="pr-account" title="gh's account">
        as @{accounts[0]!.login}
      </span>
    )
  const shown = accounts.some((a) => a.login === account) ? account : undefined
  return (
    <select
      className="pr-accounts"
      aria-label="GitHub account"
      title="The gh account the dialog runs as (gh's own active account is left as it is)"
      value={shown ?? ""}
      onChange={(e) => {
        onPick(e.target.value || undefined)
        // the dialog's keys again (a focused select would take j/k and the arrows)
        e.currentTarget.closest<HTMLElement>("[role=dialog]")?.focus()
      }}
    >
      <option value="">All accounts ({accounts.length})</option>
      {accounts.map((a) => (
        <option key={a.login} value={a.login} disabled={!a.ok}>
          @{a.login}
          {a.active ? " (gh's active)" : ""}
          {a.ok ? "" : " (signed out)"}
        </option>
      ))}
    </select>
  )
}

/** Whether an event came from a control inside a row (that control handles it). */
const inControl = (e: React.MouseEvent) =>
  !!(e.target as HTMLElement).closest(".pr-row-main button, .pr-row-main [data-control]")

/** Keys back to the dialog after a click on one of its controls (Enter opens the PR again). */

/** A repo's name: opens its page on GitHub. In a list row, a clickable label (no control
 *  inside an option: the list's own keys move through rows). */
function RepoLink({ repo, inRow }: { repo: string; inRow?: boolean }) {
  if (!repo) return null
  const open = (e: React.MouseEvent<HTMLElement>) => {
    ipc.openExternal(repoUrl(repo))
    toDialog(e.currentTarget)
  }
  const title = `Open ${repo} on GitHub`
  return inRow ? (
    <span className="pr-repo pr-repo-link" data-control title={title} onClick={open}>
      {repo}
    </span>
  ) : (
    <button className="pr-repo-link" title={title} onClick={open}>
      {repo}
    </button>
  )
}

/** A branch name: a click copies it (said for a moment). */
function CopyBranch({ name, fork }: { name: string; fork?: boolean }) {
  const [copied, setCopied] = useState<string | null>(null) // (the name it was: another PR's isn't)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(t)
  }, [copied])
  const done = copied === name
  return (
    <button
      className={`pr-branch${done ? " copied" : ""}`}
      title={
        done
          ? "Copied"
          : `Copy the branch name (${name})${fork ? ": it's in the author's fork" : ""}`
      }
      onClick={(e) => {
        ipc.clipboardWrite(name)
        setCopied(name)
        toDialog(e.currentTarget)
      }}
    >
      <code>{name}</code>
      {done ? <Check size={11} weight="bold" /> : <Copy size={11} />}
    </button>
  )
}

function StateIcon({ row }: { row: PrRow }) {
  const ui = prStateUi(row.state)
  const Icon = row.state === "merged" ? GitMerge : GitPullRequest
  return (
    <span className="pr-state" style={{ color: `var(--${ui.color})` }} title={ui.word}>
      <Icon size={14} weight={row.state === "draft" ? "regular" : "bold"} />
    </span>
  )
}

function PrListRow(props: {
  stack: StackRow
  selected: boolean
  showRepo: boolean
  showAccount: boolean // several accounts listed: which one this PR came from
  panes: PrPane[]
  here: string | undefined // the focused pane, when this is the PR it's on
  titleOf: (pane: string) => string
  onSelect: () => void
  onGo: (pr: PrRow) => boolean
}) {
  const { stack, selected, showRepo, showAccount, panes, here, titleOf, onSelect, onGo } = props
  const { row, depth, last, guides, kids, on } = stack
  // The agents tree's connectors: a curved elbow from the parent's line into this PR's icon,
  // the line running on past it to a later sibling, an ancestor's line running past, and
  // this PR's own line down to the PRs stacked on it.
  const x = (level: number) => ({ left: STACK_X0 + level * STACK_STEP })
  return (
    <div
      className={`pr-row${selected ? " sel" : ""}`}
      role="option"
      aria-selected={selected}
      // (a click inside on a control of its own, the repo's name or a chip, is that control's)
      onClick={(e) => !inControl(e) && onSelect()}
      onDoubleClick={(e) => !inControl(e) && ipc.openExternal(row.url)}
      style={depth ? { paddingLeft: 12 + depth * STACK_STEP } : undefined}
    >
      {depth > 0 && <span className="pr-tree elbow" style={x(depth - 1)} aria-hidden />}
      {depth > 0 && !last && <span className="pr-tree through" style={x(depth - 1)} aria-hidden />}
      {guides.map(
        (g, i) => g && <span key={i} className="pr-tree guide" style={x(i)} aria-hidden />,
      )}
      {kids && <span className="pr-tree spine" style={x(depth)} aria-hidden />}
      <StateIcon row={row} />
      <div className="pr-row-main">
        <div className="pr-row-title">
          <span className="pr-num">#{row.number}</span> {row.title}
        </div>
        <div className="pr-row-status">
          {showRepo && <RepoLink repo={row.repo} inRow />}
          {showAccount && row.account && (
            <span className="pr-account" title={`Listed as @${row.account}`}>
              @{row.account}
            </span>
          )}
          {statusParts(row).map((p) => (
            <StatusChip key={p} part={p} />
          ))}
          <PrLabels row={row} max={ROW_LABELS} inRow />
          {panes.length > 0 && <WorkingChip panes={panes} here={here} titleOf={titleOf} />}
          {on && (
            <button
              className="pr-chip pr-on"
              title={`Stacked on #${on.number}: ${on.title}`}
              onClick={(e) => {
                e.stopPropagation()
                onGo(on)
              }}
            >
              on #{on.number}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// A stacked row's indent, and where a row's icon centre sits (its line's x): row padding 12,
// icon 14 wide, less half the line's width.
const STACK_STEP = 22
const STACK_X0 = 12 + 7 - 1

/** A PR checked out in panes: its agent and status (the focused pane's on the "here" PR,
 *  else the busiest pane's; a terminal if none), and how many panes have it. */
function WorkingChip(props: {
  panes: PrPane[]
  here: string | undefined
  titleOf: (pane: string) => string
}) {
  const { panes, here, titleOf } = props
  // the focused pane's agent; a plain terminal there: the busiest other pane's (never hidden)
  const mine = panes.find((p) => p.pane === here)
  const lead = mine?.agent ? mine : (panes.find((p) => p.agent) ?? mine ?? panes[0]!)
  const Icon = lead.agent ? agentIcon(lead.agent) : TerminalWindow
  const d = lead.status ? DOT[lead.status] : undefined
  const who = panes
    .map((p) =>
      p.agent
        ? `${agentInfo(p.agent).label} ${DOT[p.status ?? "idle"].word} in ${titleOf(p.pane)}`
        : `checked out in ${titleOf(p.pane)}`,
    )
    .join("; ")
  const more = panes.length > 1 ? panes.length - (here ? 1 : 0) : 0
  return (
    <span
      className={`pr-chip pane${here ? " here" : ""}`}
      title={`${here ? "Your current terminal is on it. " : ""}${who}`}
    >
      <Icon size={11} />
      {d && <span className={`dot sm ${d.cls}`} />}
      {here ? "here" : null}
      {more ? `${here ? "+" : ""}${more}` : null}
    </span>
  )
}

function PrSummary(props: {
  row: PrRow
  panes: (PrPane & { title: string })[]
  focused: string | undefined // the focused pane
  onPane: (id: string) => void
  reviewers: React.ReactNode
  base: PrRow | null // the PR this one is stacked on
  above: PrRow[] // the PRs stacked on this one
  onGo: (pr: PrRow) => boolean
  env: { cwd?: string; wsl?: { distro?: string } }
  onChanged: (action: PrBranchAction, row: PrRow) => void // its state changed: lists catch up
}) {
  const { row, panes, focused, onPane, reviewers, base, above, onGo, env, onChanged } = props
  const link = (pr: PrRow) => (
    <button
      key={pr.url}
      className="pr-ref"
      title={pr.title}
      onClick={() => onGo(pr) || ipc.openExternal(pr.url)}
    >
      #{pr.number}
    </button>
  )
  return (
    <div className="pr-summary">
      <div className="pr-summary-title">
        <StateIcon row={row} />
        <h3>
          {row.title} <span className="pr-num">#{row.number}</span>
        </h3>
        <button
          className="iconbtn pr-title-open"
          title="Open on GitHub (o)"
          aria-label="Open on GitHub"
          onClick={() => ipc.openExternal(row.url)}
        >
          <ArrowSquareOut size={15} />
        </button>
      </div>
      <div className="pr-meta">
        {row.repo && (
          <>
            <RepoLink repo={row.repo} /> ·{" "}
          </>
        )}
        <Who login={row.author} /> · <CopyBranch name={row.head} fork={row.fork} /> →{" "}
        <CopyBranch name={row.base} /> · <span className="pr-add">+{row.additions}</span>{" "}
        <span className="pr-del">−{row.deletions}</span>
      </div>
      <PrStatusLine
        row={row}
        panes={panes.map((p) => p.title)}
        cwd={env.cwd}
        wsl={env.wsl}
        account={row.account}
        onChanged={onChanged}
      />
      {row.labels?.length ? (
        <div className="pr-row-status pr-labels">
          <PrLabels row={row} />
        </div>
      ) : null}
      {(base || above.length > 0) && (
        <div className="pr-meta pr-stack-line">
          {base && <>Stacked on {link(base)}</>}
          {base && above.length > 0 && " · "}
          {above.length > 0 && <>Stacked on this: {above.map(link)}</>}
        </div>
      )}
      {reviewers}
      {panes.length > 0 && (
        <>
          {/* an agent on its branch: "working on it"; a plain terminal: checked out */}
          <h4>
            {panes.some((p) => p.status === "working" || p.status === "waiting")
              ? "Working on it"
              : "Checked out in"}
          </h4>
          <div className="pr-panes">
            {panes.map((p) => {
              const Icon = p.agent ? agentIcon(p.agent) : TerminalWindow
              const d = p.status ? DOT[p.status] : undefined
              return (
                <button
                  key={p.pane}
                  className={`pr-pane${p.pane === focused ? " here" : ""}`}
                  title={p.pane === focused ? "This terminal" : "Go to this terminal"}
                  onClick={() => onPane(p.pane)}
                >
                  <Icon size={13} /> {p.title}
                  {d && (
                    <>
                      <span className={`dot sm ${d.cls}`} />
                      <span className="pr-faint">{d.word}</span>
                    </>
                  )}
                  {p.pane === focused && <span className="pr-faint">· here</span>}
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
