import type { DropZone, PaneLeaf, PaneNode } from "../types"

// Pure pane-tree ops. A leaf is a pane holding one or more terminals (surfaces);
// IDs are passed in (not generated) to keep everything pure and testable. Ops return
// the same node reference when nothing changed so store selectors stay quiet.

/** A pane with a single terminal. */
export const makeLeaf = (paneId: string, sessionId: string): PaneLeaf => ({
  type: "leaf",
  id: paneId,
  sessionIds: [sessionId],
  activeSessionId: sessionId,
})

/** Rebuild splits only along the path where a child actually changed. */
function mapLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneNode): PaneNode {
  if (node.type === "leaf") return fn(node)
  const a = mapLeaves(node.children[0], fn)
  const b = mapLeaves(node.children[1], fn)
  return a === node.children[0] && b === node.children[1] ? node : { ...node, children: [a, b] }
}

/** Drop leaves for which `fn` returns null; a split left with one child collapses into it. */
function filterLeaves(node: PaneNode, fn: (leaf: PaneLeaf) => PaneNode | null): PaneNode | null {
  if (node.type === "leaf") return fn(node)
  const a = filterLeaves(node.children[0], fn)
  const b = filterLeaves(node.children[1], fn)
  if (a && b) {
    return a === node.children[0] && b === node.children[1] ? node : { ...node, children: [a, b] }
  }
  return a ?? b
}

/**
 * Split the pane holding `targetSessionId` into a `direction` split whose two
 * children are that pane and a new pane (`newPaneId`) for `newSessionId`.
 */
export function splitNode(
  node: PaneNode,
  targetSessionId: string,
  direction: "row" | "column",
  newSessionId: string,
  newSplitId: string,
  newPaneId: string,
): PaneNode {
  return mapLeaves(node, (leaf) =>
    leaf.sessionIds.includes(targetSessionId)
      ? {
          type: "split",
          id: newSplitId,
          direction,
          children: [leaf, makeLeaf(newPaneId, newSessionId)],
        }
      : leaf,
  )
}

/** Add `sessionId` as the active surface of pane `paneId`, at `index` (default: the end). */
export function addSurface(
  node: PaneNode,
  paneId: string,
  sessionId: string,
  index?: number,
): PaneNode {
  return mapLeaves(node, (leaf) => {
    if (leaf.id !== paneId || leaf.sessionIds.includes(sessionId)) return leaf
    const sessionIds = [...leaf.sessionIds]
    sessionIds.splice(index ?? sessionIds.length, 0, sessionId)
    return { ...leaf, sessionIds, activeSessionId: sessionId }
  })
}

/** Split pane `paneId` on `side`, putting `leaf` there (left/top → first child). */
function splitPaneAt(
  node: PaneNode,
  paneId: string,
  side: Exclude<DropZone, "center">,
  leaf: PaneLeaf,
  splitId: string,
): PaneNode {
  return mapLeaves(node, (target) => {
    if (target.id !== paneId) return target
    const first = side === "left" || side === "top"
    return {
      type: "split",
      id: splitId,
      direction: side === "left" || side === "right" ? "row" : "column",
      children: first ? [leaf, target] : [target, leaf],
    }
  })
}

/** A drop target: a pane's zone (edge = new split, centre = join) or a slot in its tab strip. */
export type MoveTarget = { paneId: string; zone: DropZone } | { paneId: string; index: number }

/** Whether moving a surface to `target` would change the layout (drives the drop hints). A
 *  surface from another tree (another group) can go anywhere there. */
export function canMove(node: PaneNode, sessionId: string, target: MoveTarget): boolean {
  const src = findPane(node, sessionId)
  const dst = findPaneById(node, target.paneId)
  if (!dst) return false
  if (!src) return true
  const samePane = src.id === dst.id
  if ("index" in target) {
    if (!samePane) return true
    const from = src.sessionIds.indexOf(sessionId)
    return target.index !== from && target.index !== from + 1 // either side of itself = stay
  }
  if (target.zone === "center") return !samePane
  return !(samePane && src.sessionIds.length === 1) // can't split its only surface off itself
}

