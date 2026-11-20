// Folder entries (docs/design/WORKDIR_OBJECTS.md, step 2): a pane tab showing a folder on a
// fixed path. The entry itself lives in the store's `objects`, keyed by its `obj-` id; what the
// view has open lives in `folderViews`, apart from `tabs` (a toggle mustn't re-run the WebGL
// reconcile and the layout save that every `tabs` change does). Pure.
import { OBJECT_PREFIX } from "./entries"
import { samePath } from "./agent-dirs"
import type { WslContext } from "./wsl"

/** A folder shown in a pane. */
export interface FolderEntry {
  kind: "folder"
  path: string
  wsl?: WslContext // a WSL pane's folder: a Linux path, read through the distro's share
}

/** A file shown in a pane (step 3a). A peek is replaced by the next peek in its pane. */
export interface FileEntry {
  kind: "file"
  path: string
  wsl?: WslContext
  line?: number // where to scroll when it opens (a path click's `:line`)
  peek?: true
}

/** A pane entry that isn't a terminal. */
export type ObjectEntry = FolderEntry | FileEntry

/** The folder an entry stands in: a folder's own path, a file's parent. */
export function placeOf(o: ObjectEntry): { path: string; wsl?: WslContext } {
  if (o.kind === "folder") return { path: o.path, ...(o.wsl ? { wsl: o.wsl } : {}) }
  const parent = o.path.replace(/[\\/][^\\/]*$/, "") || (o.path.startsWith("/") ? "/" : o.path)
  return { path: parent, ...(o.wsl ? { wsl: o.wsl } : {}) }
}

/** What a folder view has open (folders it expanded, big folders shown in full). */
export interface FolderView {
  expanded: string[]
  showAll: string[]
}

export const EMPTY_VIEW: FolderView = { expanded: [], showAll: [] }

/** A new object id (never a session id). */
export const objectId = (uuid: string) => `${OBJECT_PREFIX}${uuid}`

/** One of a terminal's folders, labelled like the sidebar's lines. */
export interface FolderChoice {
  label: "from" | "in" | "edits"
  path: string
}

// Distinct, in sidebar order: the shell's folder, the agent's, then the checkouts it edits in.
/** The folders ▤+ / "Open folder in…" offer for a terminal. */
export function folderChoices(
  shellCwd: string | undefined,
  agentCwd: string | undefined,
  edits: { shown?: string; more: string[] } | undefined,
): FolderChoice[] {
  const out: FolderChoice[] = []
  const add = (label: FolderChoice["label"], path: string | undefined) => {
    if (path && !out.some((c) => samePath(c.path, path))) out.push({ label, path })
  }
  add("from", shellCwd)
  add("in", agentCwd)
  add("edits", edits?.shown)
  for (const p of edits?.more ?? []) add("edits", p)
  return out
}

/** `view` with `dir` expanded or collapsed; the same view when nothing changes. */
export function toggleExpanded(view: FolderView, dir: string, open: boolean): FolderView {
  const has = view.expanded.includes(dir)
  if (has === open) return view
  return {
    ...view,
    expanded: open ? [...view.expanded, dir] : view.expanded.filter((d) => d !== dir),
  }
}
