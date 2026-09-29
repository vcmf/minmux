// Pure reducer that folds a stream of Claude Code hook events into a live tree of
// agents + their status/cwd/recent-files. The risky logic of M6 lives here, tested
// against real captured hook streams (see agent-graph.test.ts). No I/O, no time —
// the receiver normalises raw hook JSON into AgentEvent and calls reduceAgentEvent.
//
// Correlation model (validated by the 6a spike — see docs/design/AGENT_OBSERVABILITY.md):
//   - root agent  = events with NO agent_id (the session itself)
//   - sub-agent   = events carrying an agent_id (attach to their session's root)
// Two levels (root → sub-agents); deeper nesting needs OTEL's parent_agent_id (6c).
//
// Lifecycle (keeps the board "live", not a growing history): a new turn
// (UserPromptSubmit) drops the previous turn's finished sub-agents, and SessionEnd
// evicts the whole session. So finished agents disappear rather than piling up.

export type AgentStatus = "working" | "waiting" | "idle" | "done"

/** Token usage read from a transcript (see electron/transcript-tokens.ts).
 *  `context` is the LATEST run's input (input + cache read + cache create) = how full the
 *  context window is right now (bounded, ~≤ the model's window). `output` is cumulative
 *  output generated across the session (a monotonic "how much this agent produced"). */
export interface TokenUsage {
  context: number
  output: number
}

/** A hook event normalised down to the fields the graph needs. */
export interface AgentEvent {
  event: string // hook_event_name (SessionStart, PreToolUse, SubagentStart, …)
  sessionId: string
  paneId?: string // the minmux pane (session id) this claude session runs in
  agentId?: string // absent ⇒ the session root; present ⇒ a sub-agent
  agentType?: string // e.g. "Explore", "general-purpose" (sub-agents only)
  cwd?: string
  toolName?: string // tool_name on Pre/PostToolUse
  filePath?: string // extracted from a file tool's input, or a FileChanged path
  message?: string // Notification message / last_assistant_message
  worktreePath?: string // worktree_path on WorktreeCreate/WorktreeRemove
  baseBranch?: string // base_branch on WorktreeCreate
  transcriptPath?: string // transcript_path — the session's JSONL (token accounting)
  agentTranscriptPath?: string // agent_transcript_path — a sub-agent's own JSONL
  tokens?: TokenUsage // synthetic "TokenUsage" event: cumulative usage for the target node
  source?: string // SessionStart: startup | resume | clear | compact | fork
  nested?: boolean // main's verdict: a session launched inside the pane's lead (background agent)
  reason?: string // SessionEnd: prompt_input_exit | logout | clear | resume | other
  permissionMode?: string // permission_mode (default | acceptEdits | plan | bypassPermissions …)
}

/** A git worktree an agent created (WorktreeCreate), for the "open a terminal here" chip. */
export interface Worktree {
  path: string
  branch?: string
}

export interface AgentNode {
  id: string // agent_id, or `root:<sessionId>` for a session root
  sessionId: string
  paneId?: string // the minmux pane this session runs in (roots) — for focus/grouping
  agentType: string // "root" for the session root, else the sub-agent type
  status: AgentStatus
  currentTool?: string // in-flight tool (set on PreToolUse, cleared on PostToolUse)
  cwd?: string
  recentFiles: string[] // most-recent-first, capped
  worktrees?: Worktree[] // worktrees created in this session (WorktreeCreate), root only
  started?: number // root: order of its latest SessionStart — the newest per pane is live
  nested?: boolean // root: launched inside the pane's lead (background agent) — main decides
  lastMessage?: string
  tokens?: TokenUsage // cumulative token usage (session root or sub-agent), off-band via hooks
  parentId?: string // undefined for a root
  childIds: string[] // sub-agents, in order of appearance
}

export interface AgentGraph {
  nodes: Record<string, AgentNode>
  rootIds: string[] // one root per session, in order of first appearance (the board's order)
}

export const emptyGraph: AgentGraph = { nodes: {}, rootIds: [] }

const RECENT_FILES_CAP = 10
const rootId = (sessionId: string) => `root:${sessionId}`

