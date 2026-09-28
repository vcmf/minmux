import { describe, it, expect } from "vitest"
import {
  serializeWorkspace,
  deserializeWorkspace,
  migratePaneNode,
  parseWorkspace,
  readWorkspaceFile,
  restoreRemote,
  serializeToJson,
} from "./workspace"
import type { WorkspaceState } from "./workspace"
import type { Session, Tab } from "../types"

const session: Session = {
  id: "s1",
  title: "zsh",
  command: "/bin/zsh",
  args: ["-l"],
  status: "working", // runtime — must NOT be persisted
  unread: true,
  cwd: "/proj",
}
const tab: Tab = {
  id: "t1",
  title: "zsh",
  root: { type: "leaf", id: "p1", sessionIds: ["s1"], activeSessionId: "s1" },
  activeSessionId: "s1",
}
const state: WorkspaceState = { sessions: { s1: session }, tabs: [tab], activeTabId: "t1" }

describe("workspace serialize/deserialize", () => {
  it("serialize drops runtime status/unread but keeps layout + spawn info", () => {
    const w = serializeWorkspace(state)
    expect(w.version).toBe(2)
    expect(w.activeTabId).toBe("t1")
    expect(w.sessions[0]).toEqual({
      id: "s1",
      title: "zsh",
      command: "/bin/zsh",
      args: ["-l"],
      cwd: "/proj",
    })
    expect(w.sessions[0]).not.toHaveProperty("status")
  })

  it("round-trips through JSON, resetting status to idle", () => {
    const restored = parseWorkspace(serializeToJson(state))!
    expect(restored.tabs).toHaveLength(1)
    expect(restored.activeTabId).toBe("t1")
    expect(restored.sessions.s1).toMatchObject({
      command: "/bin/zsh",
      cwd: "/proj",
      status: "idle",
      unread: false,
    })
  })

  it("falls back activeTabId to the first tab when stale", () => {
    const restored = deserializeWorkspace({ ...serializeWorkspace(state), activeTabId: "gone" })!
    expect(restored.activeTabId).toBe("t1")
  })

  it("round-trips rightPanelWidth (clamped), and omits it when unset", () => {
    const withWidth = parseWorkspace(serializeToJson({ ...state, rightPanelWidth: 500 }))!
    expect(withWidth.rightPanelWidth).toBe(500)
    // clamped on restore (a bad persisted value can't set an absurd width)
    const clamped = deserializeWorkspace({ ...serializeWorkspace(state), rightPanelWidth: 5000 })!
    expect(clamped.rightPanelWidth).toBe(760)
    // absent → undefined (restore keeps the store default)
    expect(serializeWorkspace(state)).not.toHaveProperty("rightPanelWidth")
    expect(parseWorkspace(serializeToJson(state))!.rightPanelWidth).toBeUndefined()
  })

  it("rejects malformed / empty input", () => {
    expect(deserializeWorkspace(null)).toBeNull()
    expect(deserializeWorkspace({})).toBeNull()
    expect(deserializeWorkspace({ tabs: [], sessions: [] })).toBeNull()
    expect(deserializeWorkspace({ tabs: [{ id: "t" }], sessions: [] })).toBeNull() // tab w/o root
    expect(parseWorkspace("")).toBeNull()
    expect(parseWorkspace("not json")).toBeNull()
  })
})

