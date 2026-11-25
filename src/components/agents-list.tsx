import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react"
import { shownTerminalTab } from "../lib/view-tabs"
import { useShallow } from "zustand/react/shallow"
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  Copy,
  GitBranch,
  GitMerge,
  GitPullRequest,
} from "@phosphor-icons/react"
import { activeTheme, useStore } from "../store"
import { TerminalManager } from "../terminal/terminal-manager"
import { ipc } from "../lib/ipc"
import { AGENT_KINDS, AVAILABLE_AGENTS, agentColor, agentInfo, agentsOn } from "../lib/agent-kinds"
import { sessionColor } from "../lib/session-color"
import { paneLeads, type AgentKind } from "../lib/agent-graph"
import { agentWorkDirs, gitKey, inGitFor } from "../lib/agent-dirs"
import { prStateUi, type PrInfo, type PrState } from "../lib/pane-git"
import { openLink } from "../lib/open-link"
import { displaySessionTitle, shellType, shortCwd, tabTitle } from "../lib/session-label"
import { AGENT_STATUS_UI as DOT } from "../lib/agent-status-ui"
import { formatTokens, tokenBreakdown } from "../lib/tokens"
import {
  activeGroups,
  inactiveOf,
  pastIndex,
  type ActiveGroup,
  type ActiveRow,
} from "../lib/agents-list"
import {
  ago,
  filterPast,
  shownBy,
  pastLabel,
  paneOf,
  openPaneMap,
  openSessionPanes,
  type PastSession,
  type PastSessionsResult,
  MAX_QUERY,
  MIN_QUERY,
  type SearchEnd,
  type SessionHit,
} from "../lib/past-sessions"
import { agentIcon } from "./agent-icon"
import { AgentsIcon } from "./agent-marks"
import { AgentTree } from "./agent-tree"
import { AgentProcesses, LeftRunning } from "./agent-processes"
import { useAgentProcesses } from "./use-agent-processes"
import { ResumeDialog } from "./resume-dialog"

const HIDDEN_KEY = "minmux.sessions.hidden" // agents switched off by their chip
const HERE_KEY = "minmux.sessions.here"
const DEBOUNCE_MS = 300 // a search starts once typing pauses
const INACTIVE_PAGE = 100 // inactive rows drawn at first, and per "Show more"

/** A search's hits so far, per row key (agent:id). */
interface Search {
  found: Map<string, SessionHit>
  end: SearchEnd | null // null while it runs
}

/** One line on where a search is: running, what it found, or why it stopped. */
function searchStatus(s: Search, found: number): string {
  if (!s.end) return found ? `Searching… ${found} so far` : "Searching…"
  if (s.end.failed) return "The search failed. Try again."
  const not = s.end.couldNot?.map((k) => agentInfo(k).label)
  const n =
    found > 0
      ? `${found} session${found === 1 ? "" : "s"}`
      : not?.length
        ? "No match in the sessions searched"
        : "No conversation has those words"
  const base = s.end.timedOut
    ? `${n} in the time allowed: the search stopped early.`
    : s.end.capped
      ? `${n} (the first found).`
      : found === 0
        ? `${n}.`
        : n
  if (!not?.length) return base
  const names =
    not.length > 1 ? `${not.slice(0, -1).join(", ")} and ${not[not.length - 1]}` : not[0]
  return `${base}${base.endsWith(".") ? "" : "."} Couldn't search ${names} sessions.`
}

/** The matched words in a snippet, marked. */
function Snippet({ hit }: { hit: SessionHit }) {
  return (
    <span className="tree-sub past-session-hit">
      <Marked hit={hit} />
    </span>
  )
}

/** A hit's text with the searched words marked. */
function Marked({ hit }: { hit: Pick<SessionHit, "snippet" | "match" | "length"> }) {
  const { snippet: s, match, length } = hit
  return (
    <>
      {s.slice(0, match)}
      <mark>{s.slice(match, match + length)}</mark>
      {s.slice(match + length)}
    </>
  )
}

const readHidden = (): Set<AgentKind> => {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]") as unknown
    return new Set(Array.isArray(v) ? (v as AgentKind[]) : [])
  } catch {
    return new Set()
  }
}
const readHere = (): boolean => {
  try {
    return localStorage.getItem(HERE_KEY) === "1"
  } catch {
    return false
  }
}
const save = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // a per-window convenience: fine to lose
  }
}

const goTo = (pane: string) => {
  useStore.getState().focusSession(pane)
  TerminalManager.focus(pane)
}

