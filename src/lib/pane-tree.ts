import type { DropZone, PaneLeaf, PaneNode } from "../types"
import { isTerminalEntry } from "./entries"

// Pure pane-tree ops. A leaf is a pane holding one or more entries (surfaces): terminals today,
// folders and files later (lib/entries). IDs are passed in (not generated) to keep everything
// pure and testable. Ops return the same node reference when nothing changed so store
// selectors stay quiet.

/** A pane with a single entry. */
export const makeLeaf = (paneId: string, entryId: string): PaneLeaf => ({
  type: "leaf",
  id: paneId,
  entryIds: [entryId],
  activeEntryId: entryId,
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
 * Split the pane holding `targetEntryId` into a `direction` split whose two
 * children are that pane and a new pane (`newPaneId`) for `newEntryId`.
 */
export function splitNode(
  node: PaneNode,
  targetEntryId: string,
  direction: "row" | "column",
  newEntryId: string,
  newSplitId: string,
  newPaneId: string,
): PaneNode {
  return mapLeaves(node, (leaf) =>
    leaf.entryIds.includes(targetEntryId)
      ? {
          type: "split",
          id: newSplitId,
          direction,
          children: [leaf, makeLeaf(newPaneId, newEntryId)],
        }
      : leaf,
  )
}

/** Add `entryId` as the active surface of pane `paneId`, at `index` (default: the end). */
export function addSurface(
  node: PaneNode,
  paneId: string,
  entryId: string,
  index?: number,
): PaneNode {
  return mapLeaves(node, (leaf) => {
    if (leaf.id !== paneId || leaf.entryIds.includes(entryId)) return leaf
    const entryIds = [...leaf.entryIds]
    entryIds.splice(index ?? entryIds.length, 0, entryId)
    return { ...leaf, entryIds, activeEntryId: entryId }
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
export function canMove(node: PaneNode, entryId: string, target: MoveTarget): boolean {
  const src = findPane(node, entryId)
  const dst = findPaneById(node, target.paneId)
  if (!dst) return false
  if (!src) return true
  const samePane = src.id === dst.id
  if ("index" in target) {
    if (!samePane) return true
    const from = src.entryIds.indexOf(entryId)
    return target.index !== from && target.index !== from + 1 // either side of itself = stay
  }
  if (target.zone === "center") return !samePane
  return !(samePane && src.entryIds.length === 1) // can't split its only surface off itself
}

/** Move a surface to `target` (it becomes visible there); same reference if nothing changes. */
export function moveSurface(
  node: PaneNode,
  entryId: string,
  target: MoveTarget,
  ids: { splitId: string; paneId: string },
): PaneNode {
  const src = findPane(node, entryId)
  const dst = findPaneById(node, target.paneId)
  if (!src || !dst) return node
  const samePane = src.id === dst.id

  if ("index" in target) {
    if (samePane) {
      // `index` is a slot in the strip as rendered (moved tab included): account for its removal.
      const from = src.entryIds.indexOf(entryId)
      const to = Math.max(
        0,
        Math.min(target.index > from ? target.index - 1 : target.index, src.entryIds.length - 1),
      )
      if (to === from) return selectSurface(node, entryId)
      const entryIds = src.entryIds.filter((id) => id !== entryId)
      entryIds.splice(to, 0, entryId)
      return mapLeaves(node, (leaf) =>
        leaf.id === src.id ? { ...leaf, entryIds, activeEntryId: entryId } : leaf,
      )
    }
    const rest = removeNode(node, entryId)! // dst survives: it's a different pane
    return addSurface(
      rest,
      dst.id,
      entryId,
      Math.max(0, Math.min(target.index, dst.entryIds.length)),
    )
  }

  if (target.zone === "center") {
    if (samePane) return node
    return addSurface(removeNode(node, entryId)!, dst.id, entryId)
  }
  // Edge: a pane's only surface can't be split off beside itself.
  if (samePane && src.entryIds.length === 1) return node
  const rest = removeNode(node, entryId)! // dst survives: different pane, or it kept others
  return splitPaneAt(rest, dst.id, target.zone, makeLeaf(ids.paneId, entryId), ids.splitId)
}

/** Put a surface from another tree at `target` (it becomes visible there); same reference if
 *  the target pane isn't in this tree. */
export function insertSurface(
  node: PaneNode,
  entryId: string,
  target: MoveTarget,
  ids: { splitId: string; paneId: string },
): PaneNode {
  const dst = findPaneById(node, target.paneId)
  if (!dst || findPane(node, entryId)) return node
  if ("index" in target) {
    return addSurface(
      node,
      dst.id,
      entryId,
      Math.max(0, Math.min(target.index, dst.entryIds.length)),
    )
  }
  if (target.zone === "center") return addSurface(node, dst.id, entryId)
  return splitPaneAt(node, dst.id, target.zone, makeLeaf(ids.paneId, entryId), ids.splitId)
}

/** A surface from another tree joins this one as a new pane on the right of everything. */
export function joinRight(
  node: PaneNode,
  entryId: string,
  ids: { splitId: string; paneId: string },
): PaneNode {
  if (findPane(node, entryId)) return node
  return {
    type: "split",
    id: ids.splitId,
    direction: "row",
    children: [node, makeLeaf(ids.paneId, entryId)],
  }
}

/** Make `entryId` the visible surface of whichever pane holds it. */
export function selectSurface(node: PaneNode, entryId: string): PaneNode {
  return mapLeaves(node, (leaf) =>
    leaf.entryIds.includes(entryId) && leaf.activeEntryId !== entryId
      ? { ...leaf, activeEntryId: entryId }
      : leaf,
  )
}

/** Remove a surface (right, else left, neighbour shows); an emptied pane collapses; null if none left. */
export function removeNode(node: PaneNode, targetEntryId: string): PaneNode | null {
  return filterLeaves(node, (leaf) => {
    const idx = leaf.entryIds.indexOf(targetEntryId)
    if (idx === -1) return leaf
    const entryIds = leaf.entryIds.filter((id) => id !== targetEntryId)
    if (entryIds.length === 0) return null
    const activeEntryId =
      leaf.activeEntryId === targetEntryId
        ? entryIds[Math.min(idx, entryIds.length - 1)]!
        : leaf.activeEntryId
    return { ...leaf, entryIds, activeEntryId }
  })
}

/** Remove pane `paneId` with all its surfaces. Returns null if the whole tree is removed. */
export function removePane(node: PaneNode, paneId: string): PaneNode | null {
  return filterLeaves(node, (leaf) => (leaf.id === paneId ? null : leaf))
}

/** The pane holding entry `entryId`, if any. */
export const findPane = (node: PaneNode, entryId: string): PaneLeaf | undefined =>
  allPanes(node).find((p) => p.entryIds.includes(entryId))

/** The pane whose PaneLeaf.id is `paneId` (not an entry id), if any. */
export const findPaneById = (node: PaneNode, paneId: string): PaneLeaf | undefined =>
  allPanes(node).find((p) => p.id === paneId)

/** All panes (leaves), left-to-right. */
export function allPanes(node: PaneNode): PaneLeaf[] {
  if (node.type === "leaf") return [node]
  return [...allPanes(node.children[0]), ...allPanes(node.children[1])]
}

/** Every entry id under a node, hidden surfaces included (left-to-right). */
export function allEntryIds(node: PaneNode): string[] {
  return allPanes(node).flatMap((p) => p.entryIds)
}

/** A pane's terminals (session ids), in tab order. */
export const paneSessionIds = (leaf: PaneLeaf): string[] => leaf.entryIds.filter(isTerminalEntry)

/** Every terminal (session id) under a node, hidden surfaces included (left-to-right). */
export function allSessionIds(node: PaneNode): string[] {
  return allPanes(node).flatMap(paneSessionIds)
}

/** The terminal a pane shows: its visible entry when that's a terminal, else none. */
export const visibleTerminal = (leaf: PaneLeaf): string | undefined =>
  isTerminalEntry(leaf.activeEntryId) ? leaf.activeEntryId : undefined

/** Only the on-screen terminals: each pane's visible entry, when it's a terminal. */
export function visibleSessionIds(node: PaneNode): string[] {
  return allPanes(node).flatMap((p) => {
    const id = visibleTerminal(p)
    return id ? [id] : []
  })
}

/** The leftmost pane's visible entry: used to pick a new focus after a close. */
export function firstEntryId(node: PaneNode): string {
  let cur: PaneNode = node
  while (cur.type === "split") cur = cur.children[0]
  return cur.activeEntryId
}

/** The leftmost terminal (its pane's visible one first): a tab's terminal after a close. */
export function firstSessionId(node: PaneNode): string | undefined {
  for (const p of allPanes(node)) {
    const id = visibleTerminal(p) ?? paneSessionIds(p)[0]
    if (id) return id
  }
  return undefined
}

/** Stable React/panel key for a node. */
export const nodeKey = (node: PaneNode): string => node.id
