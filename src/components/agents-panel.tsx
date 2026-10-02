import { X, TreeStructure, GitBranch } from "@phosphor-icons/react"
import { isInside, samePath } from "../lib/agent-dirs"
import { useStore } from "../store"
import { TerminalManager } from "../terminal/terminal-manager"
import { displaySessionTitle } from "../lib/session-label"
import { formatTokens, tokenBreakdown } from "../lib/tokens"
import type { AgentNode, AgentStatus } from "../lib/agent-graph"
import { agentInfo, agentsOn } from "../lib/agent-kinds"
import { agentIcon } from "./agent-icon"

/** The session's agent as a small icon (titled with its name) on the pane label. */
function AgentKindIcon({ node }: { node: AgentNode }) {
  const Icon = agentIcon(node.agent)
  return (
    <span title={agentInfo(node.agent).label} style={{ display: "inline-flex" }}>
      <Icon size={12} />
    </span>
  )
}

// AgentStatus → dot class (reusing App.css .dot.*) + a short word.
const DOT: Record<AgentStatus, { cls: string; word: string }> = {
  working: { cls: "accent pulse", word: "working" },
  waiting: { cls: "amber", word: "needs input" },
  idle: { cls: "faint", word: "idle" },
  done: { cls: "blue", word: "done" },
}

const base = (p?: string) => (p ? (p.replace(/\/+$/, "").split(/[\\/]/).pop() ?? p) : "")

// Tree connector class for a row hanging off the spine: every child carries a through-line
// except the last, which ends the spine with an elbow only. Shared by sub-agents + worktrees.
const treeChildClass = (isLast: boolean) => `tree-child${isLast ? "" : " through"}`

function AgentRow({
  node,
  depth,
  rootCwd,
  onFocusPane,
  onOpen,
  spine,
  connect,
}: {
  node: AgentNode
  depth: number
  rootCwd?: string // the session root's cwd, so a sub-agent only shows its folder when it differs
  onFocusPane?: () => void
  onOpen: (cwd: string) => void
  spine?: boolean // root with children → drop the tree spine down to the first child
  connect?: "through" | "end" // child row: draw the elbow (+ through-line unless it's the last)
}) {
  const d = DOT[node.status]
  const isRoot = node.agentType === "root"
  const primary = isRoot ? "session" : node.agentType
  const cls =
    "diff-file" +
    (spine ? " tree-parent" : "") +
    (connect ? ` ${treeChildClass(connect === "end")}` : "")
  // The folder this row's subline represents (clickable → open a terminal there). Root: its
  // cwd. Sub-agent: only when its cwd differs from the root (e.g. a worktree) — otherwise the
  // subline keeps the more useful recent-file / last-message signal (the root's folder, shown
  // right above, already covers the shared cwd).
  const folderLink = isRoot ? node.cwd : node.cwd && node.cwd !== rootCwd ? node.cwd : undefined
  const sub = folderLink
    ? base(folderLink)
    : (node.recentFiles[0] ? base(node.recentFiles[0]) : node.lastMessage?.slice(0, 40)) || "—"
  return (
    <div
      className={cls}
      style={{ paddingLeft: 10 + depth * 16, cursor: onFocusPane ? "pointer" : undefined }}
      onMouseDown={onFocusPane}
      title={onFocusPane ? "Go to this pane" : undefined}
    >
      <span className={`dot ${d.cls}`} />
      <div className="tree-labels">
        <span className="tree-primary">
          {primary}
          {node.currentTool && <span className="status-faint"> · {node.currentTool}</span>}
        </span>
        {folderLink ? (
          // The folder is the affordance: a real button (keyboard-focusable) styled as
          // inline text — hover/focus underlines it, click/Enter opens a terminal there.
          <button
            className="tree-sub folder-link"
            title={`Open a terminal here — ${folderLink}`}
            onMouseDown={(e) => e.stopPropagation()} // don't also focus the source pane
            onClick={() => onOpen(folderLink)}
          >
            {sub}
          </button>
        ) : (
          <span className="tree-sub">{sub}</span>
        )}
      </div>
      <div className="tree-right">
        <span className="status-faint">{d.word}</span>
        {node.tokens && (node.tokens.context > 0 || node.tokens.output > 0) && (
          <span className="tree-tokens" title={tokenBreakdown(node.tokens)}>
            ↑{formatTokens(node.tokens.context)} ↓{formatTokens(node.tokens.output)}
          </span>
        )}
      </div>
    </div>
  )
}

