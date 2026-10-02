// Pure reducer that folds a stream of coding-agent events (Claude Code, Codex, OpenCode —
// each normalised to Claude's hook vocabulary by its adapter in main) into a live tree of
// agents + their status/cwd/recent-files. The risky logic of M6 lives here, tested
// against real captured hook streams (see agent-graph.test.ts). No I/O, no time —
// the receiver normalises raw hook JSON into AgentEvent and calls reduceAgentEvent.
//
// Correlation model (validated by the 6a spike — see docs/design/AGENT_OBSERVABILITY.md):
//   - root agent  = events with NO agent_id (the session itself)
//   - sub-agent   = events carrying an agent_id (attach to their session's root, or to
//                   `parentAgentId` when the agent reports one — OpenCode's child sessions)
// Claude and Codex give two levels (root → sub-agents); an explicit parent gives depth.
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

/** Which coding agent an event / node belongs to (one adapter each in main). */
export type AgentKind = "claude" | "codex" | "opencode"

/** The canonical event names: Claude Code's hook names (Codex uses the same contract), plus
 *  PermissionRequest (Codex) and the synthetic TokenUsage. Adapters map onto these. */
export type AgentEventName =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "Stop"
  | "Notification"
  | "PermissionRequest"
  | "PreToolUse"
  | "PostToolUse"
  | "SubagentStart"
  | "SubagentStop"
  | "CwdChanged"
  | "FileChanged"
  | "WorktreeCreate"
  | "WorktreeRemove"
  | "TokenUsage"

/** The agent an event (or ledger entry) belongs to: absent means Claude's. */
export const agentOf = (x: { agent?: AgentKind }): AgentKind => x.agent ?? "claude"

