import { describe, it, expect } from "vitest"
import {
  forgetOthers,
  gitTargets,
  learn,
  logicalRoot,
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

  it("folders in one repo, once each knows it, poll it once", () => {
    const l = new Map<string, Learned>()
    learn(l, { path: "/w/rts/src" }, repo("/w/rts"), 0)
    learn(l, { path: "/w/rts/docs" }, repo("/w/rts"), 0)
    expect(gitTargets([{ path: "/w/rts/src" }, { path: "/w/rts/docs" }], l, undefined, 1)).toEqual([
      { path: "/w/rts/src" },
    ])
  })

  it("a nested worktree is asked itself, never taken for its outer repo", () => {
    const l = new Map<string, Learned>()
    learn(l, { path: "/w/rts" }, repo("/w/rts"), 0)
    const wt = { path: "/w/rts/.claude/worktrees/feat" }
    expect(rootOf(l, wt)).toBeUndefined()
    expect(gitTargets([{ path: "/w/rts" }, wt], l, undefined, 1)).toContainEqual(wt)
    learn(l, wt, repo("/w/rts/.claude/worktrees/feat"), 2)
    expect(rootOf(l, wt)).toBe("/w/rts/.claude/worktrees/feat")
  })

  it("a known repo answering 'not a repo' (git timed out) keeps what it knew", () => {
    const l = new Map<string, Learned>()
    learn(l, { path: "/big" }, repo("/big"), 0)
    learn(l, { path: "/big" }, { isRepo: false, root: "" }, 1)
    expect(rootOf(l, { path: "/big" })).toBe("/big")
  })

  it("forgets folders no longer shown", () => {
    const l = new Map<string, Learned>()
    learn(l, { path: "/a" }, repo("/a"), 0)
    learn(l, { path: "/b" }, repo("/b"), 0)
    forgetOthers(l, [{ path: "/b" }])
    expect(rootOf(l, { path: "/a" })).toBeUndefined()
    expect(rootOf(l, { path: "/b" })).toBe("/b")
  })

  it("skips the focused terminal's repo (its own poll covers it)", () => {
    const l = new Map<string, Learned>()
    learn(l, { path: "/w/rts/src" }, repo("/w/rts"), 0)
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
    expect(rootOf(l, { path: "/home/u/p" })).toBe("/home/u/p")
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

  it("logicalRoot maps git's resolved root back onto the folder's own path", () => {
    expect(logicalRoot("/var/t/proj", "/private/var/t/proj")).toBe("/var/t/proj")
    expect(logicalRoot("/var/t/proj/src", "/private/var/t/proj")).toBe("/var/t/proj")
    expect(logicalRoot("/w/rts/src", "/w/rts")).toBe("/w/rts")
    expect(logicalRoot("/a/b", "/elsewhere/c")).toBe("/elsewhere/c")
  })

  it("learns the folder's spelling of a symlinked repo", () => {
    const l = new Map<string, Learned>()
    learn(l, { path: "/var/t/proj/src" }, repo("/private/var/t/proj"), 0)
    expect(rootOf(l, { path: "/var/t/proj/src" })).toBe("/var/t/proj")
  })
})
