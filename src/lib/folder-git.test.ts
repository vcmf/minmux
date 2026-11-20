import { describe, it, expect } from "vitest"
import {
  gitTargets,
  learn,
  NOT_REPO_TTL,
  repoKey,
  rootOf,
  statusFor,
  type Learned,
} from "./folder-git"
import type { GitStatus } from "./ipc"

const repo = (root: string): GitStatus =>
  ({
    isRepo: true,
    root,
    branch: "main",
    ahead: 0,
    behind: 0,
    files: [],
    add: 0,
    del: 0,
  }) as GitStatus

describe("folder git", () => {
  it("unknown folders are asked once each", () => {
    expect(gitTargets([{ path: "/a" }, { path: "/b" }], new Map(), undefined, 0)).toEqual([
      { path: "/a" },
      { path: "/b" },
    ])
  })

  it("folders in one repo poll it once, at its root", () => {
    const l = new Map<string, Learned>()
    learn(l, { path: "/w/rts/src" }, repo("/w/rts"), 0)
    expect(rootOf(l, { path: "/w/rts/docs" })).toBe("/w/rts")
    expect(gitTargets([{ path: "/w/rts/src" }, { path: "/w/rts/docs" }], l, undefined, 1)).toEqual([
      { path: "/w/rts" },
    ])
  })

  it("skips the focused terminal's repo (its own poll covers it)", () => {
    const l = new Map<string, Learned>()
    learn(l, { path: "/w/rts" }, repo("/w/rts"), 0)
    expect(gitTargets([{ path: "/w/rts/src" }], l, "/w/rts/", 1)).toEqual([])
  })

  it("a folder that isn't a repo is asked again only after the TTL", () => {
    const l = new Map<string, Learned>()
    learn(l, { path: "/tmp/x" }, { isRepo: false, root: "" }, 0)
    expect(gitTargets([{ path: "/tmp/x" }], l, undefined, NOT_REPO_TTL - 1)).toEqual([])
    expect(gitTargets([{ path: "/tmp/x" }], l, undefined, NOT_REPO_TTL)).toHaveLength(1)
  })

  it("a WSL folder's repo is kept apart from a host path that reads the same", () => {
    const l = new Map<string, Learned>()
    learn(l, { path: "/home/u/p" }, repo("/home/u/p"), 0)
    expect(rootOf(l, { path: "/home/u/p", wsl: { distro: "Ubuntu" } })).toBeUndefined()
  })

  it("statusFor picks the innermost polled repo holding the folder", () => {
    const g = {
      [repoKey(undefined, "/w")]: repo("/w"),
      [repoKey(undefined, "/w/sub")]: repo("/w/sub"),
    }
    expect(statusFor(g, "/w/sub/x", undefined)!.root).toBe("/w/sub")
    expect(statusFor(g, "/w/y", undefined)!.root).toBe("/w")
    expect(statusFor(g, "/elsewhere", undefined)).toBeUndefined()
    expect(statusFor(g, "/w/y", { distro: "U" })).toBeUndefined()
  })
})
