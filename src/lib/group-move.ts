// Moving one terminal between groups (tabs): join another group, drop into one of its panes,
// or become a new group of its own. Pure; the store applies the result. The terminal keeps
// its session (it re-attaches, never respawns).
import type { Tab } from "../types"
import { moveTo } from "./tab-order"
import {
  allSessionIds,
  findPane,
  findPaneById,
  firstSessionId,
  insertSurface,
  joinRight,
  makeLeaf,
  removeNode,
  type MoveTarget,
} from "./pane-tree"

/** The drag payload of a terminal (a pane's surface tab, a sidebar row): its session id. */
export const SURFACE_DRAG_TYPE = "application/x-minmux-surface"

/** Where a dragged terminal lands. */
export type GroupDrop =
  | { kind: "join"; tabId: string } // onto a group: a new pane on its right
  | { kind: "pane"; tabId: string; target: MoveTarget } // onto a pane of another group
  | { kind: "new"; insertAt: number } // into a gap: a group of its own, before tabs[insertAt]

export interface Ids {
  splitId: string
  paneId: string
  tabId: string
}

/** The tab holding `sessionId`. */
export const tabOf = (tabs: Tab[], sessionId: string): Tab | undefined =>
  tabs.find((t) => !!findPane(t.root, sessionId))

/** Would this drop change anything? (drives the drop hints) */
export function canDrop(tabs: Tab[], sessionId: string, drop: GroupDrop): boolean {
  const src = tabOf(tabs, sessionId)
  if (!src) return false
  if (drop.kind === "new") {
    if (allSessionIds(src.root).length > 1) return true
    return moveTo(tabs, src.id, drop.insertAt) !== tabs // its own group: a reorder
  }
  return drop.tabId !== src.id && tabs.some((t) => t.id === drop.tabId)
}

/** Apply a drop; null when nothing changes. The moved terminal's group becomes active and the
 *  terminal its focus; a group left empty disappears. */
export function moveTerminal(
  tabs: Tab[],
  sessionId: string,
  drop: GroupDrop,
  ids: Ids,
): { tabs: Tab[]; activeTabId: string } | null {
  if (!canDrop(tabs, sessionId, drop)) return null
  const src = tabOf(tabs, sessionId)!
  const rest = removeNode(src.root, sessionId)
  // The source group without it: gone if it was its only terminal. If it had the focus, the
  // surface now shown in its pane takes it (as when closing it), else the first pane.
  const srcPane = findPane(src.root, sessionId)!
  const srcAfter: Tab | null = rest
    ? {
        ...src,
        root: rest,
        activeSessionId:
          src.activeSessionId === sessionId
            ? (findPaneById(rest, srcPane.id)?.activeSessionId ?? firstSessionId(rest))
            : src.activeSessionId,
      }
    : null

  if (drop.kind === "new") {
    // Its only terminal: the group itself moves (a reorder).
    if (!srcAfter) return { tabs: moveTo(tabs, src.id, drop.insertAt), activeTabId: src.id }
    const fresh: Tab = {
      id: ids.tabId,
      title: "",
      root: makeLeaf(ids.paneId, sessionId),
      activeSessionId: sessionId,
    }
    const out = tabs.map((t) => (t === src ? srcAfter : t))
    out.splice(Math.max(0, Math.min(drop.insertAt, out.length)), 0, fresh)
    return { tabs: out, activeTabId: fresh.id }
  }

  const dst = tabs.find((t) => t.id === drop.tabId)!
  const root =
    drop.kind === "join"
      ? joinRight(dst.root, sessionId, ids)
      : insertSurface(dst.root, sessionId, drop.target, ids)
  if (root === dst.root) return null // the target pane went away mid-drag
  const dstAfter: Tab = { ...dst, root, activeSessionId: sessionId }
  const out = tabs.flatMap((t) =>
    t === dst ? [dstAfter] : t === src ? (srcAfter ? [srcAfter] : []) : [t],
  )
  return { tabs: out, activeTabId: dst.id }
}