/** A hook event normalised down to the fields the graph needs. */
export interface AgentEvent {
  agent?: AgentKind // the adapter that produced it; absent ⇒ "claude" (older drops, fixtures)
  event: AgentEventName | (string & {}) // unknown names pass through and change nothing
  sessionId: string
  paneId?: string // the minmux pane (session id) this agent session runs in
  agentId?: string // absent ⇒ the session root; present ⇒ a sub-agent
  parentAgentId?: string // a sub-agent's parent sub-agent (absent ⇒ the session root)
  pid?: number // the agent process that ran the hook (the drop's filename) — Codex's lead rule
  agentType?: string // e.g. "Explore", "general-purpose" (sub-agents only)
  cwd?: string
  toolName?: string // tool_name on Pre/PostToolUse
  toolKey?: string // one tool call: its name + a hash of its input (matches an approval to it)
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
  agent: AgentKind
  sessionId: string
  paneId?: string // the minmux pane this session runs in (roots) — for focus/grouping
  agentType: string // "root" for the session root, else the sub-agent type
  status: AgentStatus
  currentTool?: string // in-flight tool (set on PreToolUse, cleared on PostToolUse)
  waitingFor?: string // the tool call (toolKey) an approval (PermissionRequest) is pending for
  cwd?: string
  recentFiles: string[] // most-recent-first, capped
  worktrees?: Worktree[] // worktrees created in this session (WorktreeCreate), root only
  started?: number // root: order of its latest SessionStart — the newest per pane is live
  nested?: boolean // root: launched inside the pane's lead (background agent) — main decides
  lastMessage?: string
  tokens?: TokenUsage // cumulative token usage (session root or sub-agent), off-band via hooks
  parentId?: string // undefined for a root; the root or (explicit parent) a sub-agent
  childIds: string[] // direct sub-agents, in order of appearance
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
      agent: agentOf(ev),
      sessionId: ev.sessionId,
      paneId: ev.paneId,
      agentType: "root",
      status: "idle",
      cwd: ev.cwd,
      recentFiles: [],
      childIds: [],
    }
    rootIds = [...rootIds, rid]
  } else if (ev.agent && !ev.agentId && at(rid).agent !== ev.agent) {
    // A tagged root event settles the session's kind (a root first created by an untagged
    // stray event defaulted to Claude).
    nodes[rid] = { ...at(rid), agent: ev.agent }
  }

  // A sub-agent event may arrive before its SubagentStart — create it lazily and attach
  // it to its reported parent when that one is a live node of this session, else to the
  // session root (Claude/Codex never report a parent: two levels).
  if (ev.agentId && !nodes[ev.agentId]) {
    const p = ev.parentAgentId ? nodes[ev.parentAgentId] : undefined
    const parentId = p && p.sessionId === ev.sessionId ? p.id : rid
    nodes[ev.agentId] = {
      id: ev.agentId,
      agent: ev.agent ?? at(rid).agent, // a sub-agent is its session's kind
      sessionId: ev.sessionId,
      agentType: ev.agentType ?? "agent",
      status: "working",
      cwd: ev.cwd,
      recentFiles: [],
      parentId,
      childIds: [],
    }
    const parent = at(parentId)
    if (!parent.childIds.includes(ev.agentId)) {
      nodes[parentId] = { ...parent, childIds: [...parent.childIds, ev.agentId] }
    }
  } else if (ev.agentId && ev.parentAgentId) {
    // Drops arrive unordered: a sub-agent first seen before its parent sits under the root
    // until an event names the parent — then it moves there.
    reparent(nodes, ev.agentId, ev.parentAgentId)
  }

  // Main decides which session leads the pane (one classifier, shared with resume + accent):
  // a background agent inherits the pane but mustn't take `in` over.
  if (ev.nested !== undefined && !ev.agentId && nodes[rid]?.nested !== ev.nested)
    nodes[rid] = { ...at(rid), nested: ev.nested }

  const targetId = ev.agentId ?? rid
  const set = (id: string, changes: Partial<AgentNode>) => {
    nodes[id] = { ...at(id), ...changes }
  }
  /** `id`'s pending approval is over: back to working, and so is its root if it was the
   *  same approval that made the root wait. */
  const endWait = (id: string) => {
    const key = at(id).waitingFor
    if (!key) return
    set(id, { status: "working", waitingFor: undefined })
    if (id !== rid && at(rid).waitingFor === key)
      set(rid, { status: "working", waitingFor: undefined })
  }

  switch (ev.event) {
    case "SessionStart":
      // A (re)start — also in another pane (`claude --resume` after a crash) — makes it its
      // pane's newest session (`started`); the board order (rootIds) never changes. An
      // approval pending before (a crash, a quit) is gone.
      clearWaits(nodes, rid)
      set(rid, {
        status: "idle",
        cwd: ev.cwd ?? at(rid).cwd,
        paneId: ev.paneId ?? at(rid).paneId,
        started: Math.max(0, ...rootIds.map((id) => nodes[id]?.started ?? 0)) + 1,
      })
      break
    case "UserPromptSubmit":
      // New turn: drop the previous turn's FINISHED sub-agents (they're per-turn), so
      // the board shows the current turn, not a growing pile of done ones. Keep any
      // still-active sub-agent (and the finished ancestors it hangs under). Then mark
      // the session working.
      pruneDone(nodes, rid)
      clearWaits(nodes, rid)
      set(rid, { status: "working" })
      break
    case "SubagentStart":
      if (ev.agentId)
        set(ev.agentId, {
          agentType: ev.agentType ?? at(ev.agentId).agentType,
          status: "working",
        })
      break
    case "PreToolUse": {
      // The call an approval is pending for keeps waiting: Codex fires its PreToolUse and its
      // PermissionRequest ~40 ms apart from separate hook processes, so either lands first.
      // Any other call starting means the agent moved on (approved, or denied and going on).
      const twin = !!ev.toolKey && at(targetId).waitingFor === (ev.toolKey ?? ev.toolName)
      if (!twin) endWait(targetId)
      set(targetId, {
        status: twin ? "waiting" : "working",
        currentTool: ev.toolName,
        cwd: ev.cwd ?? at(targetId).cwd,
        recentFiles: withFile(at(targetId).recentFiles, ev.filePath),
      })
      break
    }
    case "PostToolUse":
      // The call an approval was pending for ran: answered. Any other (parallel) call
      // finishing leaves the approval pending.
      if (at(targetId).waitingFor && at(targetId).waitingFor === (ev.toolKey ?? ev.toolName))
        endWait(targetId)
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
      clearWaits(nodes, rid)
      set(rid, {
        status: "idle",
        currentTool: undefined,
        lastMessage: ev.message ?? at(rid).lastMessage,
      })
      break
    case "Notification":
      set(rid, { status: "waiting", lastMessage: ev.message ?? at(rid).lastMessage })
      break
    case "PermissionRequest":
      {
        // An approval prompt (Codex): the agent asking — and so its session — waits on the user
        // until that call runs or another starts, the turn ends, or a new prompt comes. Codex
        // sends nothing when the user answers, so an approved long command reads "waiting"
        // until it finishes (known limit).
        const key = ev.toolKey ?? ev.toolName ?? "tool"
        set(targetId, { status: "waiting", waitingFor: key })
        if (targetId !== rid) set(rid, { status: "waiting", waitingFor: key })
      }
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

/** Move sub-agent `id` under `parentId` (mutates `nodes`) when that is a live node of the same
 *  session and not `id` itself or one of its descendants (no cycles). */
function reparent(nodes: Record<string, AgentNode>, id: string, parentId: string): void {
  const node = nodes[id]
  const parent = nodes[parentId]
  if (!node || !parent || node.parentId === parentId || parent.sessionId !== node.sessionId) return
  for (
    let up: AgentNode | undefined = parent;
    up;
    up = up.parentId ? nodes[up.parentId] : undefined
  )
    if (up.id === id) return
  const old = node.parentId ? nodes[node.parentId] : undefined
  if (old) nodes[old.id] = { ...old, childIds: old.childIds.filter((c) => c !== id) }
  nodes[parentId] = { ...parent, childIds: [...parent.childIds, id] }
  nodes[id] = { ...node, parentId }
}

/** Forget every pending approval in a session's tree (mutates `nodes`; statuses stay). */
function clearWaits(nodes: Record<string, AgentNode>, id: string): void {
  const node = nodes[id]
  if (!node) return
  if (node.waitingFor) nodes[id] = { ...node, waitingFor: undefined }
  for (const cid of node.childIds) clearWaits(nodes, cid)
}

/** Delete a node and all its descendants from `nodes` (mutated). */
function deleteSubtree(nodes: Record<string, AgentNode>, id: string): void {
  for (const cid of nodes[id]?.childIds ?? []) deleteSubtree(nodes, cid)
  delete nodes[id]
}

/** Delete a session root + its sub-agents from `nodes` (mutated); returns the new rootIds. */
function evictRoot(nodes: Record<string, AgentNode>, rootIds: string[], rid: string): string[] {
  deleteSubtree(nodes, rid)
  return rootIds.filter((id) => id !== rid)
}

/** Remove `id`'s finished sub-agents whose whole subtree is finished (mutates `nodes`, only
 *  replacing nodes whose child list changed); returns whether anything under `id` stays active. */
function pruneDone(nodes: Record<string, AgentNode>, id: string): boolean {
  const node = nodes[id]
  if (!node) return false
  const keep: string[] = []
  for (const cid of node.childIds) {
    const activeBelow = pruneDone(nodes, cid)
    if (activeBelow || nodes[cid]?.status !== "done") keep.push(cid)
    else deleteSubtree(nodes, cid)
  }
  if (keep.length !== node.childIds.length) nodes[id] = { ...node, childIds: keep }
  return keep.length > 0
}

const panesMemo = new WeakMap<AgentGraph, string[]>()

/** Panes with a live lead session and its agent, flat `[paneId, kind, …]` sorted by pane
 *  (primitives for useShallow); the newest-started lead wins; memoized per graph. */
export function agentPanes(graph: AgentGraph): string[] {
  const hit = panesMemo.get(graph)
  if (hit) return hit
  const lead: Record<string, AgentNode> = {}
  for (const rid of graph.rootIds) {
    const n = graph.nodes[rid]
    if (!n?.paneId || n.nested) continue // a background agent alone isn't the pane's agent
    const cur = lead[n.paneId]
    if (!cur || (n.started ?? 0) >= (cur.started ?? 0)) lead[n.paneId] = n
  }
  const out = Object.keys(lead)
    .sort()
    .flatMap((id) => [id, lead[id]!.agent])
  panesMemo.set(graph, out)
  return out
}

const byPaneMemo = new WeakMap<AgentGraph, Record<string, AgentKind>>()

/** Each pane's lead agent (agentPanes as a lookup); memoized per graph. */
export function agentByPane(graph: AgentGraph): Record<string, AgentKind> {
  const hit = byPaneMemo.get(graph)
  if (hit) return hit
  const out = paneAgents(agentPanes(graph))
  byPaneMemo.set(graph, out)
  return out
}

/** agentPanes' flat `[paneId, kind, …]` back into a lookup (for a useShallow-selected copy). */
export function paneAgents(flat: string[]): Record<string, AgentKind> {
  const out: Record<string, AgentKind> = {}
  for (let i = 0; i + 1 < flat.length; i += 2) out[flat[i]!] = flat[i + 1] as AgentKind
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
