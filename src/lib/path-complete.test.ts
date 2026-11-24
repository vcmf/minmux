import { describe, it, expect } from "vitest"
import {
  commonPrefix,
  expandTilde,
  matchDirs,
  sepOf,
  splitPathInput,
  trimTrailingSep,
} from "./path-complete"

const d = (name: string) => ({ name, isDir: true })
const f = (name: string) => ({ name, isDir: false })

describe("splitPathInput", () => {
  it("splits at the last separator", () => {
    expect(splitPathInput("/Users/me/wo", "/Users/me", false)).toEqual({
      base: "/Users/me/",
      dir: "/Users/me",
      prefix: "wo",
    })
  })
  it("a trailing separator lists the whole folder", () => {
    expect(splitPathInput("/a/b/", "", false)).toEqual({ base: "/a/b/", dir: "/a/b", prefix: "" })
  })
  it("keeps the root", () => {
    expect(splitPathInput("/us", "", false)).toEqual({ base: "/", dir: "/", prefix: "us" })
  })
  it("expands ~ for the read, keeps it as typed", () => {
    expect(splitPathInput("~/wo", "/Users/me", false)).toEqual({
      base: "~/",
      dir: "/Users/me",
      prefix: "wo",
    })
    expect(splitPathInput("~/a/", "/Users/me/", false)?.dir).toBe("/Users/me/a")
  })
  it("names no folder without a separator, or when relative", () => {
    expect(splitPathInput("~", "/Users/me", false)).toBeNull()
    expect(splitPathInput("", "/Users/me", false)).toBeNull()
    expect(splitPathInput("a/b", "/Users/me", false)).toBeNull()
    expect(splitPathInput("~/a", "", false)).toBeNull() // home unknown
  })
  it("Windows: either separator, drive roots", () => {
    expect(splitPathInput("C:\\Us", "", true)).toEqual({ base: "C:\\", dir: "C:\\", prefix: "Us" })
    expect(splitPathInput("C:/Users/me\\wo", "", true)).toEqual({
      base: "C:/Users/me\\",
      dir: "C:/Users/me",
      prefix: "wo",
    })
    expect(splitPathInput("/a/b", "", true)).toBeNull() // a Git Bash path, not the host's
  })
  it("Windows UNC: nothing until the share is typed", () => {
    expect(splitPathInput("\\\\", "", true)).toBeNull()
    expect(splitPathInput("\\\\srv\\", "", true)).toBeNull()
    expect(splitPathInput("\\\\srv\\share\\do", "", true)).toEqual({
      base: "\\\\srv\\share\\",
      dir: "\\\\srv\\share",
      prefix: "do",
    })
  })
  it("posix: a backslash is part of a name", () => {
    expect(splitPathInput("/a/b\\c", "", false)?.prefix).toBe("b\\c")
  })
})

describe("expandTilde / trimTrailingSep", () => {
  it("expands only a leading ~ segment", () => {
    expect(expandTilde("~", "/h")).toBe("/h")
    expect(expandTilde("~/x", "/h")).toBe("/h/x")
    expect(expandTilde("~x", "/h")).toBe("~x")
    expect(expandTilde("/a/~", "/h")).toBe("/a/~")
  })
  it("trims, keeping roots", () => {
    expect(trimTrailingSep("/a/b//")).toBe("/a/b")
    expect(trimTrailingSep("/")).toBe("/")
    expect(trimTrailingSep("C:\\", true)).toBe("C:\\")
    expect(trimTrailingSep("C:\\a\\", true)).toBe("C:\\a")
  })
  it("posix: a backslash is part of a name", () => {
    expect(trimTrailingSep("/tmp/odd\\")).toBe("/tmp/odd\\")
    expect(expandTilde("~\\x", "/h")).toBe("~\\x")
    expect(expandTilde("~\\x", "C:\\h", true)).toBe("C:\\h\\x")
  })
})

describe("matchDirs", () => {
  const entries = [d(".claude"), d("Docs"), d("dist"), d("docs2"), f("docs.md")]
  it("folders starting with the prefix, in listing order", () => {
    expect(matchDirs(entries, "d", false)).toEqual(["dist", "docs2"])
    expect(matchDirs(entries, "d", true)).toEqual(["Docs", "dist", "docs2"])
  })
  it("empty prefix: every visible folder", () => {
    expect(matchDirs(entries, "", false)).toEqual(["Docs", "dist", "docs2"])
  })
  it("hidden folders once the prefix starts with a dot", () => {
    expect(matchDirs(entries, ".", false)).toEqual([".claude"])
  })
})

describe("commonPrefix / sepOf", () => {
  it("shares the longest prefix", () => {
    expect(commonPrefix(["term", "term-phone"], false)).toBe("term")
    expect(commonPrefix(["Docs", "docs2"], true)).toBe("Docs")
    expect(commonPrefix(["Docs", "docs2"], false)).toBe("")
    expect(commonPrefix([], false)).toBe("")
  })
  it("appends the separator typed last", () => {
    expect(sepOf("C:\\a\\")).toBe("\\")
    expect(sepOf("/a/")).toBe("/")
  })
})
