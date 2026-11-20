// A tab's focus (lib/entries): `activeEntryId` is the entry with keyboard focus, its pane's
// visible one; `activeSessionId` is the tab's terminal (the focus when it's a terminal, else the
// last focused one). Every focus change goes through here so the two can't drift apart.
import type { PaneNode, Tab } from "../types"
import { isTerminalEntry } from "./entries"
import { allSessionIds, findPane, firstSessionId, selectSurface } from "./pane-tree"

/** A tab over `root`, focused on `entryId` (a terminal: tabs open on one). */
export const makeTab = (id: string, title: string, root: PaneNode, entryId: string): Tab => ({
  id,
  title,
  root,
  activeEntryId: entryId,
  activeSessionId: entryId,
})

// withFocus: the focus becomes its pane's visible surface unless `select` is false. The tab's
// terminal follows a terminal entry; otherwise it stays, or moves to the leftmost terminal when
// it left the tree. A tab left with no terminal at all is decided in step 2 (#181).
/** `tab` over `root` (default: its own) focused on `entryId`; same tab when unchanged. */
export function withFocus(
  tab: Tab,
  entryId: string,
  root: PaneNode = tab.root,
  select = true,
): Tab {
  if (!findPane(root, entryId)) return tab // a stale id (it closed or moved): focus stays put
  const shown = select ? selectSurface(root, entryId) : root
  const activeSessionId = isTerminalEntry(entryId)
    ? entryId
    : allSessionIds(shown).includes(tab.activeSessionId)
      ? tab.activeSessionId
      : (firstSessionId(shown) ?? tab.activeSessionId)
  if (
    shown === tab.root &&
    tab.activeEntryId === entryId &&
    tab.activeSessionId === activeSessionId
  ) {
    return tab
  }
  return { ...tab, root: shown, activeEntryId: entryId, activeSessionId }
}
