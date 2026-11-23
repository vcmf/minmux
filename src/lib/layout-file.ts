// layout.json: the full layout, folder entries included, beside workspace.json (which older
// builds read, so it lists terminals only). docs/design/WORKDIR_OBJECTS.md, "Persistence".
//  - Saved together with workspace.json, stamped with a hash of the workspace.json it went with.
//  - Read back whole only when that stamp still matches: no other build saved since.
//  - Otherwise workspace.json wins, and the folder entries whose pane is still there are put back
//    at the end of that pane.
// Pure; main only reads and writes the files.
import type { PaneLeaf, PaneNode, Tab } from "../types"
import type { WorkspaceState } from "./workspace"
import type { FileEntry, FolderEntry, ObjectEntry, FolderView } from "./folder-entries"
import { isTerminalEntry } from "./entries"
import {
  addSurface,
  allPanes,
  findPane,
  findPaneById,
  firstEntryId,
  firstSessionId,
  selectSurface,
} from "./pane-tree"
import { withFocus } from "./tab-focus"

// Still 1 with file entries (step 3a): an older build drops the kinds it doesn't know (file
// tabs) and keeps the folders, and if it saves, the file tabs are gone (quick to reopen). A
// version bump would make it skip the whole file, folder tabs included (WORKDIR_OBJECTS.md).
const VERSION = 1

export interface LayoutState {
  tabs: Tab[]
  activeTabId: string | null
  objects: Record<string, ObjectEntry>
  folderViews: Record<string, FolderView>
}

interface LayoutFile extends LayoutState {
  version: number
  stamp: string // stampOf(the workspace.json saved with it)
}

/** A short hash of a workspace.json's text (FNV-1a, 32 bits): "is it the one we saved with?" */
export function stampOf(text: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

/** layout.json for `state`, saved alongside `workspaceJson`. Only referenced entries go in. */
export function serializeLayout(state: LayoutState, workspaceJson: string): string {
  const used = new Set(state.tabs.flatMap((t) => allPanes(t.root).flatMap((p) => p.entryIds)))
  const objects: Record<string, ObjectEntry> = {}
  const folderViews: Record<string, FolderView> = {}
  for (const id of used) {
    const o = state.objects[id]
    if (o?.kind === "file" && (o.seq !== undefined || o.anchor !== undefined)) {
      const saved: FileEntry = { ...o }
      delete saved.seq // runtime only ("go to the line again")
      delete saved.anchor // …and so is the heading it opened at
      objects[id] = saved
    } else if (o) objects[id] = o
    if (state.folderViews[id]) folderViews[id] = state.folderViews[id]!
  }
  const file: LayoutFile = {
    version: VERSION,
    stamp: stampOf(workspaceJson),
    activeTabId: state.activeTabId,
    tabs: state.tabs,
    objects,
    folderViews,
  }
  return `${JSON.stringify(file, null, 2)}\n`
}

const str = (v: unknown): v is string => typeof v === "string"
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter(str) : [])

function parseObject(v: unknown): ObjectEntry | undefined {
  const o = v as Partial<FileEntry> | Partial<FolderEntry> | null
  if (!o || (o.kind !== "folder" && o.kind !== "file") || !str(o.path) || !o.path) return undefined
  const distro = (o.wsl as { distro?: unknown } | undefined)?.distro
  const wsl = o.wsl && typeof o.wsl === "object" ? { wsl: str(distro) ? { distro } : {} } : {}
  if (o.kind === "folder") return { kind: "folder", path: o.path, ...wsl }
  const f = o as Partial<FileEntry>
  const line = typeof f.line === "number" && f.line > 0 ? { line: Math.floor(f.line) } : {}
  return {
    kind: "file",
    path: o.path,
    ...wsl,
    ...line,
    ...(f.peek === true ? { peek: true } : {}),
    ...(f.view === "diff" || f.view === "source" ? { view: f.view } : {}),
  }
}

/** A saved tree with only the entries `keep` accepts (each placed once); undefined if none. */
function parseNode(
  v: unknown,
  keep: (id: string) => boolean,
  placed: Set<string>,
): PaneNode | undefined {
  const n = v as Record<string, unknown> | null
  if (!n || typeof n !== "object" || !str(n.id)) return undefined
  if (n.type === "leaf") {
    const ids = strings(n.entryIds).filter((id) => keep(id) && !placed.has(id))
    if (!ids.length) return undefined
    ids.forEach((id) => placed.add(id))
    const active = str(n.activeEntryId) && ids.includes(n.activeEntryId) ? n.activeEntryId : ids[0]!
    return { type: "leaf", id: n.id, entryIds: ids, activeEntryId: active }
  }
  if (n.type !== "split" || (n.direction !== "row" && n.direction !== "column")) return undefined
  if (!Array.isArray(n.children) || n.children.length !== 2) return undefined
  const a = parseNode(n.children[0], keep, placed)
  const b = parseNode(n.children[1], keep, placed)
  if (!a || !b) return a ?? b
  return { type: "split", id: n.id, direction: n.direction, children: [a, b] }
}