describe("workspace v1 → v2 pane migration", () => {
  const v1 = {
    version: 1,
    activeTabId: "t1",
    tabs: [
      {
        id: "t1",
        title: "",
        root: {
          type: "split",
          id: "sp",
          direction: "row",
          children: [
            { type: "leaf", sessionId: "a" },
            { type: "leaf", sessionId: "b" },
          ],
        },
        activeSessionId: "b",
      },
    ],
    sessions: [
      { id: "a", title: "zsh", command: "/bin/zsh", args: [] },
      { id: "b", title: "zsh", command: "/bin/zsh", args: [] },
    ],
  }

  it("turns each v1 leaf into a single-surface pane with a deterministic id", () => {
    const restored = deserializeWorkspace(v1)!
    const root = restored.tabs[0]!.root
    expect(root).toEqual({
      type: "split",
      id: "sp",
      direction: "row",
      children: [
        { type: "leaf", id: "pane-a", sessionIds: ["a"], activeSessionId: "a" },
        { type: "leaf", id: "pane-b", sessionIds: ["b"], activeSessionId: "b" },
      ],
    })
    expect(restored.tabs[0]!.activeSessionId).toBe("b")
  })

  it("round-trips a multi-surface pane, keeping the visible surface", () => {
    const multi: WorkspaceState = {
      sessions: { s1: session, s2: { ...session, id: "s2" } },
      tabs: [
        {
          id: "t1",
          title: "",
          root: { type: "leaf", id: "p1", sessionIds: ["s1", "s2"], activeSessionId: "s2" },
          activeSessionId: "s2",
        },
      ],
      activeTabId: "t1",
    }
    const restored = parseWorkspace(serializeToJson(multi))!
    expect(restored.tabs[0]!.root).toEqual(multi.tabs[0]!.root)
  })

  it("repairs a focused session that isn't in the tab (falls back to the first pane)", () => {
    const restored = deserializeWorkspace({
      ...v1,
      tabs: [{ ...v1.tabs[0]!, activeSessionId: "gone" }],
    })!
    expect(restored.tabs[0]!.activeSessionId).toBe("a")
  })

  it("focusing a hidden surface on restore makes it the pane's visible one", () => {
    const restored = deserializeWorkspace({
      version: 2,
      activeTabId: "t1",
      tabs: [
        {
          id: "t1",
          title: "",
          root: { type: "leaf", id: "p", sessionIds: ["a", "b"], activeSessionId: "b" },
          activeSessionId: "a",
        },
      ],
      sessions: v1.sessions,
    })!
    expect(restored.tabs[0]!.root).toMatchObject({ activeSessionId: "a" })
  })

  it("migratePaneNode rejects malformed nodes", () => {
    expect(migratePaneNode(null)).toBeNull()
    expect(migratePaneNode({ type: "leaf" })).toBeNull()
    expect(migratePaneNode({ type: "leaf", id: "p", sessionIds: [] })).toBeUndefined() // drops out
    expect(migratePaneNode({ type: "split", id: "s", direction: "row", children: [] })).toBeNull()
    expect(
      migratePaneNode({
        type: "split",
        id: "s",
        direction: "diagonal",
        children: [
          { type: "leaf", sessionId: "a" },
          { type: "leaf", sessionId: "b" },
        ],
      }),
    ).toBeNull()
  })

  it("migratePaneNode repairs a v2 leaf whose active surface is missing", () => {
    expect(
      migratePaneNode({ type: "leaf", id: "p", sessionIds: ["a", "b"], activeSessionId: "zz" }),
    ).toMatchObject({ activeSessionId: "a" })
  })

  it("rejects a workspace written by a newer build instead of misparsing it", () => {
    expect(deserializeWorkspace({ ...v1, version: 3 })).toBeNull()
  })

  it("writes a legacy `sessionId` (the visible surface) on each leaf for older builds", () => {
    const w = serializeWorkspace({
      sessions: { s1: session, s2: { ...session, id: "s2" } },
      tabs: [
        {
          id: "t1",
          title: "",
          root: { type: "leaf", id: "p1", sessionIds: ["s1", "s2"], activeSessionId: "s2" },
          activeSessionId: "s2",
        },
      ],
      activeTabId: "t1",
    })
    expect(w.tabs[0]!.root).toMatchObject({ sessionId: "s2", sessionIds: ["s1", "s2"] })
    // …and the v2 reader ignores the mirror (sessionIds wins)
    expect(deserializeWorkspace(w)!.tabs[0]!.root).toEqual({
      type: "leaf",
      id: "p1",
      sessionIds: ["s1", "s2"],
      activeSessionId: "s2",
    })
  })

  it("drops a session placed in two panes (keeps the first) and collapses the emptied pane", () => {
    const restored = deserializeWorkspace({
      ...v1,
      tabs: [
        {
          ...v1.tabs[0]!,
          root: {
            type: "split",
            id: "sp",
            direction: "row",
            children: [
              { type: "leaf", id: "p1", sessionIds: ["a", "a", "b"], activeSessionId: "a" },
              { type: "leaf", id: "p2", sessionIds: ["b"], activeSessionId: "b" },
            ],
          },
        },
      ],
    })!
    expect(restored.tabs[0]!.root).toEqual({
      type: "leaf",
      id: "p1",
      sessionIds: ["a", "b"],
      activeSessionId: "b", // the tab's focus (b) is made visible on restore
    })
  })

  it("prunes sessions no pane references", () => {
    const restored = deserializeWorkspace({
      ...v1,
      sessions: [...v1.sessions, { id: "orphan", title: "zsh", command: "/bin/zsh", args: [] }],
    })!
    expect(restored.sessions.orphan).toBeUndefined()
    expect(restored.pruned).toEqual(["orphan"]) // so the app can kill a reloaded PTY
    expect(Object.keys(restored.sessions).sort()).toEqual(["a", "b"])
  })

  it("readWorkspaceFile flags a newer build's file (so the app won't overwrite it)", () => {
    const newer = readWorkspaceFile(JSON.stringify({ ...v1, version: 3 }))
    expect(newer).toEqual({ state: null, newer: true })
    expect(readWorkspaceFile(JSON.stringify(v1)).newer).toBe(false)
    expect(readWorkspaceFile("nope")).toEqual({ state: null, newer: false })
  })

  it("drops surfaces with no session record; an emptied pane collapses (layout kept)", () => {
    const restored = deserializeWorkspace({
      ...v1,
      tabs: [
        {
          ...v1.tabs[0]!,
          root: {
            type: "split",
            id: "sp",
            direction: "row",
            children: [
              { type: "leaf", id: "p1", sessionIds: ["a", "ghost"], activeSessionId: "ghost" },
              { type: "leaf", id: "p2", sessionIds: [], activeSessionId: "x" },
            ],
          },
          activeSessionId: "a",
        },
      ],
    })!
    expect(restored.tabs[0]!.root).toEqual({
      type: "leaf",
      id: "p1",
      sessionIds: ["a"],
      activeSessionId: "a",
    })
  })

  it("renames a duplicated pane id so closing one pane can't close the other", () => {
    const restored = deserializeWorkspace({
      ...v1,
      tabs: [
        {
          ...v1.tabs[0]!,
          root: {
            type: "split",
            id: "sp",
            direction: "row",
            children: [
              { type: "leaf", id: "dup", sessionIds: ["a"], activeSessionId: "a" },
              { type: "leaf", id: "dup", sessionIds: ["b"], activeSessionId: "b" },
            ],
          },
        },
      ],
    })!
    const root = restored.tabs[0]!.root
    if (root.type !== "split") throw new Error("expected split")
    expect(root.children.map((c) => c.id)).toEqual(["dup", "pane-b"])
  })
})

