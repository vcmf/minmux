import type { PaneNode, RemoteRef, Session, Tab } from "../types"
import { parseRemoteRef, sshLabel } from "./ssh-validate"
import { clampPanelWidth } from "./right-panel"
import { findPane, firstSessionId, selectSurface } from "./pane-tree"

// Persisted workspace (VS Code-style layout restore). We save the layout +
// enough to respawn each pane's shell in its last directory — NOT live process
// state (scrollback / running programs are lost; a fresh shell is spawned).

// v2: a leaf is a pane with surfaces ({id, sessionIds, activeSessionId}); v1 leaves
// ({sessionId}) are migrated on read. v2 leaves ALSO carry `sessionId` (= the visible
// surface) so an older build that reads this file still restores every pane.
const VERSION = 2
/** Written by a newer build than this one (unreadable here). */
const isNewer = (w: { version?: unknown }) => typeof w.version === "number" && w.version > VERSION

interface PersistedSession {
  id: string
  title: string
  command: string
  args: string[]
  cwd?: string
  // An ssh session's host. Older builds ignore it and run `ssh <target>` from command/args.
  remote?: Pick<RemoteRef, "hostId" | "label" | "target" | "env">
}

interface PersistedTab {
  id: string
  title: string
  root: PaneNode
  activeSessionId: string
}

export interface PersistedWorkspace {
  version: number
  activeTabId: string | null
  tabs: PersistedTab[]
  sessions: PersistedSession[]
  rightPanelWidth?: number
}

export interface WorkspaceState {
  sessions: Record<string, Session>
  tabs: Tab[]
  activeTabId: string | null
  rightPanelWidth?: number
  pruned?: string[] // session records dropped on restore — their PTYs (after a reload) must die
}

/** The tree as written to disk: each leaf gets the legacy `sessionId` mirror for older builds. */
function persistTree(node: PaneNode): PaneNode {
  if (node.type === "leaf") return { ...node, sessionId: node.activeSessionId } as PaneNode
  return { ...node, children: [persistTree(node.children[0]), persistTree(node.children[1])] }
}

/** Snapshot the store's layout into the persistable shape (drops runtime status). */
export function serializeWorkspace(state: WorkspaceState): PersistedWorkspace {
  return {
    version: VERSION,
    activeTabId: state.activeTabId,
    tabs: state.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      root: persistTree(t.root),
      activeSessionId: t.activeSessionId,
    })),
    sessions: Object.values(state.sessions).map((s) => ({
      id: s.id,
      title: s.title,
      command: s.command,
      args: s.args,
      cwd: s.cwd,
      // Only what identifies the host (main looks the rest up in its own list); a saved one we
      // couldn't read goes back exactly as it was.
      ...(s.remoteSaved !== undefined
        ? { remote: s.remoteSaved as PersistedSession["remote"] }
        : s.remote
          ? {
              remote: {
                hostId: s.remote.hostId,
                label: s.remote.label,
                target: s.remote.target,
                env: s.remote.env,
              },
            }
          : {}),
    })),
    ...(state.rightPanelWidth !== undefined ? { rightPanelWidth: state.rightPanelWidth } : {}),
  }
}

/** Normalize a v1/v2 pane tree: null if malformed, undefined if the subtree has no usable pane. */
export function migratePaneNode(
  node: unknown,
  seen: Set<string> = new Set(), // session ids already placed (a session lives in one pane)
  known?: Set<string>, // session ids with a record — others can never spawn, so drop them
  paneIds: Set<string> = new Set(), // pane ids already used (closing one must not close both)
): PaneNode | null | undefined {
  if (!node || typeof node !== "object") return null
  const n = node as Record<string, unknown>
  if (n.type === "leaf") {
    // v2 (sessionIds) wins over the legacy `sessionId` mirror; a bare v1 leaf gets `pane-<sid>`.
    const raw = Array.isArray(n.sessionIds)
      ? n.sessionIds
      : typeof n.sessionId === "string"
        ? [n.sessionId]
        : null
    if (!raw) return null
    const rawId = Array.isArray(n.sessionIds) ? n.id : `pane-${String(n.sessionId)}`
    if (typeof rawId !== "string") return null
    const ids: string[] = []
    for (const x of raw) {
      if (typeof x !== "string" || seen.has(x) || (known && !known.has(x))) continue
      seen.add(x) // drop junk, duplicates, and surfaces without a session record
      ids.push(x)
    }
    if (ids.length === 0) return undefined // an unusable pane drops out; its split collapses
    const id = paneIds.has(rawId) ? `pane-${ids[0]}` : rawId // session ids are unique now
    paneIds.add(id)
    const active =
      typeof n.activeSessionId === "string" && ids.includes(n.activeSessionId)
        ? n.activeSessionId
        : ids[0]!
    return { type: "leaf", id, sessionIds: ids, activeSessionId: active }
  }
  if (n.type === "split") {
    if (typeof n.id !== "string" || (n.direction !== "row" && n.direction !== "column")) return null
    if (!Array.isArray(n.children) || n.children.length !== 2) return null
    const a = migratePaneNode(n.children[0], seen, known, paneIds)
    const b = migratePaneNode(n.children[1], seen, known, paneIds)
    if (a === null || b === null) return null
    if (!a || !b) return a ?? b // a side emptied by de-duplication collapses away
    return { type: "split", id: n.id, direction: n.direction, children: [a, b] }
  }
  return null
}

