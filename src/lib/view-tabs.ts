// View tabs (docs/design/FLEET_GRAPH.md, "View tabs"): top-bar tabs that hold a view instead of
// panes. Terminal tabs stay in `tabs`; view tabs sit after them, in the order opened, at most
// one per kind. `activeView` says a view covers the pane area; `activeTabId` keeps meaning the
// terminal tab in context (the one shown when the view goes away). Pure.
import type { Tab } from "../types"
import type { AgentGraph } from "./agent-graph"

export type ViewKind = "fleet"

export const VIEW_KINDS: readonly ViewKind[] = ["fleet"]

export const isViewKind = (v: unknown): v is ViewKind =>
  typeof v === "string" && (VIEW_KINDS as readonly string[]).includes(v)

/** The bar's view tabs with `kind` opened (added at the end once; same reference if there). */
export function withView(views: ViewKind[], kind: ViewKind): ViewKind[] {
  return views.includes(kind) ? views : [...views, kind]
}

/** The bar's view tabs without `kind` (same reference when it wasn't open). */
export function withoutView(views: ViewKind[], kind: ViewKind): ViewKind[] {
  return views.includes(kind) ? views.filter((v) => v !== kind) : views
}

/** Saved view tabs, read back: known kinds only, each once, in order. */
export function parseViews(v: unknown): ViewKind[] {
  if (!Array.isArray(v)) return []
  return v.filter(isViewKind).filter((k, i, all) => all.indexOf(k) === i)
}

/** A view tab's dot: the fleet's, amber while any agent needs you, green while any works. */
export function viewDot(kind: ViewKind, agents: AgentGraph): "amber" | "accent" | "" {
  if (kind !== "fleet") return ""
  let working = false
  for (const id of agents.rootIds) {
    const status = agents.nodes[id]?.status
    if (status === "waiting") return "amber"
    if (status === "working") working = true
  }
  return working ? "accent" : ""
}

export const VIEW_LABEL: Record<ViewKind, string> = { fleet: "Fleet" }

type TabState = { tabs: Tab[]; activeTabId: string | null; activeView: ViewKind | null }

/** The terminal tab on screen: the context tab, unless a view covers it. Readers asking "what
 *  is the user looking at" use this; readers asking "which tab is in context" keep activeTabId. */
export function shownTerminalTab(state: TabState): Tab | undefined {
  if (state.activeView) return undefined
  return state.tabs.find((t) => t.id === state.activeTabId)
}

/** A state update that moves `activeTabId` to another tab leaves the view, whatever action
 *  made it (a tab click, the drag spring, a new tab, a moved terminal): one rule, not one per
 *  action. An update that sets `activeView` itself is left alone. */
export function leavingView<T extends Partial<TabState>>(
  state: { activeTabId: string | null; activeView: ViewKind | null },
  next: T,
): T {
  if (!state.activeView || !next || typeof next !== "object") return next
  if (!("activeTabId" in next) || "activeView" in next) return next
  if (next.activeTabId === state.activeTabId) return next
  return { ...next, activeView: null }
}
