import { describe, it, expect, beforeEach } from "vitest"
import { reopenFor } from "./lib/remote-reports"
import { useStore, isVisibleIn, isSessionVisible } from "./store"
import { allSessionIds, visibleSessionIds } from "./lib/pane-tree"
import { resetStore, testHost, testShell as shell } from "./test/helpers"
import { hostShellOption } from "./lib/ssh-hosts-ui"
import { RIGHT_PANEL_MIN, RIGHT_PANEL_MAX } from "./lib/right-panel"
import type { ShellOption } from "./types"

const st = () => useStore.getState()
const firstTab = () => st().tabs[0]!
const wslShell: ShellOption = {
  id: "wsl",
  label: "WSL",
  command: "wsl.exe",
  args: ["-d", "Ubuntu"],
}

describe("store — tabs & panes", () => {
  beforeEach(resetStore)

  it("newTab creates a tab + session and makes it active", () => {
    st().newTab(shell)
    expect(st().tabs).toHaveLength(1)
    expect(Object.keys(st().sessions)).toHaveLength(1)
    expect(st().activeTabId).toBe(firstTab().id)
    expect(firstTab().root.type).toBe("leaf")
  })

  it("splitActive adds a second session to the active tab and focuses it", () => {
    st().newTab(shell)
    st().splitActive("row", shell)
    const tab = firstTab()
    const ids = allSessionIds(tab.root)
    expect(ids).toHaveLength(2)
    expect(tab.root.type).toBe("split")
    expect(ids).toContain(tab.activeSessionId) // newest pane is focused
    expect(Object.keys(st().sessions)).toHaveLength(2)
  })

  it("openFolderInSplit splits the active pane with a session rooted at the given cwd", () => {
    st().newTab(shell)
    st().openFolderInSplit("/some/worktree")
    const tab = firstTab()
    expect(tab.root.type).toBe("split")
    expect(allSessionIds(tab.root)).toHaveLength(2)
    // the newly-opened (now active) pane is rooted at the requested folder
    expect(st().sessions[tab.activeSessionId]!.cwd).toBe("/some/worktree")
  })

  it("closeSurface on a single-terminal pane collapses the split back to a leaf", () => {
    st().newTab(shell)
    st().splitActive("row", shell)
    const [firstId] = allSessionIds(firstTab().root)
    st().closeSurface(firstTab().id, firstId!)
    expect(firstTab().root.type).toBe("leaf")
    expect(Object.keys(st().sessions)).toHaveLength(1)
  })

  it("closing the last pane removes the tab, its session, and clears active", () => {
    st().newTab(shell)
    const [only] = allSessionIds(firstTab().root)
    st().closeSurface(firstTab().id, only!)
    expect(st().tabs).toHaveLength(0)
    expect(Object.keys(st().sessions)).toHaveLength(0)
    expect(st().activeTabId).toBeNull()
  })

  it("closeTab removes the tab and all its sessions", () => {
    st().newTab(shell)
    st().splitActive("column", shell)
    st().closeTab(firstTab().id)
    expect(st().tabs).toHaveLength(0)
    expect(Object.keys(st().sessions)).toHaveLength(0)
  })

  it("closeTab picks a surviving tab as active", () => {
    st().newTab(shell)
    const firstId = firstTab().id
    st().newTab(shell)
    st().setActiveTab(firstId)
    st().closeTab(firstId)
    expect(st().tabs).toHaveLength(1)
    expect(st().activeTabId).toBe(st().tabs[0]!.id)
  })

  it("renameTab updates the title", () => {
    st().newTab(shell)
    st().renameTab(firstTab().id, "build")
    expect(firstTab().title).toBe("build")
  })

  it("renameTab trims the name", () => {
    st().newTab(shell)
    st().renameTab(firstTab().id, "  build  ")
    expect(firstTab().title).toBe("build")
  })

  it('renameTab "" unpins the name (the tab shows its live title again)', () => {
    st().newTab(shell)
    st().renameTab(firstTab().id, "build")
    st().renameTab(firstTab().id, "   ")
    expect(firstTab().title).toBe("")
  })

  it("renameTab keeps the same tabs reference when nothing changes", () => {
    st().newTab(shell)
    st().renameTab(firstTab().id, "build")
    const before = st().tabs
    st().renameTab(firstTab().id, "build")
    st().renameTab(firstTab().id, " build ") // trims to the same name
    st().renameTab("no-such-tab", "x")
    expect(st().tabs).toBe(before)
  })

  it("renameTab replaces only the renamed tab", () => {
    st().newTab(shell)
    st().newTab(shell)
    const [a, b] = st().tabs
    st().renameTab(b!.id, "second")
    expect(st().tabs[0]).toBe(a)
    expect(st().tabs[1]!.title).toBe("second")
  })

  it("setActivePane changes the tab's focused session", () => {
    st().newTab(shell)
    st().splitActive("row", shell)
    const ids = allSessionIds(firstTab().root)
    st().setActivePane(firstTab().id, ids[0]!)
    expect(firstTab().activeSessionId).toBe(ids[0])
  })

  it("focusSession finds the pane's tab and makes it active (drives split target)", () => {
    st().newTab(shell)
    st().splitActive("row", shell) // A | B, active = B
    st().splitActive("row", shell) // A | B | C, active = C (last-added)
    const [a, , c] = allSessionIds(firstTab().root)
    expect(firstTab().activeSessionId).toBe(c)

    st().focusSession(a!) // user focuses pane A's terminal (not the last-added one)
    expect(firstTab().activeSessionId).toBe(a)

    // …so the next split targets A: A is no longer a bare leaf, it split into A + new pane.
    st().splitActive("row", shell)
    expect(siblingOfLeaf(firstTab().root, a!)).toBe(firstTab().activeSessionId)
  })
})

/** The leaf id that shares a split node with `target`, if any (else null). */
function siblingOfLeaf(node: import("./types").PaneNode, target: string): string | null {
  if (node.type === "leaf") return null
  const [x, y] = node.children
  if (x.type === "leaf" && x.activeSessionId === target && y.type === "leaf")
    return y.activeSessionId
  if (y.type === "leaf" && y.activeSessionId === target && x.type === "leaf")
    return x.activeSessionId
  return siblingOfLeaf(x, target) ?? siblingOfLeaf(y, target)
}

