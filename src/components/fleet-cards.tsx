// The Fleet view's cards and side panel (docs/design/FLEET_GRAPH.md, "Cards", "Side panel"): what
// each node and the selection show. Placement and motion stay in fleet-view.tsx.
import { ArrowSquareOut, GitBranch, GitPullRequest } from "@phosphor-icons/react"
import { useStore, activeTheme } from "../store"
import { type FleetNode } from "../lib/fleet-layout"
import { DETACHED, type FleetAgent, type FleetPr, type FleetRepo } from "../lib/fleet-model"
import { cardLook } from "../lib/pr-graph"
import { AGENT_STATUS_UI } from "../lib/agent-status-ui"
import { agentColor, agentInfo } from "../lib/agent-kinds"
import type { AgentKind } from "../lib/agent-graph"
import { agentIcon } from "./agent-icon"
import { ipc } from "../lib/ipc"
import { TerminalManager } from "../terminal/terminal-manager"

export type Selection = { kind: "repo"; key: string } | { kind: "agent"; id: string } | null

/** What a node stands for: its repo and, by kind, its PR, branch, agent or sub-agent. */
export interface NodeInfo {
  repo: FleetRepo
  pr?: FleetPr
  agent?: FleetAgent
  branch?: string
  sub?: FleetAgent["subs"][number]
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`
const shortName = (label: string) => (label.split("/").pop() ?? label).toUpperCase()

/** What a PR card says under its title, and its tone. */
function prStatus(p: FleetPr): { word: string; cls: string } {
  if (!p.row) return { word: p.state === "draft" ? "draft" : "open", cls: "" }
  const look = cardLook(p.row)
  const word =
    p.row.merge === "conflicts"
      ? "conflicts"
      : p.row.ci === "failure"
        ? "CI failing"
        : p.row.review === "changes"
          ? "changes requested"
          : p.row.ci === "pending"
            ? "CI running"
            : look.approved
              ? "✓ approved"
              : look.draft
                ? "draft"
                : "ready"
  return { word, cls: look.tone ?? (look.approved ? "ok" : "") }
}

const agentName = (a: FleetAgent) => a.name || agentInfo(a.kind).label
const agentDoing = (a: FleetAgent) =>
  a.status === "waiting"
    ? "needs you"
    : a.status === "working"
      ? a.currentTool
        ? `running ${a.currentTool}`
        : "working"
      : AGENT_STATUS_UI[a.status].word

/** The class a status's word takes (no dot: the agent's icon says which agent it is). */
const statusTone = (status: FleetAgent["status"]) =>
  status === "working" ? "ok" : status === "waiting" ? "warn" : status === "done" ? "done" : "dim"

const goToPane = (paneId: string) => {
  useStore.getState().focusSession(paneId)
  requestAnimationFrame(() => TerminalManager.focus(paneId))
}

export function RepoCounts({ repo }: { repo: FleetRepo }) {
  const { working, waiting } = repo.counts
  return (
    <span className="fleet-counts">
      {working > 0 && <span className="ok">● {working} working</span>}
      {waiting > 0 && <span className="warn">● {waiting} need you</span>}
      {!working && !waiting && <span>{plural(repo.counts.agents, "agent")}</span>}
    </span>
  )
}

/** An agent's icon in its own colour (Claude terracotta, Codex blue, OpenCode the text's). */
function AgentMark({ kind, size }: { kind: AgentKind; size: number }) {
  const scheme = useStore((s) => activeTheme(s).scheme)
  const Icon = agentIcon(kind)
  return <Icon size={size} color={agentColor(kind, scheme)} />
}

export function FleetCard(props: {
  node: FleetNode
  info: NodeInfo | undefined
  open: boolean
  selected: boolean
  onRoot: (key: string) => void
  onAgent: (id: string) => void
}) {
  const { node: n, info, open, selected } = props
  if (!info) return null
  const style = { left: n.x - n.w / 2, top: n.y - n.h / 2, width: n.w, height: n.h }
  if (n.kind === "root") {
    const r = info.repo
    return (
      <>
        <button
          className={`fleet-root${open ? " open" : ""}${selected ? " sel" : ""}`}
          style={style}
          data-node={n.id}
          aria-label={`${open ? "Close" : "Open"} ${r.label}`}
          aria-expanded={open}
          onClick={() => props.onRoot(r.key)}
        >
          {shortName(r.label).slice(0, 10)}
        </button>
        {!open && (
          <div className="fleet-root-label" style={{ left: n.x - 120, top: n.y + n.h / 2 + 12 }}>
            <span className="one">
              {r.label}
              {r.defaultBranch && <span className="faint"> ⑂ {r.defaultBranch}</span>}
            </span>
            <span className="one faint">
              {plural(r.counts.prs, "PR")} · {plural(r.counts.agents, "agent")}
            </span>
            <RepoCounts repo={r} />
          </div>
        )}
      </>
    )
  }
  if (n.kind === "pr" && info.pr) {
    const p = info.pr
    const st = prStatus(p)
    return (
      <div
        className={`fleet-card fleet-pr${st.cls === "ok" ? "" : ` ${st.cls}`}${p.state === "draft" ? " draft" : ""}`}
        style={style}
        data-node={n.id}
      >
        <span className="one">
          <span className={`fleet-pr-icon${p.state === "draft" ? " draft" : ""}`}>
            <GitPullRequest size={13} weight="bold" />
          </span>{" "}
          <span className="faint">#{p.number}</span> <b>{p.row?.title ?? ""}</b>
        </span>
        <span className={`one fleet-st ${st.cls}`}>{st.word}</span>
        <button
          className="fleet-link"
          title="Open on GitHub"
          aria-label={`Open #${p.number} on GitHub`}
          onClick={() => ipc.openExternal(p.url)}
        >
          <ArrowSquareOut size={11} />
        </button>
      </div>
    )
  }
  if (n.kind === "branch") {
    return (
      <div className="fleet-card fleet-branch" style={style} data-node={n.id}>
        <GitBranch size={12} />
        <span className="one">
          {info.branch === DETACHED ? "detached HEAD" : info.branch}{" "}
          <span className="faint">· no PR</span>
        </span>
      </div>
    )
  }
  if (n.kind === "sub" && info.sub) {
    const st = AGENT_STATUS_UI[info.sub.status]
    return (
      <div className="fleet-card fleet-sub" style={style} data-node={n.id}>
        <span className="fleet-kind">
          <AgentMark kind={info.agent?.kind ?? "claude"} size={12} />
        </span>
        <span className="one">
          {info.sub.type} <span className={statusTone(info.sub.status)}>· {st.word}</span>
        </span>
      </div>
    )
  }
  if (n.kind === "agent" && info.agent) {
    const a = info.agent
    const st = AGENT_STATUS_UI[a.status]
    return (
      <button
        className={`fleet-card fleet-agent ${a.status}${selected ? " sel" : ""}`}
        style={style}
        data-node={n.id}
        aria-label={`${agentInfo(a.kind).label} agent ${agentName(a)}, ${st.word}`}
        onClick={() => props.onAgent(a.id)}
        onDoubleClick={() => goToPane(a.paneId)}
      >
        <span className="one">
          <span className="fleet-kind">
            <AgentMark kind={a.kind} size={13} />
          </span>{" "}
          <b>{agentName(a)}</b>{" "}
          <span className="faint">· {a.subs.length ? plural(a.subs.length, "sub") : st.word}</span>
        </span>
        <span className={`one ${statusTone(a.status)}`}>{agentDoing(a)}</span>
      </button>
    )
  }
  return null
}