/** Prepend a file, dedupe, cap. No-op when path is absent. */
const withFile = (files: string[], path?: string): string[] =>
  path ? [path, ...files.filter((p) => p !== path)].slice(0, RECENT_FILES_CAP) : files

/** Fold one hook event into the graph, returning a new graph (pure). */
export function reduceAgentEvent(graph: AgentGraph, ev: AgentEvent): AgentGraph {
  // Synthetic token update (main computes it off-band from the transcript): a targeted
  // set on an EXISTING node only — never create/resurrect a node, so a late total for a
  // sub-agent already dropped at end-of-turn is silently ignored.
  if (ev.event === "TokenUsage") {
    const id = ev.agentId ?? rootId(ev.sessionId)
    const node = graph.nodes[id]
    if (!node || !ev.tokens) return graph
    return { ...graph, nodes: { ...graph.nodes, [id]: { ...node, tokens: ev.tokens } } }
  }

  const nodes = { ...graph.nodes }
  let rootIds = graph.rootIds
  const rid = rootId(ev.sessionId)
  // Every id read below is ensured to exist first (root always; sub-agent when
  // agentId is present), so this accessor is safe despite noUncheckedIndexedAccess.
  const at = (id: string) => nodes[id] as AgentNode

  // Every event belongs to a session → ensure that session's root node exists.
  if (!nodes[rid]) {
    nodes[rid] = {
      id: rid,
      sessionId: ev.sessionId,
      paneId: ev.paneId,
      agentType: "root",
      status: "idle",
      cwd: ev.cwd,
      recentFiles: [],
      childIds: [],
    }
    rootIds = [...rootIds, rid]
  }

  // A sub-agent event may arrive before its SubagentStart — create it lazily and
  // attach it to the session root (two-level tree).
  if (ev.agentId && !nodes[ev.agentId]) {
    nodes[ev.agentId] = {
      id: ev.agentId,
      sessionId: ev.sessionId,
      agentType: ev.agentType ?? "agent",
      status: "working",
      cwd: ev.cwd,
      recentFiles: [],
      parentId: rid,
      childIds: [],
    }
    const root = at(rid)
    if (!root.childIds.includes(ev.agentId)) {
      nodes[rid] = { ...root, childIds: [...root.childIds, ev.agentId] }
    }
  }

  // Main decides which session leads the pane (one classifier, shared with resume + accent):
  // a background agent inherits the pane but mustn't take `in` over.
  if (ev.nested !== undefined && !ev.agentId && nodes[rid]?.nested !== ev.nested)
    nodes[rid] = { ...at(rid), nested: ev.nested }

  const targetId = ev.agentId ?? rid
  const set = (id: string, changes: Partial<AgentNode>) => {
    nodes[id] = { ...at(id), ...changes }
  }

  switch (ev.event) {
    case "SessionStart":
      // A (re)start — also in another pane (`claude --resume` after a crash) — makes it its
      // pane's newest session (`started`); the board order (rootIds) never changes.
      set(rid, {
        status: "idle",
        cwd: ev.cwd ?? at(rid).cwd,
        paneId: ev.paneId ?? at(rid).paneId,
        started: Math.max(0, ...rootIds.map((id) => nodes[id]?.started ?? 0)) + 1,
      })
      break
    case "UserPromptSubmit": {
      // New turn: drop the previous turn's FINISHED sub-agents (they're per-turn), so
      // the board shows the current turn, not a growing pile of done ones. Keep any
      // still-active sub-agent. Then mark the session working.
      const root = at(rid)
      const keep = root.childIds.filter((cid) => nodes[cid]?.status !== "done")
      for (const cid of root.childIds) if (nodes[cid]?.status === "done") delete nodes[cid]
      nodes[rid] = { ...root, childIds: keep, status: "working" }
      break
    }
    case "SubagentStart":
      if (ev.agentId)
        set(ev.agentId, {
          agentType: ev.agentType ?? at(ev.agentId).agentType,
          status: "working",
        })
      break
    case "PreToolUse":
      set(targetId, {
        status: "working",
        currentTool: ev.toolName,
        cwd: ev.cwd ?? at(targetId).cwd,
        recentFiles: withFile(at(targetId).recentFiles, ev.filePath),
      })
      break
    case "PostToolUse":
      set(targetId, {
        currentTool: undefined,
        recentFiles: withFile(at(targetId).recentFiles, ev.filePath),
      })
      break
    case "SubagentStop":
      if (ev.agentId)
        set(ev.agentId, {
          status: "done",
          currentTool: undefined,
          lastMessage: ev.message ?? at(ev.agentId).lastMessage,
        })
      break
    case "Stop":
      set(rid, {
        status: "idle",
        currentTool: undefined,
        lastMessage: ev.message ?? at(rid).lastMessage,
      })
      break
    case "Notification":
      set(rid, { status: "waiting", lastMessage: ev.message ?? at(rid).lastMessage })
      break
    case "CwdChanged":
      if (ev.cwd) set(targetId, { cwd: ev.cwd })
      break
    case "FileChanged":
      set(targetId, { recentFiles: withFile(at(targetId).recentFiles, ev.filePath) })
      break
    // Worktrees live on the session root (the board renders root.worktrees), so target
    // `rid` even when the event carries an agent_id — else a sub-agent-context create
    // would hide the worktree, and a remove couldn't clear one held on the root.
    case "WorktreeCreate":
      if (ev.worktreePath) {
        const cur = at(rid).worktrees ?? []
        if (!cur.some((w) => w.path === ev.worktreePath))
          set(rid, { worktrees: [...cur, { path: ev.worktreePath, branch: ev.baseBranch }] })
      }
      break
    case "WorktreeRemove":
      if (ev.worktreePath) {
        const cur = at(rid).worktrees
        if (cur?.some((w) => w.path === ev.worktreePath))
          set(rid, { worktrees: cur.filter((w) => w.path !== ev.worktreePath) })
      }
      break
    case "SessionEnd": {
      // Session closed → evict it from the live board (root + its sub-agents). Also
      // clears "opened-then-closed" sessions that never ran anything.
      if (nodes[rid]) rootIds = evictRoot(nodes, rootIds, rid)
      break
    }
    default:
      break // unknown / uninteresting event — leave state untouched
  }

  return { nodes, rootIds }
}