describe("store — status signals & visibility", () => {
  beforeEach(resetStore)

  const setup = () => {
    st().newTab(shell)
    return allSessionIds(firstTab().root)[0]!
  }

  it("command-start → working, command-end → idle", () => {
    const id = setup()
    st().signalSession(id, { type: "command-start" })
    expect(st().sessions[id]!.status).toBe("working")
    st().signalSession(id, { type: "command-end" })
    expect(st().sessions[id]!.status).toBe("idle")
  })

  it("attention on a hidden session sets attention + unread", () => {
    const id = setup()
    useStore.setState({ windowFocused: false }) // session no longer visible
    st().signalSession(id, { type: "attention" })
    expect(st().sessions[id]!.status).toBe("attention")
    expect(st().sessions[id]!.unread).toBe(true)
  })

  it("output-idle flips a hidden working session to attention (not the focused one)", () => {
    const id = setup()
    st().signalSession(id, { type: "command-start" })
    st().signalSession(id, { type: "output-idle" }) // focused → ignored
    expect(st().sessions[id]!.status).toBe("working")
    useStore.setState({ windowFocused: false }) // now hidden
    st().signalSession(id, { type: "output-idle" })
    expect(st().sessions[id]!.status).toBe("attention")
  })

  it("attention carries a detail (OSC-9 message); reveal clears it", () => {
    const id = setup()
    useStore.setState({ windowFocused: false })
    st().signalSession(id, { type: "attention", detail: "Claude needs your permission" })
    expect(st().sessions[id]!.detail).toBe("Claude needs your permission")
    st().revealTab(firstTab().id)
    expect(st().sessions[id]!.detail).toBeUndefined()
  })

  it("output-idle attention detail defaults to 'needs input'", () => {
    const id = setup()
    st().signalSession(id, { type: "command-start" })
    useStore.setState({ windowFocused: false })
    st().signalSession(id, { type: "output-idle" })
    expect(st().sessions[id]!.detail).toBe("needs input")
  })

  it("focusing a pane (setActivePane) clears its attention", () => {
    const id = setup()
    st().splitActive("row", shell)
    useStore.setState({ windowFocused: false })
    st().signalSession(id, { type: "attention", detail: "needs input" })
    expect(st().sessions[id]!.status).toBe("attention")
    st().setActivePane(firstTab().id, id) // go look at it
    expect(st().sessions[id]!.status).toBe("idle")
    expect(st().sessions[id]!.detail).toBeUndefined()
  })

  it("revealTab clears unread and downgrades attention to idle", () => {
    const id = setup()
    useStore.setState({ windowFocused: false })
    st().signalSession(id, { type: "attention" })
    st().revealTab(firstTab().id)
    expect(st().sessions[id]!.status).toBe("idle")
    expect(st().sessions[id]!.unread).toBe(false)
  })

  it("setWindowFocused(true) reveals the active tab", () => {
    const id = setup()
    useStore.setState({ windowFocused: false })
    st().signalSession(id, { type: "attention" })
    st().setWindowFocused(true)
    expect(st().sessions[id]!.unread).toBe(false)
  })

  it("isVisibleIn / isSessionVisible reflect focus + active tab", () => {
    const id = setup()
    expect(isSessionVisible(id)).toBe(true)
    useStore.setState({ windowFocused: false })
    expect(isSessionVisible(id)).toBe(false)
    useStore.setState({ windowFocused: true, activeTabId: null })
    expect(isVisibleIn(st(), id)).toBe(false)
  })
})

describe("store — cwd & UI toggles", () => {
  beforeEach(resetStore)

  it("setSessionCwd records a session's directory", () => {
    st().newTab(shell)
    const id = allSessionIds(firstTab().root)[0]!
    st().setSessionCwd(id, "/home/u/proj")
    expect(st().sessions[id]!.cwd).toBe("/home/u/proj")
  })

  it("setSessionCwd ignores unknown sessions", () => {
    st().setSessionCwd("nope", "/x")
    expect(st().sessions.nope).toBeUndefined()
  })

  it("toggles paletteOpen / settingsOpen / rightView", () => {
    st().setPaletteOpen(true)
    st().setSettingsOpen(true)
    st().setRightView("changes")
    expect(st().paletteOpen).toBe(true)
    expect(st().settingsOpen).toBe(true)
    expect(st().rightView).toBe("changes")
    st().setRightView(null) // one panel, hidden when null
    expect(st().rightView).toBeNull()
  })

  it("applyAgentEvents folds hook batches into the agent tree", () => {
    st().applyAgentEvents([
      { event: "SessionStart", sessionId: "cs1" },
      { event: "SubagentStart", sessionId: "cs1", agentId: "ca1", agentType: "Explore" },
    ])
    st().applyAgentEvents([{ event: "SubagentStop", sessionId: "cs1", agentId: "ca1" }])
    const g = st().agents
    expect(g.rootIds).toContain("root:cs1")
    expect(g.nodes["root:cs1"]!.childIds).toEqual(["ca1"])
    expect(g.nodes["ca1"]!.status).toBe("done")
  })

  it("setGit stores the latest git status", () => {
    st().setGit({
      isRepo: true,
      root: "",
      branch: "main",
      ahead: 1,
      behind: 0,
      files: [],
      add: 0,
      del: 0,
    })
    expect(st().git?.branch).toBe("main")
  })

  it("setSessionOscTitle records the raw OSC title; ignores empty/unknown", () => {
    st().newTab(shell)
    const id = allSessionIds(firstTab().root)[0]!
    st().setSessionOscTitle(id, "Explore hexgate")
    expect(st().sessions[id]!.oscTitle).toBe("Explore hexgate")
    st().setSessionOscTitle(id, "   ") // blank → ignored
    expect(st().sessions[id]!.oscTitle).toBe("Explore hexgate")
    st().setSessionOscTitle("nope", "x") // unknown → no-op
    expect(st().sessions.nope).toBeUndefined()
  })

  it("newTab starts unpinned (empty tab title)", () => {
    st().newTab(shell)
    expect(firstTab().title).toBe("")
  })

  it("setHome stores $HOME", () => {
    st().setHome("/Users/me")
    expect(st().home).toBe("/Users/me")
  })

  it("splitActive inherits the source pane's cwd", () => {
    st().newTab(shell)
    const src = allSessionIds(firstTab().root)[0]!
    st().setSessionCwd(src, "/proj/a")
    st().splitActive("row", shell)
    const other = allSessionIds(firstTab().root).find((id) => id !== src)!
    expect(st().sessions[other]!.cwd).toBe("/proj/a")
  })

  it("splitActive inherits the source pane's shell, not the list's first (WSL bug)", () => {
    // Windows: shells list is [PowerShell, WSL]; splitting a WSL pane must stay WSL.
    const pwsh = { id: "powershell", label: "PowerShell", command: "powershell.exe", args: [] }
    const wsl = {
      id: "wsl:Ubuntu",
      label: "WSL: Ubuntu",
      command: "wsl.exe",
      args: ["-d", "Ubuntu"],
    }
    useStore.setState({ shells: [pwsh, wsl] })
    st().newTab(wsl) // active pane is WSL
    st().splitActive("row") // no fallback → must inherit WSL
    const created = st().sessions[firstTab().activeSessionId]!
    expect(created.command).toBe("wsl.exe")
    expect(created.args).toEqual(["-d", "Ubuntu"])
  })

  it("newTab inherits the focused terminal's cwd", () => {
    st().newTab(shell)
    const first = allSessionIds(firstTab().root)[0]!
    st().setSessionCwd(first, "/proj/b")
    st().newTab(shell) // focus is still the first tab's session at call time
    const newSession = allSessionIds(st().tabs[1]!.root)[0]!
    expect(st().sessions[newSession]!.cwd).toBe("/proj/b")
  })

  it("restoreWorkspace replaces sessions/tabs/activeTabId", () => {
    st().restoreWorkspace({
      sessions: {
        x: { id: "x", title: "t", command: "/bin/zsh", args: [], status: "idle", unread: false },
      },
      tabs: [
        {
          id: "tb",
          title: "t",
          root: { type: "leaf", id: "px", sessionIds: ["x"], activeSessionId: "x" },
          activeSessionId: "x",
        },
      ],
      activeTabId: "tb",
    })
    expect(st().tabs).toHaveLength(1)
    expect(st().activeTabId).toBe("tb")
    expect(st().sessions.x).toBeDefined()
  })
})