/** The leaves of a saved tree, unvalidated (for re-adding folders to panes still there). */
function savedLeaves(v: unknown): { id: string; entryIds: string[] }[] {
  const n = v as Record<string, unknown> | null
  if (!n || typeof n !== "object") return []
  if (n.type === "leaf") return str(n.id) ? [{ id: n.id, entryIds: strings(n.entryIds) }] : []
  return Array.isArray(n.children) ? n.children.flatMap(savedLeaves) : []
}

// `ws` is workspace.json's (null when it held no tab). `blocked`: layout.json comes from a newer
// build, so it must not be overwritten.
/** The layout to restore: workspace.json's, completed by layout.json. */
export function restoreLayout(
  ws: WorkspaceState | null,
  wsText: string,
  layoutText: string,
): { state: WorkspaceState | null; blocked: boolean } {
  let file: Partial<LayoutFile>
  try {
    file = JSON.parse(layoutText) as Partial<LayoutFile>
  } catch {
    return { state: ws, blocked: false }
  }
  if (!file || typeof file !== "object") return { state: ws, blocked: false }
  if (typeof file.version === "number" && file.version > VERSION)
    return { state: ws, blocked: true }
  if (!Array.isArray(file.tabs)) return { state: ws, blocked: false }

  const objects: Record<string, ObjectEntry> = {}
  for (const [id, v] of Object.entries(file.objects ?? {})) {
    const o = !isTerminalEntry(id) ? parseObject(v) : undefined
    if (o) objects[id] = o
  }
  const sessions = ws?.sessions ?? {}
  const keep = (id: string) => (isTerminalEntry(id) ? !!sessions[id] : !!objects[id])
  let tabs: Tab[]
  let activeTabId: string | null

  if (file.stamp === stampOf(wsText)) {
    // Nothing else saved since: the full layout.
    const placed = new Set<string>()
    tabs = []
    for (const t of file.tabs as unknown[]) {
      const raw = t as Partial<Tab> | null
      if (!raw || !str(raw.id)) continue
      const root = parseNode(raw.root, keep, placed)
      if (!root) continue
      const focus =
        str(raw.activeEntryId) && findPane(root, raw.activeEntryId)
          ? raw.activeEntryId
          : firstEntryId(root)
      const term =
        str(raw.activeSessionId) &&
        findPane(root, raw.activeSessionId) &&
        isTerminalEntry(raw.activeSessionId)
          ? raw.activeSessionId
          : (firstSessionId(root) ?? "")
      const title = str(raw.title) ? raw.title : ""
      tabs.push(
        withFocus({ id: raw.id, title, root, activeEntryId: focus, activeSessionId: term }, focus),
      )
    }
    activeTabId = tabs.some((t) => t.id === file.activeTabId)
      ? file.activeTabId!
      : (tabs[0]?.id ?? null)
  } else {
    // Another build saved workspace.json since: it wins; put folders back in panes still there.
    if (!ws) return { state: null, blocked: false }
    const placed = new Set<string>()
    tabs = ws.tabs.map((tab) => {
      let root = tab.root
      const shown: string[] = [] // each touched pane's visible entry before
      for (const saved of (file.tabs as unknown[]).flatMap((t) =>
        savedLeaves((t as Tab | null)?.root),
      )) {
        if (!findPaneById(root, saved.id)) continue
        for (const id of saved.entryIds) {
          if (isTerminalEntry(id) || !objects[id] || placed.has(id)) continue
          placed.add(id)
          // What the pane showed in workspace.json (read from its tree, before any add).
          const was = findPaneById(tab.root, saved.id)!.activeEntryId
          if (!shown.includes(was)) shown.push(was)
          root = addSurface(root, saved.id, id)
        }
      }
      // addSurface shows what it adds: keep showing what workspace.json had.
      for (const id of shown) root = selectSurface(root, id)
      return root === tab.root ? tab : withFocus({ ...tab, root }, tab.activeEntryId)
    })
    activeTabId = ws.activeTabId
  }
  if (!tabs.length) return { state: ws, blocked: false }

  const used = new Set(tabs.flatMap((t) => allPanes(t.root).flatMap((p: PaneLeaf) => p.entryIds)))
  const kept: Record<string, ObjectEntry> = {}
  const folderViews: Record<string, FolderView> = {}
  for (const id of used) {
    if (!objects[id]) continue
    kept[id] = objects[id]!
    const v = (file.folderViews as Record<string, Partial<FolderView>> | undefined)?.[id]
    if (v)
      folderViews[id] = {
        expanded: strings(v.expanded),
        showAll: strings(v.showAll),
        ...(v.changesOnly === true ? { changesOnly: true } : {}),
      }
  }
  return {
    state: {
      sessions,
      tabs,
      activeTabId,
      rightPanelWidth: ws?.rightPanelWidth,
      ...(ws?.pruned ? { pruned: ws.pruned } : {}),
      objects: kept,
      folderViews,
    },
    blocked: false,
  }
}