export function FleetPanel(props: {
  repos: FleetRepo[]
  open: FleetRepo | null
  sel: Selection
  agentOf: (id: string) => NodeInfo | undefined
  onRepo: (key: string) => void
  onAgent: (id: string) => void
  onAll: () => void
}) {
  const { repos, sel } = props
  const agent = sel?.kind === "agent" ? props.agentOf(sel.id) : undefined
  const repo =
    sel?.kind === "repo"
      ? repos.find((r) => r.key === sel.key)
      : (agent?.repo ?? props.open ?? undefined)

  if (agent?.agent) {
    const a = agent.agent
    const pr = agent.repo.prs.find((p) => p.agents.some((x) => x.id === a.id))
    const ctx = a.tokens?.window ? Math.round((a.tokens.context / a.tokens.window) * 100) : null
    return (
      <aside className="fleet-panel" aria-label="Agent">
        <button className="fleet-back" onClick={() => props.onRepo(agent.repo.key)}>
          ← {agent.repo.label}
          {pr ? ` › #${pr.number}` : ""}
        </button>
        <h2 className="one">{agentName(a)}</h2>
        <div className="fleet-panel-row">
          <span className="fleet-kind">
            <AgentMark kind={a.kind} size={13} />
          </span>
          {agentInfo(a.kind).label} · <span className={statusTone(a.status)}>{agentDoing(a)}</span>
        </div>
        <button className="btn primary" onClick={() => goToPane(a.paneId)}>
          Go to pane
        </button>
        <dl className="fleet-facts">
          <dt>PR</dt>
          <dd className="one">{pr ? `#${pr.number} ${pr.row?.title ?? ""}` : "none"}</dd>
          <dt>branch</dt>
          <dd className="one">{a.branch ?? "—"}</dd>
          {a.cwd && (
            <>
              <dt>cwd</dt>
              <dd className="one">{a.cwd}</dd>
            </>
          )}
          {a.tokens && (
            <>
              <dt>context</dt>
              <dd>
                {Math.round(a.tokens.context / 1000)}k
                {a.tokens.window ? ` / ${Math.round(a.tokens.window / 1000)}k` : ""}
                {ctx !== null && (
                  <span className="fleet-meter">
                    <span
                      style={{ width: `${Math.min(100, ctx)}%` }}
                      className={ctx > 80 ? "warn" : ""}
                    />
                  </span>
                )}
              </dd>
            </>
          )}
        </dl>
        <h3>Sub-agents · {a.subs.length}</h3>
        {a.subs.length ? (
          a.subs.map((s) => (
            <div key={s.id} className="fleet-panel-row">
              {s.type}{" "}
              <span className={statusTone(s.status)}>· {AGENT_STATUS_UI[s.status].word}</span>
            </div>
          ))
        ) : (
          <div className="faint">none</div>
        )}
      </aside>
    )
  }

  if (repo) {
    const agents = [
      ...repo.prs.flatMap((p) => p.agents),
      ...repo.branches.flatMap((b) => b.agents),
      ...repo.agents,
    ]
    return (
      <aside className="fleet-panel" aria-label="Repo">
        <button className="fleet-back" onClick={props.onAll}>
          ← all repos
        </button>
        <h2 className="one">{repo.label}</h2>
        <div className="faint">
          {repo.defaultBranch ? `⑂ ${repo.defaultBranch} · ` : ""}
          {plural(repo.counts.prs, "PR")} · {plural(repo.counts.agents, "agent")}
        </div>
        {repo.repo && (
          <button
            className="btn"
            onClick={() => ipc.openExternal(`https://github.com/${repo.repo}`)}
          >
            Open on GitHub ↗
          </button>
        )}
        <h3>Pull requests</h3>
        {repo.prs.length ? (
          repo.prs.map((p) => {
            const st = prStatus(p)
            return (
              <div key={p.url} className="fleet-panel-row">
                <span className="faint">#{p.number}</span>{" "}
                <span className="one">{p.row?.title ?? ""}</span>{" "}
                <span className={`fleet-st ${st.cls}`}>{st.word}</span>
              </div>
            )
          })
        ) : (
          <div className="faint">none open</div>
        )}
        <h3>Agent sessions</h3>
        {agents.map((a) => {
          return (
            <button
              key={a.id}
              className="fleet-panel-row fleet-pick"
              onClick={() => props.onAgent(a.id)}
            >
              <AgentMark kind={a.kind} size={13} /> <span className="one">{agentName(a)}</span>{" "}
              <span className="faint">· {agentDoing(a)}</span>
            </button>
          )
        })}
      </aside>
    )
  }

  return (
    <aside className="fleet-panel" aria-label="Repos">
      <h3>Repos · {repos.length}</h3>
      {repos.map((r) => (
        <button key={r.key} className="fleet-repo-row" onClick={() => props.onRepo(r.key)}>
          <b className="one">{r.label}</b>
          <span className="faint">
            {plural(r.counts.prs, "PR")} · {plural(r.counts.agents, "agent")}
          </span>
          <RepoCounts repo={r} />
        </button>
      ))}
      <div className="fleet-hint faint">
        Repos with a live agent session. Open one to see its PRs and the agents on them.
      </div>
    </aside>
  )
}