describe("store — right panel width", () => {
  beforeEach(resetStore)

  it("clamps below the min and above the max", () => {
    st().setRightPanelWidth(100)
    expect(st().rightPanelWidth).toBe(RIGHT_PANEL_MIN)
    st().setRightPanelWidth(99999)
    expect(st().rightPanelWidth).toBe(RIGHT_PANEL_MAX)
  })
  it("respects a tighter maxAvail (60% of the window)", () => {
    st().setRightPanelWidth(700, 500)
    expect(st().rightPanelWidth).toBe(500)
  })
})

describe("store — paneRoot (Files-panel root override)", () => {
  beforeEach(resetStore)
  const activeId = () => firstTab().activeSessionId

  it("accepts an absolute host path and normalizes a trailing slash", () => {
    st().newTab(shell)
    st().setPaneRoot(activeId(), "/Users/me/proj/")
    expect(st().paneRoot[activeId()]).toBe("/Users/me/proj")
  })
  it("rejects a non-absolute path", () => {
    st().newTab(shell)
    st().setPaneRoot(activeId(), "relative/x")
    expect(st().paneRoot[activeId()]).toBeUndefined()
  })
  it("accepts a WSL pane's Linux path (read via the distro's UNC share)", () => {
    st().newTab(wslShell)
    st().setPaneRoot(activeId(), "/home/me/proj")
    expect(st().paneRoot[activeId()]).toBe("/home/me/proj")
  })
  it("clearPaneRoot removes the override", () => {
    st().newTab(shell)
    const sid = activeId()
    st().setPaneRoot(sid, "/Users/me/proj")
    st().clearPaneRoot(sid)
    expect(st().paneRoot[sid]).toBeUndefined()
  })
  it("closeSurface drops the closed pane's override, keeps the sibling's", () => {
    st().newTab(shell)
    st().splitActive("row", shell)
    const tab = firstTab()
    const [a, b] = allSessionIds(tab.root)
    st().setPaneRoot(a!, "/Users/me/a")
    st().setPaneRoot(b!, "/Users/me/b")
    st().closeSurface(tab.id, a!)
    expect(st().paneRoot[a!]).toBeUndefined()
    expect(st().paneRoot[b!]).toBe("/Users/me/b")
  })
  it("closeTab drops its panes' overrides", () => {
    st().newTab(shell)
    const tab = firstTab()
    const sid = tab.activeSessionId
    st().setPaneRoot(sid, "/Users/me/proj")
    st().closeTab(tab.id)
    expect(st().paneRoot[sid]).toBeUndefined()
  })
})

describe("store — surfaces (terminal tabs inside a pane)", () => {
  beforeEach(resetStore)

  const pane = () => {
    const root = firstTab().root
    if (root.type !== "leaf") throw new Error("expected a single pane")
    return root
  }

  it("newSurface adds a terminal to the focused pane and focuses it", () => {
    st().newTab(shell)
    const first = firstTab().activeSessionId
    st().setSessionCwd(first, "/proj")
    st().newSurface()
    const p = pane()
    expect(p.sessionIds).toHaveLength(2)
    expect(p.activeSessionId).toBe(firstTab().activeSessionId)
    expect(firstTab().activeSessionId).not.toBe(first)
    // inherits the source terminal's shell + cwd
    expect(st().sessions[p.activeSessionId]).toMatchObject({ command: shell.command, cwd: "/proj" })
  })

  it("newSurface inherits a WSL shell (not the list's first entry)", () => {
    st().newTab(wslShell)
    st().newSurface()
    expect(st().sessions[firstTab().activeSessionId]!.command).toBe("wsl.exe")
  })

  it("newSurface targets only the focused pane of a split", () => {
    st().newTab(shell)
    st().splitActive("row", shell) // A | B, B focused
    const [a] = allSessionIds(firstTab().root)
    st().setActivePane(firstTab().id, a!)
    st().newSurface()
    const root = firstTab().root
    if (root.type !== "split") throw new Error("expected split")
    expect(root.children[0]).toMatchObject({ sessionIds: [a, firstTab().activeSessionId] })
    expect(root.children[1]).toMatchObject({ sessionIds: [expect.any(String)] })
  })

  it("focusing a hidden surface makes it the pane's visible one", () => {
    st().newTab(shell)
    const first = firstTab().activeSessionId
    st().newSurface()
    st().focusSession(first)
    expect(pane().activeSessionId).toBe(first)
    st().newSurface()
    st().setActivePane(firstTab().id, first)
    expect(pane().activeSessionId).toBe(first)
  })

  it("closeSurface of the visible terminal hands focus to its neighbour, keeps the pane", () => {
    st().newTab(shell)
    st().newSurface()
    st().newSurface()
    const [a, b, c] = pane().sessionIds
    st().setActivePane(firstTab().id, b!)
    st().closeSurface(firstTab().id, b!)
    expect(pane().sessionIds).toEqual([a, c])
    expect(firstTab().activeSessionId).toBe(c)
    expect(pane().activeSessionId).toBe(c)
    expect(st().sessions[b!]).toBeUndefined()
  })

  it("closeSurface of a hidden terminal keeps focus where it is", () => {
    st().newTab(shell)
    st().newSurface()
    const [a, b] = pane().sessionIds
    st().closeSurface(firstTab().id, a!)
    expect(firstTab().activeSessionId).toBe(b)
    expect(pane().sessionIds).toEqual([b])
  })

  it("closeSurface of the last terminal of a pane in a split removes the pane", () => {
    st().newTab(shell)
    st().splitActive("row", shell)
    const b = firstTab().activeSessionId
    st().closeSurface(firstTab().id, b)
    expect(firstTab().root.type).toBe("leaf")
    expect(firstTab().activeSessionId).not.toBe(b)
  })

  it("requestClosePane closes a single-terminal pane immediately", () => {
    st().newTab(shell)
    st().splitActive("row", shell)
    const root = firstTab().root
    if (root.type !== "split") throw new Error("expected split")
    st().requestClosePane(firstTab().id, root.children[1].id)
    expect(st().closeConfirm).toBeNull()
    expect(firstTab().root.type).toBe("leaf")
  })

  it("requestClosePane on a multi-terminal pane asks first; cancel keeps it", () => {
    st().newTab(shell)
    st().newSurface()
    const p = pane()
    st().requestClosePane(firstTab().id, p.id)
    expect(st().closeConfirm).toEqual({
      kind: "pane",
      tabId: firstTab().id,
      paneId: p.id,
      count: 2,
    })
    expect(pane().sessionIds).toHaveLength(2) // nothing closed yet
    st().cancelClose()
    expect(st().closeConfirm).toBeNull()
    expect(pane().sessionIds).toHaveLength(2)
  })

  it("confirming closes every terminal in the pane and clears the dialog", () => {
    st().newTab(shell)
    st().splitActive("row", shell) // A | B
    st().newSurface() // B pane: [B, B2]
    const root = firstTab().root
    if (root.type !== "split") throw new Error("expected split")
    const right = root.children[1]
    if (right.type !== "leaf") throw new Error("expected leaf")
    st().setPaneRoot(right.sessionIds[0]!, "/Users/me/b")
    st().requestClosePane(firstTab().id, right.id)
    st().confirmClose()
    expect(st().closeConfirm).toBeNull()
    expect(firstTab().root.type).toBe("leaf")
    for (const id of right.sessionIds) expect(st().sessions[id]).toBeUndefined()
    expect(st().paneRoot[right.sessionIds[0]!]).toBeUndefined()
    expect(allSessionIds(firstTab().root)).toContain(firstTab().activeSessionId)
  })

  it("closePane on the only pane removes the tab", () => {
    st().newTab(shell)
    st().newSurface()
    st().closePane(firstTab().id, pane().id)
    expect(st().tabs).toHaveLength(0)
    expect(Object.keys(st().sessions)).toHaveLength(0)
  })

  it("revealing a tab doesn't clear attention on a hidden surface", () => {
    st().newTab(shell)
    const hidden = firstTab().activeSessionId
    st().newSurface() // `hidden` is now behind the new surface
    st().signalSession(hidden, { type: "attention", detail: "approve?" })
    expect(st().sessions[hidden]!.status).toBe("attention")
    st().revealTab(firstTab().id)
    expect(st().sessions[hidden]!.status).toBe("attention")
    st().focusSession(hidden) // actually looking at it clears it
    expect(st().sessions[hidden]!.status).not.toBe("attention")
  })

  it("a focus click on the already-focused pane leaves `tabs` identity alone", () => {
    st().newTab(shell)
    st().splitActive("row", shell)
    const tabs = st().tabs
    st().setActivePane(firstTab().id, firstTab().activeSessionId)
    st().focusSession(firstTab().activeSessionId)
    expect(st().tabs).toBe(tabs)
  })

  it("closing the focused surface marks the revealed one seen", () => {
    st().newTab(shell)
    const hidden = firstTab().activeSessionId
    st().newSurface()
    st().signalSession(hidden, { type: "attention", detail: "approve?" })
    st().closeSurface(firstTab().id, firstTab().activeSessionId)
    expect(firstTab().activeSessionId).toBe(hidden)
    expect(st().sessions[hidden]!.status).not.toBe("attention")
  })
})