/** Right-side board of live coding agents/sub-agents across all tabs & panes (M6). */
export function AgentsPanel() {
  const agents = useStore((s) => s.agents)
  const switches = useStore((s) => s.settings.agents)
  const platform = useStore((s) => s.platform)
  const enabledAgents = agentsOn(platform).filter((k) => switches[k].enabled)
  const sessions = useStore((s) => s.sessions)
  const home = useStore((s) => s.home)
  // The pane the user is currently in — used to box the matching session's agents.
  const activePaneId = useStore((s) => s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId)
  const close = () => useStore.getState().setRightView(null)

  // Bring the pane that owns this session to the front (switch tab + focus terminal).
  const focusPane = (paneId?: string) => {
    if (!paneId || !sessions[paneId]) return
    useStore.getState().focusSession(paneId)
    TerminalManager.focus(paneId)
  }
  // Open a folder (agent cwd / worktree) as a split beside the active pane; the shell
  // context comes from the session's own pane (paneId) so a WSL agent's path opens in WSL.
  const openHere = (cwd: string, paneId?: string) =>
    useStore.getState().openFolderInSplit(cwd, paneId)

  const nodes = Object.values(agents.nodes)
  const working = nodes.filter((n) => n.status === "working").length

  return (
    <div className="diffpanel">
      <div className="diffpanel-header">
        <span className="section-label">Agents</span>
        <span className="diff-summary status-faint">
          {agents.rootIds.length} session{agents.rootIds.length === 1 ? "" : "s"} · {working}{" "}
          working
        </span>
        <button className="iconbtn" style={{ width: 22, height: 22 }} title="Close" onClick={close}>
          <X size={13} />
        </button>
      </div>

      <div className="diff-files agents-files">
        {agents.rootIds.length === 0 && (
          <div className="diff-empty status-faint">
            <TreeStructure size={16} />
            {enabledAgents.length === 0 ? (
              " Agents are switched off in Settings."
            ) : (
              <>
                {" "}
                No agents yet — run{" "}
                {enabledAgents.map((k, i) => (
                  <span key={k}>
                    {i > 0 && (i === enabledAgents.length - 1 ? " or " : ", ")}
                    <code>{agentInfo(k).command}</code>
                  </span>
                ))}{" "}
                in a new terminal.
              </>
            )}
          </div>
        )}
        {agents.rootIds.map((rid) => {
          const root = agents.nodes[rid]
          if (!root) return null
          // Header line naming the pane this session runs in (click → jump there).
          const paneSession = root.paneId ? sessions[root.paneId] : undefined
          const paneLabel = paneSession ? displaySessionTitle(paneSession, home) : "external"
          const go = paneSession ? () => focusPane(root.paneId) : undefined
          // Every folder opened from this session uses the session's own pane shell context.
          const openForSession = (cwd: string) => openHere(cwd, root.paneId)
          // Tree connectors: children then worktrees hang off the root. Only the very last
          // row ends the spine (rounded elbow, no through-line).
          const childNodes = root.childIds
            .map((cid) => agents.nodes[cid])
            .filter((c): c is AgentNode => !!c)
          const wts = root.worktrees ?? []
          // The worktree the agent is in: the deepest containing its cwd (worktrees can nest).
          const inWt = wts
            .filter((w) => root.cwd && (samePath(root.cwd, w.path) || isInside(root.cwd, w.path)))
            .sort((a, b) => b.path.length - a.path.length)[0]?.path
          const hasKids = childNodes.length > 0 || wts.length > 0
          const lastChildIdx = wts.length ? -1 : childNodes.length - 1
          const active = !!root.paneId && root.paneId === activePaneId
          return (
            <div
              key={rid}
              className={`agent-session${active ? " active" : ""}`}
              title={active ? "The pane you're in" : undefined}
            >
              <div
                className="agents-pane-label status-faint"
                onMouseDown={go}
                style={{ cursor: go ? "pointer" : undefined }}
              >
                <AgentKindIcon node={root} /> {paneLabel}
              </div>
              <AgentRow
                node={root}
                depth={0}
                onFocusPane={go}
                onOpen={openForSession}
                spine={hasKids}
              />
              {childNodes.map((child, i) => (
                <AgentRow
                  key={child.id}
                  node={child}
                  depth={1}
                  rootCwd={root.cwd}
                  onFocusPane={go}
                  onOpen={openForSession}
                  connect={i === lastChildIdx ? "end" : "through"}
                />
              ))}
              {wts.map((w, j) => (
                <div
                  key={w.path}
                  className={`diff-file agent-worktree ${treeChildClass(j === wts.length - 1)}`}
                  style={{ paddingLeft: 26 }}
                >
                  <GitBranch size={12} color="var(--blue)" />
                  <div className="tree-labels">
                    <span className="tree-primary">
                      {w.branch ?? base(w.path)}
                      {/* The agent works in this one now — the sidebar's `in` line. */}
                      {w.path === inWt && <span className="status-faint"> · in</span>}
                    </span>
                    <button
                      className="tree-sub folder-link"
                      title={`Open a terminal here — ${w.path}`}
                      onClick={() => openForSession(w.path)}
                    >
                      {base(w.path)}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
}