describe("workspace — ssh sessions", () => {
  const remote = {
    hostId: "native:gpu",
    label: "gpu",
    target: "u@10.0.0.9",
    env: "native" as const,
  }
  const sshSession: Session = {
    ...session,
    command: "ssh",
    args: ["u@10.0.0.9"],
    cwd: undefined,
    remote,
  }
  const sshState: WorkspaceState = { sessions: { s1: sshSession }, tabs: [tab], activeTabId: "t1" }

  it("persists the host without its args (main rebuilds them) and restores it", () => {
    const json = JSON.parse(serializeToJson(sshState))
    expect(json.sessions[0].remote).toEqual({
      hostId: "native:gpu",
      label: "gpu",
      target: "u@10.0.0.9",
      env: "native",
    })
    const back = deserializeWorkspace(json)!
    expect(back.sessions.s1!.remote).toEqual({
      hostId: "native:gpu",
      label: "gpu",
      target: "u@10.0.0.9",
      env: "native",
    })
    expect(back.sessions.s1!.cwd).toBeUndefined()
  })

  it("saves an ssh pane's verified folder (never an unverified one) and reopens it", () => {
    const at = (extra: Partial<Session>) =>
      JSON.parse(serializeToJson({ ...sshState, sessions: { s1: { ...sshSession, ...extra } } }))
    const live = at({ remoteCwd: "/srv/app", remoteCwdVerified: true, remoteCwdHost: "gpu" })
    expect(live.sessions[0].reopen).toEqual({ dir: "/srv/app", host: "gpu" })
    expect(live.sessions[0]).not.toHaveProperty("remoteCwd") // runtime only
    expect(at({ remoteCwd: "/srv/shown-only" }).sessions[0]).not.toHaveProperty("reopen")
    const waiting = at({ reopenCwd: { dir: "/srv/next", host: "gpu" } }) // not reconnected yet
    expect(waiting.sessions[0].reopen).toEqual({ dir: "/srv/next", host: "gpu" })
    expect(deserializeWorkspace(live)!.sessions.s1!.reopenCwd).toEqual({
      dir: "/srv/app",
      host: "gpu",
    })
  })

  it("drops a saved folder it wouldn't reopen (the file is only as trusted as its writer)", () => {
    for (const bad of [
      { dir: "/a/../etc", host: "gpu" },
      { dir: "relative", host: "gpu" },
      { dir: "/x\n", host: "gpu" },
      { dir: "/ok", host: "bad host" },
      "/string",
    ]) {
      const json = JSON.parse(serializeToJson(sshState))
      json.sessions[0].reopen = bad
      expect(deserializeWorkspace(json)!.sessions.s1).not.toHaveProperty("reopenCwd")
    }
    const local = JSON.parse(serializeToJson(state))
    local.sessions[0].reopen = { dir: "/srv/app", host: "gpu" }
    expect(Object.values(deserializeWorkspace(local)!.sessions)[0]).not.toHaveProperty("reopenCwd")
  })

  it("never restores a local cwd onto a remote session", () => {
    const json = JSON.parse(serializeToJson(sshState))
    json.sessions[0].cwd = "/Users/me"
    expect(deserializeWorkspace(json)!.sessions.s1!.cwd).toBeUndefined()
  })

  it("keeps a malformed host remote-but-unavailable (never its saved `ssh` run locally)", () => {
    for (const bad of [
      { hostId: "x", label: "prod", target: "a;b", env: "native" },
      { hostId: "x", target: "web", env: "docker:new-kind" }, // e.g. from a newer build
      "not an object",
    ]) {
      const json = JSON.parse(serializeToJson(sshState))
      json.sessions[0].remote = bad
      const back = deserializeWorkspace(json)!
      expect(back.sessions.s1!.remote).toMatchObject({
        hostId: "unavailable",
        target: "unavailable",
      })
      expect(back.sessions.s1!.cwd).toBeUndefined()
    }
    const json = JSON.parse(serializeToJson(sshState))
    json.sessions[0].remote = { hostId: "x", label: "prod", target: "a;b", env: "native" }
    expect(deserializeWorkspace(json)!.sessions.s1!.remote!.label).toBe("prod")
  })

  it("writes an unreadable saved host back exactly as it was (a newer build can still read it)", () => {
    const saved = { hostId: "wsl2:Ubuntu:box", target: "box", env: "docker:new-kind", future: true }
    const json = JSON.parse(serializeToJson(sshState))
    json.sessions[0].remote = saved
    const restored = deserializeWorkspace(json)!
    const again = JSON.parse(serializeToJson(restored))
    expect(again.sessions[0].remote).toEqual(saved)
  })

  it("still reads files written before ssh support", () => {
    expect(
      deserializeWorkspace(JSON.parse(serializeToJson(state)))!.sessions.s1!.remote,
    ).toBeUndefined()
  })
})