describe("store — drag & drop surfaces", () => {
  beforeEach(resetStore)

  it("moveSurface to another pane's edge splits it and focuses the moved terminal", () => {
    st().newTab(shell)
    st().newSurface() // pane: [a, b]
    const root = firstTab().root
    if (root.type !== "leaf") throw new Error("expected leaf")
    const [a] = root.sessionIds
    st().setDragging({ tabId: firstTab().id, sessionId: a! })
    st().moveSurface(firstTab().id, a!, { paneId: root.id, zone: "right" })
    const after = firstTab().root
    expect(after.type).toBe("split")
    expect(firstTab().activeSessionId).toBe(a)
    expect(st().dragging).toBeNull()
    expect(st().sessions[a!]).toBeDefined() // same session — not respawned
  })

  it("a no-op drop keeps `tabs` identity and just clears the drag", () => {
    st().newTab(shell)
    const root = firstTab().root
    if (root.type !== "leaf") throw new Error("expected leaf")
    const tabs = st().tabs
    st().setDragging({ tabId: firstTab().id, sessionId: root.activeSessionId })
    st().moveSurface(firstTab().id, root.activeSessionId, { paneId: root.id, zone: "left" })
    expect(st().tabs).toBe(tabs)
    expect(st().dragging).toBeNull()
  })

  it("the dropped terminal is marked seen", () => {
    st().newTab(shell)
    const hidden = firstTab().activeSessionId
    st().newSurface()
    st().splitActive("row", shell)
    const target = findRightPane()
    st().signalSession(hidden, { type: "attention", detail: "approve?" })
    st().moveSurface(firstTab().id, hidden, { paneId: target, zone: "center" })
    expect(st().sessions[hidden]!.status).not.toBe("attention")
  })
})

describe("store — stale drops", () => {
  beforeEach(resetStore)
  it("a drop whose surface or target pane is gone only ends the drag", () => {
    st().newTab(shell)
    const root = firstTab().root
    if (root.type !== "leaf") throw new Error("expected leaf")
    const tabs = st().tabs
    st().setDragging({ tabId: firstTab().id, sessionId: "gone" })
    st().moveSurface(firstTab().id, "gone", { paneId: root.id, zone: "center" })
    expect(st().tabs).toBe(tabs) // focus not pointed at a missing session
    expect(st().dragging).toBeNull()
    st().moveSurface(firstTab().id, root.activeSessionId, { paneId: "gone", zone: "left" })
    expect(st().tabs).toBe(tabs)
  })
})

/** The id of the right-hand pane of the first tab's top split. */
function findRightPane(): string {
  const root = firstTab().root
  if (root.type !== "split") throw new Error("expected split")
  return root.children[1].id
}

describe("store — settings", () => {
  beforeEach(resetStore)

  it("updateSettings validates, applies and persists", async () => {
    const { ipc } = await import("./lib/ipc")
    st().updateSettings({ ...st().settings, theme: "gruvbox-light", appearance: "light" })
    expect(st().settings.theme).toBe("gruvbox") // variant name normalized to its family
    expect(st().settingsLoaded).toBe(true)
    expect(ipc.writeSettings).toHaveBeenCalled()
  })
})

describe("store — Claude session accent", () => {
  beforeEach(resetStore)

  it("setAgentMeta stores a pane's meta; null clears it; unknown panes are ignored", () => {
    st().newTab(shell)
    const id = firstTab().activeSessionId
    st().setAgentMeta(id, { color: "orange" })
    expect(st().agentMeta[id]).toEqual({ color: "orange" })
    st().setAgentMeta("ghost", { color: "red" })
    expect(st().agentMeta.ghost).toBeUndefined()
    st().setAgentMeta(id, null)
    expect(st().agentMeta[id]).toBeUndefined()
  })

  it("closing the terminal drops its accent", () => {
    st().newTab(shell)
    st().newSurface()
    const id = firstTab().activeSessionId
    st().setAgentMeta(id, { name: "x" })
    st().closeSurface(firstTab().id, id)
    expect(st().agentMeta[id]).toBeUndefined()
  })
})

