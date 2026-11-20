import type { OpenRequest, Tab } from "../types"

export type OpenTarget = { tabId: string; direction: "row" | "column" } | { newTab: string }

/** Where `minmux open` puts its pane: the tab titled `req.tab` (else the active one), split on
 *  `req.split` (default right) at its focused pane — or a new tab, its single pane. */
export function openTarget(
  tabs: Tab[],
  activeTabId: string | null,
  req: Pick<OpenRequest, "tab" | "split">,
): OpenTarget {
  const tab =
    req.tab !== undefined
      ? tabs.find((t) => t.title === req.tab)
      : tabs.find((t) => t.id === activeTabId)
  if (!tab) return { newTab: req.tab ?? "" }
  return { tabId: tab.id, direction: req.split === "down" ? "column" : "row" }
}