/** Where a click goes: a running session's pane, else a resume (asked first). */
interface Target {
  key: string
  agent: AgentKind
  sessionId: string
  label: string
  cwd?: string
  cwdGone?: boolean
  paneId?: string // its open pane: running there (go), or ended there (resume beside it)
  running: boolean
}

/** One session's line: the agent icon doubles as the expand button (▸ on hover, ▾ open). */
function SessionLine({
  target,
  icon: Icon,
  iconColor,
  hue,
  expanded,
  onToggle,
  onOpen,
  title,
  mark,
  blocked,
  sub,
  right,
  children,
}: {
  target: Target
  icon: ReturnType<typeof agentIcon>
  iconColor?: string
  hue?: string
  expanded: boolean
  onToggle: () => void
  onOpen: () => void
  title: string
  mark?: SessionHit // a hit in its name, the title itself: shown with the words marked
  blocked?: boolean // nothing a click can do (its folder is gone)
  sub: ReactNode
  right: ReactNode
  children?: ReactNode // the details, when expanded
}) {
  // One box for the line and its details: the session's colour tints all of it.
  return (
    <div
      className={`agent-line-box${target.running ? " open" : ""}${hue ? " tinted" : ""}`}
      style={hue ? ({ "--row-hue": hue } as CSSProperties) : undefined}
    >
      <div
        className={`diff-file past-session agent-line${target.running ? " open" : ""}${expanded ? " expanded" : ""}`}
        role="button"
        tabIndex={0}
        aria-disabled={blocked || undefined}
        title={title}
        onClick={onOpen}
        onKeyDown={(e) => {
          // The row's own keys only (Enter on its toggle or copy button must not open it).
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return
          e.preventDefault()
          onOpen()
        }}
      >
        <div className="tree-labels">
          <span className="tree-primary">
            <button
              className="agent-line-toggle"
              aria-expanded={expanded}
              aria-label={expanded ? "Hide details" : "Show details"}
              title={expanded ? "Hide details" : "Show details"}
              onClick={(e) => {
                e.stopPropagation()
                onToggle()
              }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <span className="agent-line-icon">
                <Icon size={11} color={iconColor} />
              </span>
              <span className="agent-line-caret">
                {expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
              </span>
            </button>{" "}
            {mark ? (
              <span className="agent-line-marked">
                <Marked hit={mark} />
              </span>
            ) : (
              target.label
            )}
          </span>
          <span className="tree-sub">{sub}</span>
        </div>
        <div className="tree-right">{right}</div>
      </div>
      {expanded && <div className="agent-line-details">{children}</div>}
    </div>
  )
}

/** The agents panel's one list (docs/design/AGENTS_PANEL.md): sessions in open panes grouped like
 *  the sidebar, the current group first; then every other past session, newest first. */
export function AgentsList() {
  const home = useStore((s) => s.home)
  const platform = useStore((s) => s.platform)
  const switches = useStore((s) => s.settings.agents)
  const graph = useStore((s) => s.agents)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => (s.activeView ? null : s.activeTabId)) // none behind a view
  const terminals = useStore((s) => s.sessions)
  const agentMeta = useStore((s) => s.agentMeta)
  // Per lead pane, its branch and PR as the sidebar shows them (the agent's own checkout when it
  // moved, checked like the sidebar's `in` line, else the pane's): primitives, so another pane's
  // git answer (or an `@edit` one) doesn't re-render the list.
  const gitFlat = useStore(
    useShallow((s) => {
      const work = agentWorkDirs(s.agents)
      return Object.entries(paneLeads(s.agents)).flatMap(([pane, lead]) => {
        const inGit = inGitFor(s.paneGit[gitKey(pane, "in")], work[pane]?.cwd, lead.agent)
        const g = inGit ?? s.paneGit[pane]
        return [pane, g?.branch ?? "", g?.pr?.number ?? 0, g?.pr?.state ?? "", g?.pr?.url ?? ""]
      })
    }),
  )
  const gitOf = (pane: string): { branch?: string; pr?: PrInfo } | undefined => {
    for (let i = 0; i < gitFlat.length; i += 5)
      if (gitFlat[i] === pane) {
        const [branch, number, state, url] = gitFlat.slice(i + 1, i + 5) as [
          string,
          number,
          PrState,
          string,
        ]
        return { branch: branch || undefined, pr: number ? { number, state, url } : undefined }
      }
    return undefined
  }
  const activePaneId = useStore((s) => shownTerminalTab(s)?.activeSessionId)
  const activeCwd = activePaneId ? terminals[activePaneId]?.cwd : undefined
  const scheme = useStore((s) => activeTheme(s).scheme)
  const listed = platform !== "win32" // past sessions aren't listed on Windows yet
  const [result, setResult] = useState<PastSessionsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [hidden, setHidden] = useState(readHidden)
  const [here, setHere] = useState(readHere)
  const [notes, setNotes] = useState<Record<string, string>>({}) // per row: why it didn't resume
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [openProcs, setOpenProcs] = useState<Set<string>>(new Set()) // panes whose list is open
  const [ask, setAsk] = useState<{ target: Target; busy?: string } | null>(null)
  // Inactive draws its newest rows first, the rest on request: opening the panel stays quick.
  const [shownInactive, setShownInactive] = useState(INACTIVE_PAGE)
  const opening = useRef(new Set<string>()) // rows whose resume plan is being asked for

  const enabled = agentsOn(platform).filter((k) => switches[k].enabled)
  const withHistory = enabled.filter((k) => AGENT_KINDS[k].history)
  const loadSeq = useRef(0) // the newest read: an older answer landing later is dropped
  const load = useCallback(() => {
    if (!listed) return
    const seq = ++loadSeq.current
    setLoading(true)
    void ipc
      .pastSessions()
      .then((r) => seq === loadSeq.current && setResult(r))
      .catch(() => seq === loadSeq.current && setResult({ sessions: [], failed: [] }))
      .finally(() => seq === loadSeq.current && setLoading(false))
  }, [listed])
  // Read when shown; again only for a session that ended but isn't listed yet (its row resumes
  // from the listing), not on every end.
  useEffect(load, [load])
  const listedIds = useMemo(() => new Set(result?.sessions.map((s) => s.sessionId)), [result])
  // Each id asked for once: a session never written (closed before its first prompt) never gets
  // listed, and mustn't re-read the listing on every render.
  const askedFor = useRef(new Set<string>())
  const unlisted = result
    ? (graph.ended ?? [])
        .filter(
          (e) =>
            AGENT_KINDS[e.agent].history &&
            !listedIds.has(e.sessionId) &&
            !askedFor.current.has(e.sessionId),
        )
        .map((e) => e.sessionId)
        .join(",")
    : ""
  useEffect(() => {
    if (!unlisted) return
    for (const id of unlisted.split(",")) askedFor.current.add(id)
    load()
  }, [unlisted, load])

  const shownKey = enabled.filter((k) => !hidden.has(k)).join(",")
  const visible = useMemo(() => new Set(shownKey.split(",") as AgentKind[]), [shownKey])
  const rows = useMemo(
    () => (result ? filterPast(result.sessions, visible, here ? activeCwd : undefined) : []),
    [result, visible, here, activeCwd],
  )
  // Search: in the sessions worker; a new query (or a filter change) cancels the last.
  const [query, setQuery] = useState("")
  const [search, setSearch] = useState<Search | null>(null)
  const searchId = useRef(0)
  useEffect(
    () =>
      ipc.onSessionHits((id, hits, end) => {
        if (id !== searchId.current) return
        setSearch((s) => {
          if (!s) return s
          const found = new Map(s.found)
          for (const h of hits) found.set(`${h.agent}:${h.sessionId}`, h)
          return { found, end: end ?? s.end }
        })
      }),
    [],
  )
  const q = query.trim().length >= MIN_QUERY ? query.trim() : ""
  const under = here ? activeCwd : undefined
  useEffect(() => {
    if (!q) return setSearch(null)
    let live = true // this query is still the one shown
    let started = 0
    setSearch({ found: new Map(), end: null }) // the last query's hits go at once
    const timer = setTimeout(() => {
      void ipc
        .searchSessions(q, shownKey.split(",") as AgentKind[], under)
        .then((id) => {
          // The query changed while it started: it's cancelled, its hits never shown.
          if (!live) return id && ipc.cancelSessionSearch(id)
          started = id
          searchId.current = id
          if (!id) setSearch((s) => s && { ...s, end: { capped: false, failed: true } })
        })
        .catch(() => {
          if (live) setSearch((s) => s && { ...s, end: { capped: false, failed: true } })
        })
    }, DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
      if (started) ipc.cancelSessionSearch(started)
      searchId.current = 0
    }
  }, [q, shownKey, under])
  // Searching: the sessions found, each as the list knows it, else as the hit says (one newer
  // than the list, or beyond its first 500).
  const shown = useMemo(() => {
    if (!search) return rows
    const known = new Map((result?.sessions ?? []).map((s) => [`${s.agent}:${s.sessionId}`, s]))
    const found = [...search.found].flatMap(([k, h]) => {
      const row = known.get(k) ?? h.session
      return row ? [row] : []
    })
    return filterPast(
      found.sort((a, b) => b.updatedAt - a.updatedAt),
      visible,
      here ? activeCwd : undefined,
    )
  }, [rows, result, search, visible, here, activeCwd])

  // The open pane of each session the board or a resume knows: a few primitives, so a store
  // change walks those, never the whole listing; rows look themselves up in it.
  const openFlat = useStore(useShallow((s) => openSessionPanes(s.agents, s.sessions, s.resume)))
  const openPane = useMemo(() => openPaneMap(openFlat), [openFlat])
  const searching = !!search
  // Per search hit, its open pane ("" = none): only while searching (nothing else reads it).
  const panes = useMemo(
    () => (searching ? shown.map((s) => openPane.get(`${s.agent}:${s.sessionId}`) ?? "") : []),
    [searching, shown, openPane],
  )
  const pastByKey = useMemo(() => pastIndex(shown), [shown])
  // The board's sessions: the chips filter them, the Settings switches don't (a session still
  // running after its agent was switched off stays listed, as it did before).
  const liveKey = AVAILABLE_AGENTS.filter((k) => !hidden.has(k)).join(",")
  const shows = useMemo(
    () => shownBy(new Set(liveKey.split(",") as AgentKind[]), here ? activeCwd : undefined),
    [liveKey, here, activeCwd],
  )
  // On a board or tab change: the groups only (a handful of sessions), never the listing.
  const list = useMemo(
    () =>
      activeGroups({
        graph,
        tabs,
        activeTabId: activeTabId ?? "",
        past: pastByKey,
        open: openPane,
        shows,
      }),
    [graph, tabs, activeTabId, pastByKey, openPane, shows],
  )
  // Each listed session's own colour (/color, or its renamed name's), once per list.
  const ownHue = useMemo(() => {
    const m = new Map<string, string>()
    for (const r of shown) {
      const c = sessionColor({ name: r.name, color: r.color, auto: r.nameAuto }, scheme)
      if (c) m.set(`${r.agent}:${r.sessionId}`, c)
    }
    return m
  }, [shown, scheme])
  const leads = paneLeads(graph)
  // A session leading an open pane: the pane's live colour (a /color or /rename since).
  const hueOf = (key: string, paneId?: string, sessionId?: string) =>
    (paneId && leads[paneId]?.sessionId === sessionId && agentMeta[paneId]
      ? sessionColor(agentMeta[paneId], scheme)
      : undefined) ?? ownHue.get(key)

  // Processes: for an expanded session leading a local pane (not on Windows yet), polled only
  // while its list is open; what agents left running, once one has run in this minmux.
  const procPanes = new Set(
    platform === "win32"
      ? []
      : list.groups.flatMap((g) =>
          g.rows.flatMap((r) =>
            expanded.has(r.key) &&
            r.paneId &&
            leads[r.paneId]?.sessionId === r.sessionId &&
            !terminals[r.paneId]?.remote
              ? [r.paneId]
              : [],
          ),
        ),
  )
  const [agentsSeen, setAgentsSeen] = useState(false)
  if (!agentsSeen && graph.rootIds.length) setAgentsSeen(true)
  const procsResult = useAgentProcesses(
    new Set([...openProcs].filter((id) => procPanes.has(id))),
    platform !== "win32" && agentsSeen,
  )

  const toggle = (key: string) =>
    setExpanded((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  const toggleProcs = (paneId: string) =>
    setOpenProcs((s) => {
      const next = new Set(s)
      if (next.has(paneId)) next.delete(paneId)
      else next.add(paneId)
      return next
    })
  const toggleAgent = (k: AgentKind) => {
    const next = new Set(hidden)
    if (next.has(k)) next.delete(k)
    else next.add(k)
    setHidden(next)
    save(HIDDEN_KEY, JSON.stringify([...next]))
  }
  const toggleHere = () => {
    setHere(!here)
    save(HERE_KEY, here ? "0" : "1")
  }
  const note = (t: Target, text: string) => setNotes((n) => ({ ...n, [t.sessionId]: text }))

  // A click: go to a running session's pane; else ask before resuming (nothing to ask when its
  // folder is gone: the row says why).
  const open = (t: Target) => {
    // Running: go to its pane (one elsewhere, outside a pane, has nowhere to go).
    if (t.running) return t.paneId ? goTo(t.paneId) : undefined
    const st = useStore.getState()
    const there = paneOf(t, st.agents, st.sessions, st.resume)
    if (there) return goTo(there)
    if (!t.cwd || t.cwdGone || opening.current.has(t.sessionId)) return
    setAsk({ target: t })
  }
  const resume = async (t: Target, confirmed: boolean) => {
    setAsk(null)
    opening.current.add(t.sessionId)
    try {
      const plan = await ipc.resumeOne({ agent: t.agent, sessionId: t.sessionId }, confirmed)
      // Main says it may be running elsewhere: ask again, saying so.
      if (plan?.busy) return setAsk({ target: t, busy: plan.reason })
      if (!plan || plan.status !== "resume")
        return note(t, plan?.reason ?? "can't be resumed from here (refresh the list)")
      // Started meanwhile (another click, or by hand): go there instead of a second copy.
      const now = useStore.getState()
      const there = paneOf(t, now.agents, now.sessions, now.resume)
      if (there) return goTo(there)
      // Ended in a pane that's still open: beside that pane; else beside the one you're in.
      if (t.paneId && now.sessions[t.paneId]) now.focusSession(t.paneId)
      const id = useStore.getState().resumeInSplit(plan)
      if (!id) return note(t, "couldn't open a terminal for it here")
      setNotes((n) => {
        const next = { ...n }
        delete next[t.sessionId]
        return next
      })
      TerminalManager.focus(id)
    } catch {
      note(t, "can't be resumed from here")
    } finally {
      opening.current.delete(t.sessionId)
    }
  }
  const openFolder = (cwd: string, paneId?: string) =>
    useStore.getState().openFolderInSplit(cwd, paneId)

  /** A past session's line (inactive, or a search hit). */
  const pastLine = (s: PastSession, pane: string | undefined) => {
    const key = `${s.agent}:${s.sessionId}`
    const blocked = !pane && (!s.cwd || s.cwdGone)
    const why = blocked ? (s.cwd ? "folder gone" : "folder unknown") : notes[s.sessionId]
    const t: Target = {
      key,
      agent: s.agent,
      sessionId: s.sessionId,
      label: pastLabel(s),
      cwd: s.cwd,
      cwdGone: s.cwdGone,
      paneId: pane,
      running: !!pane,
    }
    const hit = search?.found.get(key)
    // Found in its name and the match is the whole title as shown (not a cut, nor an older name
    // than the worker's): marked in the title, no snippet below. Else the snippet says why.
    const mark = hit?.inName && hit.snippet === t.label ? hit : undefined
    return (
      <div key={key} className={blocked ? "past-session-blocked" : undefined}>
        <SessionLine
          target={t}
          icon={agentIcon(s.agent)}
          iconColor={pane ? agentColor(s.agent, scheme) : undefined}
          hue={hueOf(key, pane, s.sessionId)}
          expanded={expanded.has(key)}
          onToggle={() => toggle(key)}
          onOpen={() => open(t)}
          title={`${pane ? "Go to its pane" : blocked ? why : "Resume it (asks first)"}\n${agentInfo(s.agent).label} · ${s.sessionId}${s.cwd ? `\n${s.cwd}` : ""}`}
          blocked={blocked}
          mark={mark}
          sub={
            <>
              {shortCwd(s.cwd, home) || "—"}
              {why && <span className="status-faint"> · {why}</span>}
              {hit && !mark && (
                <>
                  <br />
                  <Snippet hit={hit} />
                </>
              )}
            </>
          }
          right={
            <>
              <span className="status-faint">{ago(s.updatedAt)}</span>
              <CopyId id={s.sessionId} />
            </>
          }
        >
          <SessionInfo agent={s.agent} sessionId={s.sessionId} folder={s.cwd} />
          {s.firstPrompt && <div className="agent-line-prompt status-faint">{s.firstPrompt}</div>}
        </SessionLine>
      </div>
    )
  }

  // The inactive rows change only when a session starts or stops, or with the listing, a filter,
  // a note or an expand: not on every hook event, which re-renders the groups above them.
  const activeKey = [...list.keys].join(",")
  const inactive = useMemo(
    () => inactiveOf(shown, openPane, list.keys),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [shown, openPane, activeKey],
  )
  // A new filter, folder or search starts over at the newest rows (the cap stays a cap).
  const pageKey = `${hidden.size}|${[...hidden].join()}|${here}|${activeCwd ?? ""}|${!!query.trim()}`
  useEffect(() => setShownInactive(INACTIVE_PAGE), [pageKey])
  // The search hits, likewise: rebuilt when they (or what's shown on them) change, not on every
  // hook event. An open hit's colour is its pane's live one: part of the key.
  const hitHues = panes
    .map((p, i) =>
      p ? (hueOf(`${shown[i]!.agent}:${shown[i]!.sessionId}`, p, shown[i]!.sessionId) ?? "") : "",
    )
    .join(",")
  const searchRows = useMemo(
    () => (searching ? shown.map((s, i) => pastLine(s, panes[i] || undefined)) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [searching, shown, panes, hitHues, search, expanded, notes, ownHue, home, scheme],
  )
  const inactiveRows = useMemo(
    () => (searching ? [] : inactive.slice(0, shownInactive).map((s) => pastLine(s, undefined))),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inactive, shownInactive, expanded, notes, ownHue, searching, home, scheme],
  )

  /** A session in an open pane: running (go there) or ended there (resume beside it). */
  const activeLine = (r: ActiveRow) => {
    const node = r.node
    const meta = agentMeta[r.paneId]
    // The pane's live /rename names the session leading it (not one that ended there before).
    const isLead = !!r.paneId && leads[r.paneId]?.sessionId === r.sessionId
    const git = isLead ? gitOf(r.paneId) : undefined
    const label =
      (isLead && meta?.name) ||
      (r.past && pastLabel(r.past)) ||
      (terminals[r.paneId] ? displaySessionTitle(terminals[r.paneId], home) : "session")
    const cwd = node?.cwd ?? r.cwd ?? r.past?.cwd
    const t: Target = {
      key: r.key,
      agent: r.agent,
      sessionId: r.sessionId,
      label,
      cwd,
      cwdGone: r.past?.cwdGone,
      paneId: r.paneId || undefined,
      running: r.running,
    }
    // Ended, and nothing to resume it in: says why (no dialog).
    const why = r.running
      ? undefined
      : !cwd
        ? "folder unknown"
        : r.past?.cwdGone
          ? "folder gone"
          : undefined
    const d = node ? DOT[node.status] : undefined
    const word = !r.running
      ? "ended"
      : `${d?.word ?? "starting"}${node?.currentTool ? ` · ${node.currentTool}` : ""}`
    // The pane you're in: its running session(s) get the border (an ended one isn't there now).
    const here = r.running && !!r.paneId && r.paneId === activePaneId
    return (
      <div
        key={r.key}
        className={`agent-session${here ? " active" : ""}${r.running ? "" : " ended"}${why ? " past-session-blocked" : ""}`}
        title={here ? "The pane you're in" : undefined}
      >
        <SessionLine
          target={t}
          icon={agentIcon(r.agent)}
          iconColor={r.running ? agentColor(r.agent, scheme) : undefined}
          hue={hueOf(r.key, r.paneId, r.sessionId)}
          expanded={expanded.has(r.key)}
          onToggle={() => toggle(r.key)}
          onOpen={() => open(t)}
          title={`${r.running ? (r.paneId ? "Go to its pane" : "Runs outside a pane") : (why ?? "Resume it beside its pane (asks first)")}\n${agentInfo(r.agent).label} · ${r.sessionId}${cwd ? `\n${cwd}` : ""}`}
          blocked={!!why}
          sub={
            <>
              {/* The folder opens a terminal there (in this pane's shell context: WSL). */}
              {cwd ? (
                <button
                  className="folder-link"
                  title={`Open a terminal here — ${cwd}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    openFolder(cwd, r.paneId || undefined)
                  }}
                  onKeyDown={(e) => e.stopPropagation()}
                >
                  {shortCwd(cwd, home)}
                </button>
              ) : (
                "—"
              )}
              {(why ?? notes[r.sessionId]) && (
                <span className="status-faint"> · {why ?? notes[r.sessionId]}</span>
              )}
            </>
          }
          right={
            <>
              <span
                className={`status-faint${node?.status === "waiting" ? " agent-line-wait" : ""}`}
              >
                {word}
              </span>
              {node?.tokens && (node.tokens.context > 0 || node.tokens.output > 0) && (
                <span className="tree-tokens" title={tokenBreakdown(node.tokens)}>
                  ↑{formatTokens(node.tokens.context)} ↓{formatTokens(node.tokens.output)}
                </span>
              )}
              {r.past && <span className="status-faint">{ago(r.past.updatedAt)}</span>}
            </>
          }
        >
          <SessionInfo
            agent={r.agent}
            sessionId={r.sessionId}
            folder={cwd}
            // The agent's own folder's branch (it may work in a worktree), else its pane's.
            branch={git?.branch}
            pr={git?.pr}
            paneId={r.paneId}
            showId
          />
          {!r.running && r.past?.firstPrompt && (
            <div className="agent-line-prompt status-faint">{r.past.firstPrompt}</div>
          )}
          {node && (
            <AgentTree
              graph={graph}
              root={node}
              onFocusPane={r.paneId ? () => goTo(r.paneId) : undefined}
              onOpen={(c) => openFolder(c, r.paneId || undefined)}
            />
          )}
          {isLead && procPanes.has(r.paneId) && (
            <AgentProcesses
              paneId={r.paneId}
              open={openProcs.has(r.paneId)}
              onToggle={() => toggleProcs(r.paneId)}
              result={procsResult}
            />
          )}
        </SessionLine>
      </div>
    )
  }

  const groupLabel = (g: ActiveGroup) => {
    const tab = g.tabId ? tabs.find((x) => x.id === g.tabId) : undefined
    return tab ? tabTitle(tab, terminals, home) : "Elsewhere"
  }
  // The shell of the group's focused terminal, as the sidebar shows it.
  const groupShell = (tabId: string) => {
    const tab = tabs.find((x) => x.id === tabId)
    const t = tab ? terminals[tab.activeSessionId] : undefined
    return t ? shellType(t.command) : undefined
  }
  const nothing = !search && list.groups.length === 0 && inactive.length === 0

  return (
    <>
      {listed && (
        <>
          <div className="sessions-search">
            <input
              type="search"
              placeholder="Search conversations…"
              aria-label="Search conversations"
              value={query}
              maxLength={MAX_QUERY}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.stopPropagation()
                  setQuery("")
                }
              }}
              spellCheck={false}
            />
            <button
              className="iconbtn"
              style={{ width: 24, height: 24, flex: "none" }}
              title="Refresh"
              onClick={load}
              disabled={loading}
            >
              <ArrowClockwise size={13} />
            </button>
          </div>
          <div className="sessions-filters">
            {withHistory.map((k) => {
              const Icon = agentIcon(k)
              return (
                <button
                  key={k}
                  className={`pr-tab${hidden.has(k) ? "" : " on"}`}
                  aria-pressed={!hidden.has(k)}
                  title={`${hidden.has(k) ? "Show" : "Hide"} ${agentInfo(k).label} sessions`}
                  onClick={() => toggleAgent(k)}
                >
                  <Icon size={12} color={hidden.has(k) ? undefined : agentColor(k, scheme)} />{" "}
                  {agentInfo(k).label}
                </button>
              )
            })}
            <label
              className="pr-closed"
              title="Only sessions in the focused terminal's folder or below"
            >
              <input type="checkbox" checked={here} onChange={toggleHere} disabled={!activeCwd} />
              This folder
            </label>
          </div>
        </>
      )}
      <div className="diff-files agents-files">
        {search ? (
          <>
            <div className="diff-empty status-faint" aria-live="polite">
              {searchStatus(search, shown.length)}
            </div>
            {searchRows}
          </>
        ) : (
          <>
            {nothing && (
              <div className="diff-empty status-faint">
                <AgentsIcon size={16} />{" "}
                {enabled.length === 0 ? (
                  "Agents are switched off in Settings."
                ) : enabled.every((k) => hidden.has(k)) ? (
                  "Every agent is hidden: turn one on above."
                ) : here ? (
                  "No sessions in this folder."
                ) : (
                  <>
                    No agents yet — run{" "}
                    {enabled.map((k, i) => (
                      <span key={k}>
                        {i > 0 && (i === enabled.length - 1 ? " or " : ", ")}
                        <code>{agentInfo(k).command}</code>
                      </span>
                    ))}{" "}
                    in a new terminal.
                  </>
                )}
              </div>
            )}
            {list.groups.map((g) => (
              <div key={g.id} className={`agents-group${g.current ? " current" : ""}`}>
                <div
                  className="agents-pane-label agents-group-label"
                  role={g.tabId ? "button" : undefined}
                  title={g.tabId ? "Go to this group" : "Sessions the board knows outside a pane"}
                  onMouseDown={
                    g.tabId
                      ? () => {
                          const tab = useStore.getState().tabs.find((x) => x.id === g.tabId)
                          if (tab) goTo(tab.activeSessionId)
                        }
                      : undefined
                  }
                >
                  {/* As the sidebar and the top bar name it (a rename shows in all three). */}
                  <span className="agents-group-name">{groupLabel(g)}</span>
                  {g.tabId && groupShell(g.tabId) && (
                    <span className="pane-badge">{groupShell(g.tabId)}</span>
                  )}
                  <span className="agents-group-count">
                    {g.rows.length} {g.rows.length === 1 ? "agent" : "agents"}
                  </span>
                </div>
                {g.rows.map(activeLine)}
              </div>
            ))}
            <LeftRunning
              result={procsResult}
              label={(paneId) =>
                terminals[paneId] ? displaySessionTitle(terminals[paneId]!, home) : "A closed pane"
              }
            />
            {listed && !result && (
              <div className="diff-empty status-faint">Reading past sessions…</div>
            )}
            {inactive.length > 0 && (
              <div className="agents-group agents-inactive">
                <div className="agents-pane-label agents-group-label">
                  <span className="agents-group-name">Inactive</span>
                  <span className="agents-group-count">{inactive.length}</span>
                </div>
                {inactiveRows}
                {inactive.length > shownInactive && (
                  <button
                    className="agents-more status-faint"
                    onClick={() => setShownInactive((n) => n + INACTIVE_PAGE)}
                  >
                    Show {Math.min(INACTIVE_PAGE, inactive.length - shownInactive)} more of{" "}
                    {inactive.length - shownInactive}
                  </button>
                )}
              </div>
            )}
          </>
        )}
        {result && result.failed.length > 0 && (
          <div className="diff-empty status-faint">
            Couldn't read {result.failed.map((k) => agentInfo(k).label).join(" and ")} sessions.
          </div>
        )}
      </div>
      {ask && (
        <ResumeDialog
          ask={{
            label: ask.target.label,
            agent: ask.target.agent,
            folder: shortCwd(ask.target.cwd, home) || undefined,
            where: ask.target.paneId ? "its-pane" : "here",
            busy: ask.busy,
          }}
          onResume={() => void resume(ask.target, !!ask.busy)}
          onCancel={() => setAsk(null)}
        />
      )}
    </>
  )
}

/** What a session is, at the top of its expanded line: agent, branch and PR, folder, id. */
function SessionInfo({
  agent,
  sessionId,
  folder,
  branch,
  pr,
  paneId,
  showId,
}: {
  agent: AgentKind
  sessionId: string
  folder?: string // the full path (the line shows it short)
  branch?: string
  pr?: PrInfo
  paneId?: string // its PR opens in the pull requests dialog with this pane's gh (WSL too)
  showId?: boolean // the line has no copy-id button of its own (sessions in a pane)
}) {
  return (
    <div className="agent-line-info status-faint">
      <span className="agent-line-info-row">
        {agentInfo(agent).label}
        {branch && (
          <>
            {" · "}
            <GitBranch size={10} /> {branch}
          </>
        )}
        {pr && (
          <>
            {" · "}
            <PrLink pr={pr} paneId={paneId} />
          </>
        )}
        {showId && (
          <>
            {" · "}
            <CopyId id={sessionId} />
          </>
        )}
      </span>
      {folder && (
        <span className="agent-line-info-row agent-line-path" title={folder}>
          {folder}
        </span>
      )}
    </div>
  )
}

/** A branch's PR, as the sidebar shows it: its state's icon and word; opens the PR dialog. */
function PrLink({ pr, paneId }: { pr: PrInfo; paneId?: string }) {
  const ui = prStateUi(pr.state)
  const Icon = pr.state === "merged" ? GitMerge : GitPullRequest
  return (
    <>
      <Icon size={10} color={`var(--${ui.color})`} />
      <button
        className="folder-link"
        title={`${pr.url}: show it in the pull requests dialog`}
        onClick={(e) => {
          e.stopPropagation()
          openLink(pr.url, paneId)
        }}
      >
        PR #{pr.number}
      </button>
      <span style={{ color: `var(--${ui.color})` }}>{ui.word}</span>
    </>
  )
}

/** The session id, shortened, with a copy button. */
function CopyId({ id }: { id: string }) {
  return (
    <button
      className="iconbtn past-session-id"
      title={`Copy the session id (${id})`}
      onClick={(e) => {
        e.stopPropagation()
        void navigator.clipboard?.writeText(id)
      }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {id.slice(0, 8)} <Copy size={10} />
    </button>
  )
}