describe("store — sidebar branch/PR", () => {
  beforeEach(resetStore)

  it("setPaneGit applies results, clears panes that left their repo, stays quiet on no change", () => {
    st().newTab(shell)
    const id = firstTab().activeSessionId
    st().setPaneGit({ [id]: { branch: "main" } }, [id])
    expect(st().paneGit[id]).toEqual({ branch: "main" })
    const before = st().paneGit
    st().setPaneGit({ [id]: { branch: "main" } }, [id])
    expect(st().paneGit).toBe(before)
    st().setPaneGit({}, [id]) // polled, no result → cd'd out of the repo
    expect(st().paneGit[id]).toBeUndefined()
  })

  it("setPaneGit ignores terminals that closed while the poll was in flight", () => {
    st().setPaneGit({ ghost: { branch: "main" } }, ["ghost"])
    expect(st().paneGit.ghost).toBeUndefined()
  })
})

describe("store — resume banner state", () => {
  beforeEach(resetStore)
  it("setResume sets/clears per terminal, ignores unknown panes, drops with the terminal", () => {
    st().newTab(shell)
    const id = firstTab().activeSessionId
    const plan = { status: "resume" as const, sessionId: "x", cwd: "/r" }
    st().setResume("ghost", { phase: "pending", plan })
    expect(st().resume.ghost).toBeUndefined()
    st().setResume(id, { phase: "pending", plan })
    expect(st().resume[id]?.phase).toBe("pending")
    st().closeTab(firstTab().id)
    expect(st().resume[id]).toBeUndefined()
  })
})

describe("splitPaneAt", () => {
  it("splits beside that pane in its tab, as shown (no surface swap), focusing the new one", () => {
    st().newTab(shell)
    const tabA = st().tabs[0]!
    const shown = tabA.activeSessionId
    st().newSurface(shell) // a second surface now shown in the pane
    const visible = st().tabs[0]!.activeSessionId
    st().setActivePane(tabA.id, shown) // show the first again → `visible` is now hidden
    const hidden = visible
    st().newTab(shell) // another tab is active
    st().splitPaneAt(hidden, "/x")
    const tab = st().tabs[0]!
    expect(st().activeTabId).toBe(tab.id)
    expect(allSessionIds(tab.root)).toHaveLength(3)
    expect(st().sessions[tab.activeSessionId]?.cwd).toBe("/x")
    // the pane still shows the surface it showed
    expect(visibleSessionIds(tab.root)).toContain(shown)
  })

  it("no-op when the pane is gone", () => {
    st().newTab(shell)
    const before = st().tabs
    st().splitPaneAt("nope", "/x")
    expect(st().tabs).toBe(before)
  })
})

describe("store — ssh remote sessions", () => {
  beforeEach(resetStore)

  const remote = { hostId: "native:web", label: "web", target: "web", env: "native" as const }
  const sshShell: ShellOption = {
    id: "native:web",
    label: "web",
    command: "ssh",
    args: ["web"],
    remote,
  }
  const focused = () => st().sessions[firstTab().activeSessionId]!

  it("a tab opened on a host is a remote session with no local cwd", () => {
    st().setShells([shell])
    st().newTab(sshShell)
    expect(focused().remote).toEqual(remote)
    expect(focused().remote).not.toBe(remote) // copied, not aliased
    expect(focused().cwd).toBeUndefined()
  })

  it("splits and new surfaces from an ssh pane stay on the same host", () => {
    st().setShells([shell])
    st().newTab(sshShell)
    st().splitActive("row", shell)
    expect(focused().remote?.hostId).toBe("native:web")
    st().newSurface(shell)
    expect(focused().remote?.hostId).toBe("native:web")
    expect(Object.values(st().sessions).every((x) => x.remote?.hostId === "native:web")).toBe(true)
  })

  it("ignores OSC 7 cwd reports from a remote shell (the path is on the host)", () => {
    st().newTab(sshShell)
    const id = focused().id
    st().setSessionCwd(id, "/home/remote/project")
    expect(st().sessions[id]!.cwd).toBeUndefined()
  })

  it("opening a local folder beside an ssh pane uses a local shell", () => {
    st().setShells([shell])
    st().newTab(sshShell)
    const sshId = focused().id
    st().openFolderInSplit("/Users/me/proj")
    expect(focused().remote).toBeUndefined()
    expect(focused().command).toBe(shell.command)
    expect(focused().cwd).toBe("/Users/me/proj")
    st().splitPaneAt(sshId, "/Users/me/other")
    expect(focused().remote).toBeUndefined()
    expect(focused().cwd).toBe("/Users/me/other")
  })

  it("local panes still split into their own shell", () => {
    st().setShells([shell, wslShell])
    st().newTab(wslShell)
    st().openFolderInSplit("/home/me")
    expect(focused().command).toBe("wsl.exe")
  })
})

describe("store — an unreadable saved host", () => {
  beforeEach(resetStore)

  it("a split keeps the saved original", () => {
    const remote = {
      hostId: "unavailable",
      label: "ssh",
      target: "unavailable",
      env: "native" as const,
    }
    const saved = { hostId: "wsl2:x:y", env: "new-kind" }
    st().setShells([shell])
    st().newTab({
      id: "unavailable",
      label: "ssh",
      command: "ssh",
      args: [],
      remote,
      remoteSaved: saved,
    })
    st().splitActive("row", shell)
    const s = st().sessions[firstTab().activeSessionId]!
    expect(s.remote?.hostId).toBe("unavailable")
    expect(s.remoteSaved).toEqual(saved)
  })
})

describe("store — ssh hosts", () => {
  beforeEach(resetStore)

  it("setSshHosts keeps the same reference when the list didn't change", () => {
    st().setSshHosts([testHost("web")])
    const before = st().sshHosts
    st().setSshHosts([testHost("web")])
    expect(st().sshHosts).toBe(before)
    st().setSshHosts([testHost("web"), testHost("db")])
    expect(st().sshHosts.map((h) => h.label)).toEqual(["web", "db"])
  })

  it("a new tab on a host is a remote session with no local cwd", () => {
    st().setShells([shell])
    st().newTab(shell)
    const local = st().tabs[0]!.activeSessionId
    st().setSessionCwd(local, "/repo")
    st().newTab(hostShellOption(testHost("web")))
    const s = st().sessions[st().tabs[1]!.activeSessionId]!
    expect(s.remote).toEqual({ hostId: "native:web", label: "web", target: "web", env: "native" })
    expect(s.cwd).toBeUndefined()
  })

  it("splitWith splits a local pane onto the host (not the source's shell or cwd)", () => {
    st().setShells([shell])
    st().newTab(shell)
    const local = st().tabs[0]!.activeSessionId
    st().setSessionCwd(local, "/repo")
    st().splitWith("row", hostShellOption(testHost("web")))
    const tab = firstTab()
    expect(allSessionIds(tab.root)).toHaveLength(2)
    const s = st().sessions[tab.activeSessionId]!
    expect(s.remote?.hostId).toBe("native:web")
    expect(s.cwd).toBeUndefined()
    expect(st().sessions[local]!.remote).toBeUndefined()
  })

  it("splitWith a local shell from an ssh pane stays local", () => {
    st().setShells([shell])
    st().newTab(hostShellOption(testHost("web")))
    st().splitWith("column", shell)
    expect(st().sessions[firstTab().activeSessionId]!.remote).toBeUndefined()
  })

  it("splitWith with no tab opens one", () => {
    st().splitWith("row", hostShellOption(testHost("web")))
    expect(st().tabs).toHaveLength(1)
    expect(st().sessions[firstTab().activeSessionId]!.remote?.hostId).toBe("native:web")
  })
})

