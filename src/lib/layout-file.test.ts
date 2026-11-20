import { describe, it, expect } from "vitest"
import { restoreLayout, serializeLayout, stampOf } from "./layout-file"
import { deserializeWorkspace, serializeToJson, type WorkspaceState } from "./workspace"
import { addSurface, allPanes, makeLeaf, splitNode } from "./pane-tree"
import { makeTab, withFocus } from "./tab-focus"
import { objectId, type FolderEntry } from "./folder-entries"
import type { Session } from "../types"

const session = (id: string): Session => ({
  id,
  title: "zsh",
  command: "/bin/zsh",
  args: [],
  status: "idle",
  unread: false,
  cwd: "/w",
})
const F = objectId("f")
const G = objectId("g")
const folder = (path: string): FolderEntry => ({ kind: "folder", path })

// Tab 1: pane p1 [a, F] showing F | pane p2 [G] (folder only). Tab 2: only folders.
const H = objectId("h")
function state(): WorkspaceState & Required<Pick<WorkspaceState, "objects" | "folderViews">> {
  const p1 = addSurface(makeLeaf("p1", "a"), "p1", F)
  const root = splitNode(p1, "a", "row", G, "s", "p2")
  const t1 = withFocus(makeTab("t1", "", root, "a"), F)
  const t2 = makeTab("t2", "", makeLeaf("p3", H), H)
  return {
    sessions: { a: session("a") },
    tabs: [t1, { ...t2, activeSessionId: "" }],
    activeTabId: "t2",
    objects: { [F]: folder("/w/rts"), [G]: folder("/w/docs"), [H]: folder("/w/x") },
    folderViews: { [F]: { expanded: ["/w/rts/src"], showAll: [] } },
  }
}
const save = (s: ReturnType<typeof state>) => {
  const ws = serializeToJson(s)
  return { ws, layout: serializeLayout(s, ws) }
}

describe("layout.json", () => {
  it("stamps are stable and tell files apart", () => {
    expect(stampOf("abc")).toBe(stampOf("abc"))
    expect(stampOf("abc")).not.toBe(stampOf("abd"))
  })

  it("workspace.json lists only panes and tabs with a terminal (older builds read it)", () => {
    const w = JSON.parse(save(state()).ws)
    expect(w.tabs).toHaveLength(1)
    expect(w.tabs[0].root).toMatchObject({ type: "leaf", id: "p1", sessionIds: ["a"] })
    expect(w.activeTabId).toBe("t1") // the folder-only tab isn't there to be active
    // …and an older build reads it as a one-pane layout.
    expect(deserializeWorkspace(w)!.tabs[0]!.root).toMatchObject({ entryIds: ["a"] })
  })

  it("restores everything when workspace.json is the one it was saved with", () => {
    const s = state()
    const { ws, layout } = save(s)
    const r = restoreLayout(deserializeWorkspace(JSON.parse(ws)), ws, layout)
    expect(r.blocked).toBe(false)
    expect(r.state!.tabs).toEqual(s.tabs)
    expect(r.state!.activeTabId).toBe("t2")
    expect(r.state!.objects).toEqual(s.objects)
    expect(r.state!.folderViews).toEqual(s.folderViews)
  })

  it("another build saved since: its layout wins, folders go back to panes still there", () => {
    const s = state()
    const { layout } = save(s)
    // An older build reopened it and added a terminal b to p1, showing b.
    const old = JSON.parse(save(s).ws)
    old.tabs[0].root = {
      type: "leaf",
      id: "p1",
      sessionIds: ["a", "b"],
      activeSessionId: "b",
      sessionId: "b",
    }
    old.tabs[0].activeSessionId = "b"
    old.sessions.push({ ...session("b"), status: undefined })
    const text = JSON.stringify(old)
    const r = restoreLayout(deserializeWorkspace(old), text, layout).state!
    const [p1] = allPanes(r.tabs[0]!.root)
    expect(p1!.entryIds).toEqual(["a", "b", F]) // F back at the end
    expect(p1!.activeEntryId).toBe("b") // still showing what the other build showed
    expect(r.tabs).toHaveLength(1) // the folder-only tab and pane are gone
    expect(Object.keys(r.objects!)).toEqual([F])
  })

  it("only workspace.json's tabs when layout.json is unreadable", () => {
    const { ws } = save(state())
    const base = deserializeWorkspace(JSON.parse(ws))
    expect(restoreLayout(base, ws, "{oops").state).toBe(base)
  })

  it("a newer build's layout.json is ignored and must not be overwritten", () => {
    const { ws } = save(state())
    const base = deserializeWorkspace(JSON.parse(ws))
    const r = restoreLayout(base, ws, JSON.stringify({ version: 99, tabs: [] }))
    expect(r).toEqual({ state: base, blocked: true })
  })

  it("drops entries it can't vouch for: unknown terminals, bad or unknown folders", () => {
    const s = state()
    const { ws, layout } = save(s)
    const file = JSON.parse(layout)
    file.objects[G] = { kind: "folder", path: 42 }
    file.tabs[0].root.children[0].entryIds.push("ghost", objectId("nope"))
    const r = restoreLayout(deserializeWorkspace(JSON.parse(ws)), ws, JSON.stringify(file)).state!
    const ids = r.tabs.flatMap((t) => allPanes(t.root).flatMap((p) => p.entryIds))
    expect(ids).toEqual(["a", F, H]) // G's pane went with G; ghost and nope never came
  })

  it("restores folder-only tabs even when workspace.json had no tab at all", () => {
    const s = state()
    s.tabs = [s.tabs[1]!]
    s.sessions = {}
    s.activeTabId = "t2"
    const { ws, layout } = save(s)
    expect(deserializeWorkspace(JSON.parse(ws))).toBeNull() // no tab an older build could open
    const r = restoreLayout(null, ws, layout).state!
    expect(r.tabs.map((t) => t.id)).toEqual(["t2"])
    expect(r.tabs[0]!.activeSessionId).toBe("")
  })
})