/** Delete a session root + its sub-agents from `nodes` (mutated); returns the new rootIds. */
function evictRoot(nodes: Record<string, AgentNode>, rootIds: string[], rid: string): string[] {
  for (const cid of nodes[rid]?.childIds ?? []) delete nodes[cid]
  delete nodes[rid]
  return rootIds.filter((id) => id !== rid)
}

const paneIdsMemo = new WeakMap<AgentGraph, string[]>()

/** Panes with a live Claude session, sorted; memoized per graph (selectors run on every set). */
export function claudePaneIds(graph: AgentGraph): string[] {
  const hit = paneIdsMemo.get(graph)
  if (hit) return hit
  const ids = new Set<string>()
  for (const rid of graph.rootIds) {
    const n = graph.nodes[rid]
    if (n?.paneId && !n.nested) ids.add(n.paneId) // a background agent alone isn't "Claude here"
  }
  const out = [...ids].sort()
  paneIdsMemo.set(graph, out)
  return out
}

/** Evict a pane's sessions (its prompt returned: Claude exited, SessionEnd or not). */
export function dropPaneSessions(graph: AgentGraph, paneId: string): AgentGraph {
  const gone = graph.rootIds.filter((rid) => graph.nodes[rid]?.paneId === paneId)
  if (gone.length === 0) return graph
  const nodes = { ...graph.nodes }
  let rootIds = graph.rootIds
  for (const rid of gone) rootIds = evictRoot(nodes, rootIds, rid)
  return { nodes, rootIds }
}

/** Fold a whole event stream (convenience over reduceAgentEvent). */
export const reduceAgentEvents = (
  events: AgentEvent[],
  graph: AgentGraph = emptyGraph,
): AgentGraph => events.reduce(reduceAgentEvent, graph)