/** A persisted session's host, validated (undefined if it doesn't). */
export const restoreRemote = (v: unknown): RemoteRef | undefined => parseRemoteRef(v) ?? undefined

// A saved host we can't read: an id main never lists, so spawning it fails with a message.
const UNAVAILABLE_REMOTE = (v: unknown): RemoteRef => ({
  hostId: "unavailable",
  label: sshLabel((v as { label?: unknown } | null)?.label, "ssh"),
  target: "unavailable",
  env: "native",
})

/** Rebuild store state from a parsed workspace; null if malformed/empty. */
export function deserializeWorkspace(input: unknown): WorkspaceState | null {
  if (!input || typeof input !== "object") return null
  const w = input as Partial<PersistedWorkspace>
  if (isNewer(w)) return null // can't read a newer build's layout — don't misparse it
  if (!Array.isArray(w.tabs) || !Array.isArray(w.sessions) || w.tabs.length === 0) return null

  const sessions: Record<string, Session> = {}
  for (const p of w.sessions) {
    if (!p || typeof p.id !== "string") return null
    sessions[p.id] = {
      id: p.id,
      title: typeof p.title === "string" ? p.title : "shell",
      command: typeof p.command === "string" ? p.command : "",
      args: Array.isArray(p.args) ? p.args : [],
      status: "idle",
      unread: false,
      cwd: typeof p.cwd === "string" ? p.cwd : undefined,
    }
    if (p.remote !== undefined) {
      // A remote that no longer validates (e.g. from a newer build) is still remote: main
      // refuses it with a clear error. Never run its saved `ssh <target>` as a local command.
      const remote = restoreRemote(p.remote)
      sessions[p.id]!.remote = remote ?? UNAVAILABLE_REMOTE(p.remote)
      // Kept verbatim so the next save doesn't overwrite it with the placeholder (a newer
      // build that wrote it can still read it back).
      if (!remote) sessions[p.id]!.remoteSaved = p.remote
      delete sessions[p.id]!.cwd // a remote session never has a local cwd
    }
  }

  const tabs: Tab[] = []
  const placed = new Set<string>()
  const known = new Set(Object.keys(sessions))
  const paneIds = new Set<string>()
  for (const t of w.tabs) {
    if (!t || typeof t.id !== "string" || typeof t.activeSessionId !== "string") return null
    const root = migratePaneNode(t.root, placed, known, paneIds)
    if (root === null) return null
    if (!root) continue // no usable pane left in this tab — drop it
    // The focused session must live in this tab; else fall back to its first pane.
    const focusPane = findPane(root, t.activeSessionId)
    tabs.push({
      id: t.id,
      title: typeof t.title === "string" ? t.title : "shell",
      root: focusPane ? selectSurface(root, t.activeSessionId) : root,
      activeSessionId: focusPane ? t.activeSessionId : firstSessionId(root),
    })
  }

  if (tabs.length === 0) return null
  // Sessions no pane references (e.g. an older build dropped the surfaces) would never
  // attach — prune them rather than carry them forever.
  const pruned = Object.keys(sessions).filter((id) => !placed.has(id))
  for (const id of pruned) delete sessions[id]

  const activeTabId =
    typeof w.activeTabId === "string" && tabs.some((t) => t.id === w.activeTabId)
      ? w.activeTabId
      : (tabs[0]?.id ?? null)

  const rightPanelWidth =
    typeof w.rightPanelWidth === "number" ? clampPanelWidth(w.rightPanelWidth) : undefined

  return { sessions, tabs, activeTabId, rightPanelWidth, ...(pruned.length ? { pruned } : {}) }
}

/** Parse the raw workspace.json file, tolerant of bad/empty content. */
export function parseWorkspace(raw: string): WorkspaceState | null {
  return readWorkspaceFile(raw).state
}

/** Parse workspace.json once; `newer` = written by a newer build (the caller must not save). */
export function readWorkspaceFile(raw: string): { state: WorkspaceState | null; newer: boolean } {
  if (!raw.trim()) return { state: null, newer: false }
  try {
    const json: unknown = JSON.parse(raw)
    const newer = !!json && typeof json === "object" && isNewer(json as { version?: unknown })
    return { state: deserializeWorkspace(json), newer }
  } catch {
    return { state: null, newer: false }
  }
}

export function serializeToJson(state: WorkspaceState): string {
  return `${JSON.stringify(serializeWorkspace(state), null, 2)}\n`
}