describe("restoreRemote", () => {
  it("accepts a well-formed host and falls back the label to the target", () => {
    expect(restoreRemote({ hostId: "native:web", target: "web", env: "native" })).toEqual({
      hostId: "native:web",
      label: "web",
      target: "web",
      env: "native",
    })
    expect(
      restoreRemote({ hostId: "wsl:Ubuntu:w", label: "w", target: "w", env: "wsl:Ubuntu" })!.env,
    ).toBe("wsl:Ubuntu")
  })

  it("rejects bad ids, targets, envs and non-objects", () => {
    for (const bad of [
      null,
      "native:web",
      {},
      { hostId: "", target: "web", env: "native" },
      { hostId: "x".repeat(301), target: "web", env: "native" },
      { hostId: "a\nb", target: "web", env: "native" },
      { hostId: "x", target: "-oProxyCommand=y", env: "native" },
      { hostId: "x", target: "$(id)@h", env: "native" },
      { hostId: "x", target: "web", env: "docker:x" },
    ]) {
      expect(restoreRemote(bad)).toBeUndefined()
    }
  })

  it("drops a label with control characters and caps a long one", () => {
    expect(
      restoreRemote({ hostId: "x", label: "a\u001b[2J", target: "t", env: "native" })!.label,
    ).toBe("t")
    expect(
      restoreRemote({ hostId: "x", label: "y".repeat(500), target: "t", env: "native" })!.label,
    ).toHaveLength(200)
  })
})

describe("workspace — runtime-only session fields", () => {
  it("never saves `restored`", () => {
    const remote = { hostId: "native:web", label: "web", target: "web", env: "native" as const }
    const out = serializeWorkspace({
      sessions: {
        r: {
          id: "r",
          title: "",
          command: "ssh",
          args: [],
          status: "idle",
          unread: false,
          remote,
          restored: true,
        },
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
    expect(JSON.stringify(out)).not.toContain("restored")
  })
})
