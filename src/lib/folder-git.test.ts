import { describe, it, expect } from "vitest"
import {
  forgetOthers,
  learnRoots,
  repoKey,
  reposOf,
  ROOT_EVERY,
  rootLookups,
  rootOf,
  wantKey,
  type Learned,
} from "./folder-git"

describe("folder git", () => {
  it("looks a folder's root up once, then again every ROOT_EVERY", () => {
    const l = new Map<string, Learned>()
    const w = { path: "/w/rts/src" }
    expect(rootLookups([w], l, 0)).toEqual([w])
    learnRoots(l, [w], { "/w/rts/src": "/w/rts" }, 0)
    expect(rootLookups([w], l, ROOT_EVERY - 1)).toEqual([])
    expect(rootLookups([w], l, ROOT_EVERY)).toEqual([w])
  })

  it("a failed search keeps what was known; 'no .git' is a sure not-a-repo", () => {
    const l = new Map<string, Learned>()
    const w = { path: "/w/p" }
    learnRoots(l, [w], { "/w/p": "/w/p" }, 0)
    learnRoots(l, [w], {}, 1) // the search failed (a dead mount): no answer
    expect(rootOf(l, w)).toBe("/w/p")
    learnRoots(l, [w], { "/w/p": null }, 2) // .git deleted
    expect(rootOf(l, w)).toBeNull()
  })

  it("polls each repo once, a nested worktree as its own", () => {
    const l = new Map<string, Learned>()
    const a = { path: "/w/rts/src" }
    const b = { path: "/w/rts/docs" }
    const wt = { path: "/w/rts/.claude/worktrees/feat" }
    learnRoots(l, [a, b, wt], { [a.path]: "/w/rts", [b.path]: "/w/rts", [wt.path]: wt.path }, 0)
    expect(reposOf([a, b, wt], l, undefined)).toEqual([{ root: "/w/rts" }, { root: wt.path }])
  })

  it("skips the focused terminal's repo (its own poll covers it) and folders in no repo", () => {
    const l = new Map<string, Learned>()
    const a = { path: "/w/rts" }
    const n = { path: "/tmp/x" }
    learnRoots(l, [a, n], { "/w/rts": "/w/rts", "/tmp/x": null }, 0)
    expect(reposOf([a, n], l, "/w/rts/")).toEqual([])
  })

  it("a WSL folder's repo is kept apart from a host path that reads the same", () => {
    const l = new Map<string, Learned>()
    const host = { path: "/home/u/p" }
    const linux = { path: "/home/u/p", wsl: { distro: "Ubuntu" } }
    learnRoots(l, [host], { "/home/u/p": "/home/u/p" }, 0)
    expect(rootOf(l, linux)).toBeUndefined()
    expect(wantKey(host)).not.toBe(wantKey(linux))
    expect(repoKey(undefined, "/r")).not.toBe(repoKey({ distro: "U" }, "/r"))
  })

  it("forgets folders no longer shown", () => {
    const l = new Map<string, Learned>()
    learnRoots(l, [{ path: "/a" }, { path: "/b" }], { "/a": "/a", "/b": "/b" }, 0)
    forgetOthers(l, [{ path: "/b" }])
    expect(rootOf(l, { path: "/a" })).toBeUndefined()
    expect(rootOf(l, { path: "/b" })).toBe("/b")
  })
})