/** Move a surface to `target` (it becomes visible there); same reference if nothing changes. */
export function moveSurface(
  node: PaneNode,
  sessionId: string,
  target: MoveTarget,
  ids: { splitId: string; paneId: string },
): PaneNode {
  const src = findPane(node, sessionId)
  const dst = findPaneById(node, target.paneId)
  if (!src || !dst) return node
  const samePane = src.id === dst.id

  if ("index" in target) {
    if (samePane) {
      // `index` is a slot in the strip as rendered (moved tab included): account for its removal.
      const from = src.sessionIds.indexOf(sessionId)
      const to = Math.max(
        0,
        Math.min(target.index > from ? target.index - 1 : target.index, src.sessionIds.length - 1),
      )
      if (to === from) return selectSurface(node, sessionId)
      const sessionIds = src.sessionIds.filter((id) => id !== sessionId)
      sessionIds.splice(to, 0, sessionId)
      return mapLeaves(node, (leaf) =>
        leaf.id === src.id ? { ...leaf, sessionIds, activeSessionId: sessionId } : leaf,
      )
    }
    const rest = removeNode(node, sessionId)! // dst survives: it's a different pane
    return addSurface(
      rest,
      dst.id,
      sessionId,
      Math.max(0, Math.min(target.index, dst.sessionIds.length)),
    )
  }

  if (target.zone === "center") {
    if (samePane) return node
    return addSurface(removeNode(node, sessionId)!, dst.id, sessionId)
  }
  // Edge: a pane's only surface can't be split off beside itself.
  if (samePane && src.sessionIds.length === 1) return node
  const rest = removeNode(node, sessionId)! // dst survives: different pane, or it kept others
  return splitPaneAt(rest, dst.id, target.zone, makeLeaf(ids.paneId, sessionId), ids.splitId)
}

/** Put a surface from another tree at `target` (it becomes visible there); same reference if
 *  the target pane isn't in this tree. */
export function insertSurface(
  node: PaneNode,
  sessionId: string,
  target: MoveTarget,
  ids: { splitId: string; paneId: string },
): PaneNode {
  const dst = findPaneById(node, target.paneId)
  if (!dst || findPane(node, sessionId)) return node
  if ("index" in target) {
    return addSurface(
      node,
      dst.id,
      sessionId,
      Math.max(0, Math.min(target.index, dst.sessionIds.length)),
    )
  }
  if (target.zone === "center") return addSurface(node, dst.id, sessionId)
  return splitPaneAt(node, dst.id, target.zone, makeLeaf(ids.paneId, sessionId), ids.splitId)
}

/** A surface from another tree joins this one as a new pane on the right of everything. */
export function joinRight(
  node: PaneNode,
  sessionId: string,
  ids: { splitId: string; paneId: string },
): PaneNode {
  if (findPane(node, sessionId)) return node
  return {
    type: "split",
    id: ids.splitId,
    direction: "row",
    children: [node, makeLeaf(ids.paneId, sessionId)],
  }
}

/** Make `sessionId` the visible surface of whichever pane holds it. */
export function selectSurface(node: PaneNode, sessionId: string): PaneNode {
  return mapLeaves(node, (leaf) =>
    leaf.sessionIds.includes(sessionId) && leaf.activeSessionId !== sessionId
      ? { ...leaf, activeSessionId: sessionId }
      : leaf,
  )
}

/** Remove a surface (right, else left, neighbour shows); an emptied pane collapses; null if none left. */
export function removeNode(node: PaneNode, targetSessionId: string): PaneNode | null {
  return filterLeaves(node, (leaf) => {
    const idx = leaf.sessionIds.indexOf(targetSessionId)
    if (idx === -1) return leaf
    const sessionIds = leaf.sessionIds.filter((id) => id !== targetSessionId)
    if (sessionIds.length === 0) return null
    const activeSessionId =
      leaf.activeSessionId === targetSessionId
        ? sessionIds[Math.min(idx, sessionIds.length - 1)]!
        : leaf.activeSessionId
    return { ...leaf, sessionIds, activeSessionId }
  })
}

/** Remove pane `paneId` with all its surfaces. Returns null if the whole tree is removed. */
export function removePane(node: PaneNode, paneId: string): PaneNode | null {
  return filterLeaves(node, (leaf) => (leaf.id === paneId ? null : leaf))
}

/** The pane holding `sessionId`, if any. */
export const findPane = (node: PaneNode, sessionId: string): PaneLeaf | undefined =>
  allPanes(node).find((p) => p.sessionIds.includes(sessionId))

/** The pane whose PaneLeaf.id is `paneId` (not a session id), if any. */
export const findPaneById = (node: PaneNode, paneId: string): PaneLeaf | undefined =>
  allPanes(node).find((p) => p.id === paneId)

/** All panes (leaves), left-to-right. */
export function allPanes(node: PaneNode): PaneLeaf[] {
  if (node.type === "leaf") return [node]
  return [...allPanes(node.children[0]), ...allPanes(node.children[1])]
}

/** Every session id under a node — hidden surfaces included (left-to-right). */
export function allSessionIds(node: PaneNode): string[] {
  return allPanes(node).flatMap((p) => p.sessionIds)
}

/** Only the on-screen session ids: each pane's active surface. */
export function visibleSessionIds(node: PaneNode): string[] {
  return allPanes(node).map((p) => p.activeSessionId)
}

/** The leftmost pane's visible session — used to pick a new focus after a close. */
export function firstSessionId(node: PaneNode): string {
  let cur: PaneNode = node
  while (cur.type === "split") cur = cur.children[0]
  return cur.activeSessionId
}

/** Stable React/panel key for a node. */
export const nodeKey = (node: PaneNode): string => node.id
