import type { CSSProperties } from "react"
import { PAST_SESSIONS, type AgentCard, type Status } from "./data"
import { AgentMark, Ph, type AgentKind } from "./icons"

const LABEL: Record<AgentKind, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" }

/** The words the app's agents panel uses for a session's state. */
const STATE: Record<Status, string> = {
  running: "working",
  waiting: "needs input",
  done: "idle",
  idle: "idle",
}

/** The Agents panel, as in the app: a conversation search with agent filters, sessions grouped
 *  like the sidebar and tinted by session colour, one opened (branch, id, sub-agents, processes),
 *  and, while searching, the past sessions that match. */
export function AgentsPanel({
  agents,
  searching,
  inline = false,
}: {
  agents: AgentCard[]
  searching: boolean
  inline?: boolean // phones: drawn inside the turn instead of as the right panel
}) {
  return (
    <aside className={inline ? "mm-ag-inline" : "mm-right"} aria-hidden="true">
      <div className="mm-side-head">
        <span className="mm-label">AGENTS</span>
        <Ph name="x" size={14} className="c-muted" />
      </div>
      <div className="mm-ag-tools">
        <div className="mm-ag-search">
          {searching ? (
            <span className="a-type" style={{ animationDelay: "0.4s" }}>
              rate limit
            </span>
          ) : (
            <span className="c-subtle">Search conversations…</span>
          )}
          <span className="mm-grow" />
          <Ph name="arrow-clockwise" size={13} className="c-muted" />
        </div>
        <div className="mm-ag-filters">
          <span>
            <AgentMark kind="claude" size={12} className="mm-mark-claude" />
            Claude
          </span>
          <span>
            <AgentMark kind="codex" size={12} className="mm-mark-codex" />
            Codex
          </span>
          <span>
            <AgentMark kind="opencode" size={12} className="mm-mark-opencode" />
            OpenCode
          </span>
          <span>
            <Ph name="square" size={13} className="c-muted" />
            This folder
          </span>
        </div>
      </div>
      <div className="mm-ag-list">
        {agents.map((a) => (
          <div key={a.group} className="mm-ag-group">
            <div className="mm-ag-group-head">
              <b>{a.group}</b>
              <span className="mm-badge">ZSH</span>
              <span className="mm-grow" />
              <span className="c-subtle mm-small">1 agent</span>
            </div>
            <div
              className="mm-ag-card"
              data-open={!!a.detail && searching}
              style={{ "--tint": `var(--cc-${a.color})` } as CSSProperties}
            >
              <div className="mm-ag-row">
                <AgentMark kind={a.agent} size={13} className={`mm-mark-${a.agent}`} />
                <div className="mm-ag-labels">
                  <b className="mm-ellipsis">{a.name}</b>
                  <span className="c-subtle mm-small">{a.cwd}</span>
                </div>
                <div className="mm-ag-right">
                  <span className="mm-st" data-s={a.status}>
                    {STATE[a.status]}
                  </span>
                  <span className="c-subtle mm-small">{a.ago}</span>
                </div>
              </div>
              {a.detail && searching && (
                <div className="mm-ag-detail a-in">
                  <div className="mm-ag-meta">
                    <span>{LABEL[a.agent]}</span>
                    <span className="c-subtle">·</span>
                    <Ph name="git-branch" size={12} />
                    <span>{a.detail.branch}</span>
                    <span className="c-subtle">·</span>
                    <span>{a.detail.id}</span>
                  </div>
                  <div className="mm-tree-row mm-tree-parent">
                    <span className="mm-dot" data-s={a.status} />
                    <div className="mm-tree-labels">
                      <b>session</b>
                      <span className="c-subtle mm-small">{a.group}</span>
                    </div>
                    <div className="mm-tree-right">
                      <span className="mm-st" data-s={a.status}>
                        {STATE[a.status]}
                      </span>
                      <span className="c-subtle mm-small">{a.tokens}</span>
                    </div>
                  </div>
                  {a.kids.map((k) => (
                    <div key={k.kind} className="mm-tree-row mm-tree-child through">
                      <span className="mm-dot" data-s="running" />
                      <div className="mm-tree-labels">
                        <b>{k.kind}</b>
                        <span className="c-subtle mm-small">{k.what}</span>
                      </div>
                      <div className="mm-tree-right">
                        <span className="mm-st" data-s="running">
                          working
                        </span>
                      </div>
                    </div>
                  ))}
                  <div className="mm-tree-row mm-tree-child">
                    <span className="mm-dot mm-dot-msg" />
                    <div className="mm-tree-labels">
                      <span className="c-muted mm-ellipsis">{a.last}</span>
                    </div>
                  </div>
                  <div className="mm-ag-procs">
                    <span className="c-muted mm-small">
                      ⌄ {a.detail.processes.length} process
                      {a.detail.processes.length > 1 ? "es" : ""}
                    </span>
                    {a.detail.processes.map((p) => (
                      <div key={p.cmd} className="mm-ag-proc">
                        <span className="mm-grow mm-ellipsis">{p.cmd}</span>
                        <span className="c-subtle">{p.cpu}</span>
                        <span className="c-subtle">{p.mem}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
        {searching && (
          <div className="mm-ag-past a-in" style={{ animationDelay: "1.4s" }}>
            <div className="mm-ag-group-head">
              <b>past sessions</b>
              <span className="mm-grow" />
              <span className="c-subtle mm-small">{PAST_SESSIONS.length} matches</span>
            </div>
            {PAST_SESSIONS.map((p) => (
              <div key={p.name} className="mm-ag-card mm-ag-card-past">
                <div className="mm-ag-row">
                  <AgentMark kind={p.agent} size={13} className={`mm-mark-${p.agent}`} />
                  <div className="mm-ag-labels">
                    <b className="mm-ellipsis">{p.name}</b>
                    <span className="c-subtle mm-small">
                      {p.cwd} · {p.ago}
                    </span>
                  </div>
                  <span className="mm-chip">resume</span>
                </div>
                <div className="mm-ag-hit c-muted">
                  {p.hit[0]}
                  <mark>{p.hit[1]}</mark>
                  {p.hit[2]}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