describe("store — setSshHosts notifies only on a change", () => {
  beforeEach(resetStore)

  it("the first answer marks the list loaded, even an empty one", () => {
    expect(st().sshHostsLoaded).toBe(false)
    st().setSshHosts([])
    expect(st().sshHostsLoaded).toBe(true)
  })

  it("an identical list doesn't notify subscribers", () => {
    st().setSshHosts([testHost("web")])
    let calls = 0
    const off = useStore.subscribe(() => calls++)
    st().setSshHosts([testHost("web")])
    expect(calls).toBe(0)
    st().setSshHosts([testHost("db")])
    expect(calls).toBe(1)
    off()
  })
})

describe("store — remote connection state", () => {
  beforeEach(resetStore)

  it("setRemotePhase records the phase and keeps the same state when unchanged", () => {
    st().newTab(hostShellOption(testHost("web")))
    const id = firstTab().activeSessionId
    st().setRemotePhase(id, "closed")
    expect(st().remotePhase[id]).toBe("closed")
    const before = useStore.getState()
    st().setRemotePhase(id, "closed")
    expect(useStore.getState()).toBe(before)
    st().setRemotePhase(id, "live")
    expect(st().remotePhase[id]).toBe("live")
  })

  it("never records a phase for a session that's gone (a late answer after a close)", () => {
    st().setRemotePhase("gone", "failed")
    expect(st().remotePhase).toEqual({})
  })

  it("closing the pane drops its state", () => {
    st().newTab(hostShellOption(testHost("web")))
    const id = firstTab().activeSessionId
    st().setRemotePhase(id, "waiting")
    st().closeTab(firstTab().id)
    expect(st().remotePhase).toEqual({})
  })

  it("restoreWorkspace marks remote sessions restored (only those) and resets idle state", () => {
    st().newTab(hostShellOption(testHost("web")))
    st().setRemotePhase(firstTab().activeSessionId, "closed")
    const remote = { ...hostShellOption(testHost("db")).remote! }
    st().restoreWorkspace({
      sessions: {
        r: { id: "r", title: "", command: "ssh", args: [], status: "idle", unread: false, remote },
        l: { id: "l", title: "", command: "/bin/sh", args: [], status: "idle", unread: false },
      },
      tabs: [
        {
          id: "t",
          title: "",
          root: { type: "leaf", id: "p", sessionIds: ["r", "l"], activeSessionId: "r" },
          activeSessionId: "r",
        },
      ],
      activeTabId: "t",
    })
    expect(st().sessions.r!.restored).toBe(true)
    expect(st().sessions.l!.restored).toBeUndefined()
    expect(st().remotePhase).toEqual({})
  })

  it("a split from a restored pane is not itself restored", () => {
    const remote = { ...hostShellOption(testHost("db")).remote! }
    st().restoreWorkspace({
      sessions: {
        r: { id: "r", title: "", command: "ssh", args: [], status: "idle", unread: false, remote },
      },
      tabs: [
        {
          id: "t",
          title: "",
          root: { type: "leaf", id: "p", sessionIds: ["r"], activeSessionId: "r" },
          activeSessionId: "r",
        },
      ],
      activeTabId: "t",
    })
    st().splitActive("row", shell)
    const s = st().sessions[firstTab().activeSessionId]!
    expect(s.remote?.hostId).toBe("native:db")
    expect(s.restored).toBeUndefined()
  })
})

describe("store — remote detail", () => {
  beforeEach(resetStore)

  it("records the detail with the phase, clears it with the next phase, and drops it on close", () => {
    st().newTab(hostShellOption(testHost("web")))
    const id = firstTab().activeSessionId
    st().setRemotePhase(id, "prompt", "password")
    expect(st().remoteDetail[id]).toBe("password")
    const before = useStore.getState()
    st().setRemotePhase(id, "prompt", "password")
    expect(useStore.getState()).toBe(before) // unchanged → no notify
    st().setRemotePhase(id, "prompt", "host key")
    expect(st().remoteDetail[id]).toBe("host key")
    st().setRemotePhase(id, "live")
    expect(st().remoteDetail[id]).toBeUndefined()
    st().setRemotePhase(id, "failed", "host-gone")
    st().closeTab(firstTab().id)
    expect(st().remoteDetail).toEqual({})
  })
})

describe("store — remote detail keeps its reference", () => {
  beforeEach(resetStore)

  it("a phase change with the same (no) detail doesn't reallocate remoteDetail", () => {
    st().newTab(hostShellOption(testHost("web")))
    const id = firstTab().activeSessionId
    st().setRemotePhase(id, "starting")
    const before = st().remoteDetail
    st().setRemotePhase(id, "live")
    expect(st().remoteDetail).toBe(before)
    expect(st().remotePhase[id]).toBe("live")
  })
})

describe("store — opening, pinning and hiding hosts", () => {
  beforeEach(resetStore)

  it("openHost opens a tab or a split and remembers the host as recent", () => {
    st().setShells([shell])
    const web = testHost("web")
    st().openHost(web, "tab")
    expect(st().sessions[firstTab().activeSessionId]!.remote?.hostId).toBe("native:web")
    st().openHost(testHost("db"), "row")
    expect(allSessionIds(firstTab().root)).toHaveLength(2)
    expect(st().sshRecent).toEqual(["native:db", "native:web"])
  })

  it("openHost never opens a hidden host", () => {
    st().openHost({ ...testHost("github.com"), hidden: true }, "tab")
    expect(st().tabs).toHaveLength(0)
  })

  it("pin and hide write the ssh settings", () => {
    st().toggleHostPinned("native:web")
    expect(st().settings.ssh.pinned).toEqual(["native:web"])
    st().toggleHostPinned("native:web")
    expect(st().settings.ssh.pinned).toEqual([])
    st().setHostHidden("github.com", false) // a default-hidden git host, shown again
    expect(st().settings.ssh.hidden).not.toContain("github.com")
    st().setHostHidden("web", true)
    expect(st().settings.ssh.hidden).toContain("web")
  })
})

