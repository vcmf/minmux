import type { MenuItemSpec } from "./file-actions"
import type { Tab } from "../types"

export type SessionActionId = "rename" | "resetName" | "close"

/** A sidebar session row's right-click menu. Reset only applies to a name the user gave
 *  (an unnamed session already follows its focused pane's title). */
export function sessionMenuItems(tab: Pick<Tab, "title">): MenuItemSpec<SessionActionId>[] {
  const named = tab.title.trim() !== ""
  return [
    { id: "rename", label: "Rename…" },
    {
      id: "resetName",
      label: "Reset name",
      disabled: !named,
      hint: named ? undefined : "not renamed",
    },
    { id: "close", label: "Close session", separatorBefore: true },
  ]
}
