import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { ArrowClockwise, Copy } from "@phosphor-icons/react"
import { useStore } from "../store"
import { TerminalManager } from "../terminal/terminal-manager"
import { ipc } from "../lib/ipc"
import { AGENT_KINDS, agentInfo, agentsOn } from "../lib/agent-kinds"
import type { AgentKind } from "../lib/agent-graph"
import { shortCwd } from "../lib/session-label"
import {
  ago,
  filterPast,
  pastLabel,
  paneOf,
  panesFor,
  type PastSession,
  type PastSessionsResult,
} from "../lib/past-sessions"
import { agentIcon } from "./agent-icon"

const HIDDEN_KEY = "minmux.sessions.hidden" // agents switched off by their chip
const HERE_KEY = "minmux.sessions.here"
const CONFIRM_MS = 10_000 // a second click within this resumes a session that may be running

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

/** Past agent sessions: click a running one to go to its pane, another to resume it in a split. */
export function AgentSessionsTab() {
  const home = useStore((s) => s.home)
  const platform = useStore((s) => s.platform)
  const switches = useStore((s) => s.settings.agents)
  const activeCwd = useStore((s) => {
    const id = s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId
    return id ? s.sessions[id]?.cwd : undefined
  })
  const [result, setResult] = useState<PastSessionsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [hidden, setHidden] = useState(readHidden)
  const [here, setHere] = useState(readHere)
  const [notes, setNotes] = useState<Record<string, string>>({}) // per row: why it didn't resume
  const opening = useRef(new Set<string>()) // rows whose resume plan is being asked for
  const armed = useRef(new Map<string, number>()) // rows clicked once while maybe running

  const enabled = agentsOn(platform).filter((k) => switches[k].enabled && AGENT_KINDS[k].history)
  const load = useCallback(() => {
    setLoading(true)
    void ipc
      .pastSessions()
      .then(setResult)
      .catch(() => setResult({ sessions: [], failed: [] }))
      .finally(() => setLoading(false))
  }, [])
  useEffect(load, [load])

  const shownKey = enabled.filter((k) => !hidden.has(k)).join(",")
  const rows = useMemo(
    () =>
      result
        ? filterPast(
            result.sessions,
            new Set(shownKey.split(",") as AgentKind[]),
            here ? activeCwd : undefined,
          )
        : [],
    [result, shownKey, here, activeCwd],
  )
  // Per row, the terminal it runs in ("" = none): primitives, so an agent's every hook event
  // re-renders the rows only when one of them starts or stops running.
  const panes = useStore(useShallow((s) => panesFor(rows, s.agents, s.sessions, s.resume)))

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
  const note = (s: PastSession, text: string) => setNotes((n) => ({ ...n, [s.sessionId]: text }))

  const open = async (s: PastSession) => {
    const st = useStore.getState()
    const pane = paneOf(s, st.agents, st.sessions, st.resume)
    if (pane) return goTo(pane)
    if (!s.cwd || s.cwdGone || opening.current.has(s.sessionId)) return
    // A second click soon after main said it may be running elsewhere: resume it anyway.
    const at = armed.current.get(s.sessionId)
    const confirmed = !!at && Date.now() - at < CONFIRM_MS
    armed.current.delete(s.sessionId)
    opening.current.add(s.sessionId)
    try {
      const plan = await ipc.resumeOne({ agent: s.agent, sessionId: s.sessionId }, confirmed)
      if (plan?.busy) {
        armed.current.set(s.sessionId, Date.now())
        return note(s, `${plan.reason}: click again to resume`)
      }
      if (!plan || plan.status !== "resume")
        return note(s, plan?.reason ?? "can't be resumed from here (refresh the list)")
      // Started meanwhile (another click, or by hand): go there instead of a second copy.
      const now = useStore.getState()
      const there = paneOf(s, now.agents, now.sessions, now.resume)
      if (there) return goTo(there)
      const id = now.resumeInSplit(plan)
      if (!id) return note(s, "couldn't open a terminal for it here")
      setNotes((n) => {
        const next = { ...n }
        delete next[s.sessionId]
        return next
      })
      TerminalManager.focus(id)
    } catch {
      note(s, "can't be resumed from here")
    } finally {
      opening.current.delete(s.sessionId)
    }
  }

  if (platform === "win32")
    return (
      <div className="diff-empty status-faint">Past sessions aren't listed on Windows yet.</div>
    )

  return (
    <>
      <div className="sessions-filters">
        {enabled.map((k) => {
          const Icon = agentIcon(k)
          return (
            <button
              key={k}
              className={`pr-tab${hidden.has(k) ? "" : " on"}`}
              aria-pressed={!hidden.has(k)}
              title={`${hidden.has(k) ? "Show" : "Hide"} ${agentInfo(k).label} sessions`}
              onClick={() => toggleAgent(k)}
            >
              <Icon size={12} /> {agentInfo(k).label}
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
        <button
          className="iconbtn"
          style={{ width: 22, height: 22, marginLeft: "auto" }}
          title="Refresh"
          onClick={load}
          disabled={loading}
        >
          <ArrowClockwise size={13} />
        </button>
      </div>
      <div className="diff-files agents-files">
        {!result && <div className="diff-empty status-faint">Reading sessions…</div>}
        {result && rows.length === 0 && (
          <div className="diff-empty status-faint">
            {enabled.length === 0
              ? "Agents are switched off in Settings."
              : enabled.every((k) => hidden.has(k))
                ? "Every agent is hidden: turn one on above."
                : here
                  ? "No sessions in this folder."
                  : "No past sessions yet."}
          </div>
        )}
        {rows.map((s, i) => {
          const pane = panes[i] || undefined
          const Icon = agentIcon(s.agent)
          const blocked = !pane && (!s.cwd || s.cwdGone)
          const why = blocked ? (s.cwd ? "folder gone" : "folder unknown") : notes[s.sessionId]
          const action = pane
            ? "Go to its pane"
            : blocked
              ? why
              : "Resume in a split beside this pane"
          return (
            <div
              key={`${s.agent}:${s.sessionId}`}
              className={`diff-file past-session${blocked ? " blocked" : ""}`}
              role="button"
              tabIndex={0}
              aria-disabled={blocked}
              title={`${action}\n${agentInfo(s.agent).label} · ${s.sessionId}${s.cwd ? `\n${s.cwd}` : ""}`}
              onClick={() => void open(s)}
              onKeyDown={(e) => {
                // The row's own keys only (Enter on its copy button must not resume it).
                if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return
                e.preventDefault()
                void open(s)
              }}
            >
              <span className={`dot ${pane ? "accent" : "faint"}`} />
              <div className="tree-labels">
                <span className="tree-primary">
                  <Icon size={11} /> {pastLabel(s)}
                </span>
                <span className="tree-sub">
                  {shortCwd(s.cwd, home) || "—"}
                  {why && <span className="status-faint"> · {why}</span>}
                </span>
              </div>
              <div className="tree-right">
                <span className="status-faint">{ago(s.updatedAt)}</span>
                <button
                  className="iconbtn past-session-id"
                  title={`Copy the session id (${s.sessionId})`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void navigator.clipboard?.writeText(s.sessionId)
                  }}
                >
                  {s.sessionId.slice(0, 8)} <Copy size={10} />
                </button>
              </div>
            </div>
          )
        })}
        {result && result.failed.length > 0 && (
          <div className="diff-empty status-faint">
            Couldn't read {result.failed.map((k) => agentInfo(k).label).join(" and ")} sessions.
          </div>
        )}
      </div>
    </>
  )
}