describe("store — overlays and default-hidden hosts", () => {
  beforeEach(resetStore)

  it("the palette and the host picker never stack", () => {
    st().setHostPickerOpen(true)
    st().setPaletteOpen(true)
    expect(st().hostPickerOpen).toBe(false)
    st().setHostPickerOpen(true)
    expect(st().paletteOpen).toBe(false)
  })

  it("showing a default-hidden git host records it in `shown`; hiding it again undoes that", () => {
    st().setHostHidden("GitHub.com", false)
    expect(st().settings.ssh.shown).toEqual(["GitHub.com"])
    st().setHostHidden("github.com", true)
    expect(st().settings.ssh.shown).toEqual([])
    expect(st().settings.ssh.hidden).toEqual(["github.com"])
  })

  it("hiding and showing your own host touches only `hidden`", () => {
    st().setHostHidden("web", true)
    st().setHostHidden("web", false)
    expect(st().settings.ssh.hidden).toEqual([])
    expect(st().settings.ssh.shown).toEqual([])
  })
})

describe("store — restore after a renderer reload", () => {
  beforeEach(resetStore)

  it("an ssh pane still live in main isn't marked restored (nothing is waiting)", () => {
    const remote = { ...hostShellOption(testHost("db")).remote! }
    const ses = (id: string) => ({
      id,
      title: "",
      command: "ssh",
      args: [],
      status: "idle" as const,
      unread: false,
      remote,
    })
    st().restoreWorkspace(
      {
        sessions: { r: ses("r"), l: ses("l") },
        tabs: [
          {
            id: "t",
            title: "",
            root: { type: "leaf", id: "p", sessionIds: ["r", "l"], activeSessionId: "r" },
            activeSessionId: "r",
          },
        ],
        activeTabId: "t",
      },
      ["l"],
    )
    expect(st().sessions.r!.restored).toBe(true)
    expect(st().sessions.l!.restored).toBeUndefined()
  })
})

describe("store — remote folder", () => {
  beforeEach(resetStore)

  it("setRemoteCwd records an ssh pane's folder (same state when unchanged); local panes never", () => {
    st().setShells([shell])
    st().newTab(hostShellOption(testHost("web")))
    const r = firstTab().activeSessionId
    st().setRemoteCwd(r, "~/proj")
    expect(st().sessions[r]!.remoteCwd).toBe("~/proj")
    expect(st().sessions[r]!.cwd).toBeUndefined() // local panels never see it
    const before = useStore.getState()
    st().setRemoteCwd(r, "~/proj")
    expect(useStore.getState()).toBe(before)
    st().newTab(shell)
    const l = st().tabs[1]!.activeSessionId
    st().setRemoteCwd(l, "/x")
    expect(st().sessions[l]!.remoteCwd).toBeUndefined()
    st().setRemoteCwd(r, undefined) // unknown again (a new connection)
    expect(st().sessions[r]).not.toHaveProperty("remoteCwd")
  })

  it("setRemoteCwd marks a folder our integrated shell reported, and unmarks one that isn't", () => {
    st().setShells([shell])
    st().newTab(hostShellOption(testHost("web")))
    const r = firstTab().activeSessionId
    st().setRemoteCwd(r, "/srv/app", true, "web")
    expect(st().sessions[r]).toMatchObject({
      remoteCwd: "/srv/app",
      remoteCwdVerified: true,
      remoteCwdHost: "web",
    })
    const before = useStore.getState()
    st().setRemoteCwd(r, "/srv/app", true, "web")
    expect(useStore.getState()).toBe(before)
    st().setRemoteCwd(r, "/srv/app") // same folder, but from an untagged report
    expect(st().sessions[r]).not.toHaveProperty("remoteCwdVerified")
    expect(st().sessions[r]).not.toHaveProperty("remoteCwdHost")
    st().setRemoteCwd(r, "/srv/app", true) // no host: nothing to vouch for
    expect(st().sessions[r]).not.toHaveProperty("remoteCwdVerified")
    st().setRemoteCwd(r, undefined, true, "web")
    expect(st().sessions[r]).not.toHaveProperty("remoteCwdVerified")
  })

  it("the folder to reopen: kept until the shell verifiably reports, and inherited by splits", () => {
    st().setShells([shell])
    st().newTab(hostShellOption(testHost("web")))
    const r = firstTab().activeSessionId
    st().setReopenCwd(r, { dir: "/srv/app", host: "web" })
    expect(reopenFor(st().sessions[r])).toEqual({ dir: "/srv/app", host: "web" })
    st().setRemoteCwd(r, "/srv/unverified") // the shell is elsewhere: never reopen /srv/app,
    expect(reopenFor(st().sessions[r])).toBeUndefined() // …and an unverified one never either
    st().setReopenCwd(r, { dir: "/srv/app", host: "web" })
    st().setRemoteCwd(r, undefined, true, "web") // it moved somewhere we won't reopen
    expect(st().sessions[r]).not.toHaveProperty("reopenCwd")
    st().setReopenCwd(r, { dir: "/srv/app", host: "web" })
    st().setRemoteCwd(r, undefined) // a new connection starting: not a report, keeps it
    expect(reopenFor(st().sessions[r])).toEqual({ dir: "/srv/app", host: "web" })
    st().setRemoteCwd(r, "/srv/now", true, "web")
    expect(st().sessions[r]).not.toHaveProperty("reopenCwd") // the live one wins now
    expect(reopenFor(st().sessions[r])).toEqual({ dir: "/srv/now", host: "web" })
    st().splitActive("row")
    const split = firstTab().activeSessionId
    expect(split).not.toBe(r)
    expect(st().sessions[split]!.reopenCwd).toEqual({ dir: "/srv/now", host: "web" })
    expect(st().sessions[split]).not.toHaveProperty("remoteCwd") // not known until it says
    st().newSurface()
    const surf = firstTab().activeSessionId
    expect(st().sessions[surf]!.reopenCwd).toEqual({ dir: "/srv/now", host: "web" })
  })

  it("a host picked by hand (not a split) opens at home, and local panes never reopen", () => {
    st().setShells([shell])
    st().newTab(hostShellOption(testHost("web")))
    const r = firstTab().activeSessionId
    st().setRemoteCwd(r, "/srv/now", true, "web")
    st().splitWith("row", hostShellOption(testHost("web")))
    expect(st().sessions[firstTab().activeSessionId]).not.toHaveProperty("reopenCwd")
    st().newTab(shell)
    const l = st().tabs[1]!.activeSessionId
    st().setReopenCwd(l, { dir: "/x", host: "h" })
    expect(st().sessions[l]).not.toHaveProperty("reopenCwd")
  })
})

describe("closing a session / a terminal asks first when it'd kill work", () => {
  beforeEach(() => resetStore())
  const running = (id: string) =>
    useStore.setState((x) => ({
      sessions: { ...x.sessions, [id]: { ...x.sessions[id]!, running: true } },
    }))

  it("a session with one idle terminal closes right away", () => {
    st().newTab(shell)
    st().requestCloseTab(firstTab().id)
    expect(st().tabs).toHaveLength(0)
    expect(st().closeConfirm).toBeNull()
  })

  it("a session with several terminals always asks (top bar and sidebar share this)", () => {
    st().newTab(shell)
    st().splitActive("row")
    st().requestCloseTab(firstTab().id)
    expect(st().closeConfirm).toMatchObject({ kind: "tab", count: 2 })
    expect(st().tabs).toHaveLength(1)
    st().confirmClose()
    expect(st().tabs).toHaveLength(0)
  })

  it("a pane's header × on its only terminal follows the terminal rule (Claude → ask)", () => {
    st().newTab(shell)
    st().splitActive("row")
    const root = firstTab().root
    if (root.type !== "split" || root.children[1]!.type !== "leaf")
      throw new Error("expected split")
    const right = root.children[1]
    st().applyAgentEvents([
      { event: "SessionStart", sessionId: "c", paneId: right.sessionIds[0]!, nested: false },
    ])
    st().requestClosePane(firstTab().id, right.id)
    expect(st().closeConfirm).toMatchObject({ kind: "terminal", agent: "claude" })
  })

  it("a pending confirm is dropped when its target closes some other way", () => {
    st().newTab(shell)
    st().splitActive("row")
    const [a] = allSessionIds(firstTab().root)
    running(a!)
    st().requestCloseTerminal(firstTab().id, a!)
    expect(st().closeConfirm).not.toBeNull()
    st().closeSurface(firstTab().id, a!) // e.g. its shell exited
    expect(st().closeConfirm).toBeNull()
  })

  it("a single terminal that's running asks too; cancel keeps everything", () => {
    st().newTab(shell)
    running(firstTab().activeSessionId)
    st().requestCloseTab(firstTab().id)
    expect(st().closeConfirm).toMatchObject({ kind: "tab", count: 1 })
    st().cancelClose()
    expect(st().tabs).toHaveLength(1)
  })

  it("a terminal closes right away when idle, and asks while running (or with Claude)", () => {
    st().newTab(shell)
    st().splitActive("row")
    const [a, b] = allSessionIds(firstTab().root)
    st().requestCloseTerminal(firstTab().id, a!)
    expect(allSessionIds(firstTab().root)).toEqual([b])
    st().applyAgentEvents([{ event: "SessionStart", sessionId: "c", paneId: b!, nested: false }])
    st().newSurface()
    st().requestCloseTerminal(firstTab().id, b!)
    expect(st().closeConfirm).toMatchObject({ kind: "terminal", sessionId: b, agent: "claude" })
    st().confirmClose()
    expect(allSessionIds(firstTab().root)).not.toContain(b)
  })
})

describe("store — the shell-integration hint on an ssh split", () => {
  beforeEach(() => resetStore())
  const ssh = (over: object) => {
    const settings = st().settings
    useStore.setState({ settings: { ...settings, ssh: { ...settings.ssh, ...over } } })
  }
  const openWeb = () => {
    st().setShells([shell])
    st().newTab(hostShellOption(testHost("web")))
  }

  it("a split of a host you never chose for offers it, on the new pane", () => {
    openWeb()
    const src = st().tabs[0]!.activeSessionId
    st().splitActive("row")
    const split = st().tabs[0]!.activeSessionId
    expect(split).not.toBe(src)
    expect(st().integrationHint).toEqual({ sessionId: split, alias: "web", state: "ask" })
  })

  it("never on a local split, a hand-picked host, a host you decided for, or when not asking", () => {
    st().setShells([shell])
    st().newTab(shell)
    st().splitActive("row")
    expect(st().integrationHint).toBeNull()
    openWeb()
    st().splitWith("row", hostShellOption(testHost("web"))) // picked from the host list
    expect(st().integrationHint).toBeNull()
    for (const over of [
      { integration: ["web"] },
      { integration: ["!web"] },
      { integrationMode: "all" },
      { integrationMode: "off" },
    ]) {
      resetStore()
      ssh(over)
      openWeb()
      st().splitActive("row")
      expect(st().integrationHint).toBeNull()
    }
  })

  it("Turn on writes the host's entry and says when it applies; Don't ask again writes !alias", () => {
    openWeb()
    st().splitActive("row")
    st().answerIntegrationHint("on")
    expect(st().settings.ssh.integration).toEqual(["web"])
    expect(st().integrationHint).toMatchObject({ alias: "web", state: "on" })
    resetStore()
    openWeb()
    st().splitActive("row")
    st().answerIntegrationHint("never")
    expect(st().settings.ssh.integration).toEqual(["!web"])
    expect(st().integrationHint).toBeNull()
  })

  it("Not now: gone, and not asked again for that host this run", () => {
    openWeb()
    st().splitActive("row")
    st().answerIntegrationHint("dismiss")
    expect(st().integrationHint).toBeNull()
    expect(st().settings.ssh.integration).toEqual([])
    st().newSurface()
    expect(st().integrationHint).toBeNull()
  })

  it("stays on the split it was offered on (a second split doesn't move it)", () => {
    openWeb()
    st().splitActive("row")
    const first = st().integrationHint!.sessionId
    st().splitActive("row")
    expect(st().integrationHint!.sessionId).toBe(first)
  })

  it("goes with its pane when that pane closes (and a later split asks again)", () => {
    openWeb()
    st().splitActive("row")
    const tab = st().tabs[0]!
    st().closeSurface(tab.id, st().integrationHint!.sessionId)
    expect(st().integrationHint).toBeNull()
    st().splitActive("row")
    expect(st().integrationHint).not.toBeNull()
  })

  it("decided meanwhile (Settings → Off): Turn on writes nothing", () => {
    openWeb()
    st().splitActive("row")
    ssh({ integrationMode: "off" })
    st().answerIntegrationHint("on")
    expect(st().settings.ssh.integration).toEqual([])
    expect(st().integrationHint).toBeNull()
  })
})

describe("reordering sessions", () => {
  beforeEach(() => resetStore())
  const order = () => st().tabs.map((t) => t.id)
  it("moveTab lands before the given index; a no-op keeps the same tabs array", () => {
    st().newTab(shell)
    st().newTab(shell)
    st().newTab(shell)
    const [a, b, c] = order()
    st().moveTab(a!, 3)
    expect(order()).toEqual([b, c, a])
    const before = st().tabs
    st().moveTab(c!, 1) // c is at 1: before or after itself → nothing
    expect(st().tabs).toBe(before)
  })
  it("moveActiveTab steps the focused session left / right, stopping at the ends", () => {
    st().newTab(shell)
    st().newTab(shell) // active = the second
    const [a, b] = order()
    st().moveActiveTab(-1)
    expect(order()).toEqual([b, a])
    st().moveActiveTab(-1) // already first
    expect(order()).toEqual([b, a])
    st().moveActiveTab(1)
    expect(order()).toEqual([a, b])
  })
})
