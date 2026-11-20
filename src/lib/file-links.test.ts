import { describe, it, expect } from "vitest"
import { findFilePaths, resolveLinkPath } from "./file-links"

const paths = (t: string) => findFilePaths(t).map((m) => m.path)

describe("findFilePaths", () => {
  it("detects relative, absolute, and home paths", () => {
    expect(paths("edit src/app.tsx now")).toEqual(["src/app.tsx"])
    expect(paths("see /usr/local/bin/thing")).toEqual(["/usr/local/bin/thing"])
    expect(paths("open ~/notes/todo.md")).toEqual(["~/notes/todo.md"])
    expect(paths("./build.sh and ../pkg/x.ts")).toEqual(["./build.sh", "../pkg/x.ts"])
  })

  it("detects a bare filename with an extension", () => {
    expect(paths("failed in main.rs")).toEqual(["main.rs"])
  })

  it("parses :line and :line:col and keeps them out of the path", () => {
    const m = findFilePaths("error at src/app.tsx:42:10 here")[0]
    expect(m).toMatchObject({ path: "src/app.tsx", line: 42, col: 10 })
    // clickable span covers the whole "src/app.tsx:42:10"
    expect(m!.length).toBe("src/app.tsx:42:10".length)
    expect(findFilePaths("lib/x.ts:7")[0]).toMatchObject({
      path: "lib/x.ts",
      line: 7,
      col: undefined,
    })
  })

  it("ignores bare words and dotted version numbers", () => {
    // (Non-file tokens like "2.5x" may pass the permissive regex but are pruned by
    // existence validation — see the note atop file-links.ts.)
    expect(paths("the quick brown fox")).toEqual([])
    expect(paths("upgraded to v1.2.3 today")).toEqual([])
    expect(paths("bumped 1.2.3 to 2.0.0")).toEqual([])
  })

  it("does not pull the path part out of a URL", () => {
    // web-links owns URLs; we must not also match https://host/a/b.ts
    expect(paths("visit https://example.com/docs/readme.md")).toEqual([])
  })

  it("strips trailing sentence punctuation", () => {
    expect(paths("look at config.json.")).toEqual(["config.json"])
    expect(paths("(see src/main.ts)")).toEqual(["src/main.ts"])
  })

  it("gives correct offsets for the clickable range", () => {
    const m = findFilePaths(">> src/a.ts <<")[0]!
    expect(m.start).toBe(3)
    expect(">> src/a.ts <<".slice(m.start, m.start + m.length)).toBe("src/a.ts")
  })
})

describe("resolveLinkPath", () => {
  it("relative to the terminal's folder, with . and .. resolved", () => {
    expect(resolveLinkPath("/w/rts", "src/a.ts", "/h")).toBe("/w/rts/src/a.ts")
    expect(resolveLinkPath("/w/rts", "./x/../b.md", "/h")).toBe("/w/rts/b.md")
  })

  it("absolute stays; ~/ is home", () => {
    expect(resolveLinkPath("/w", "/etc/hosts", "/h")).toBe("/etc/hosts")
    expect(resolveLinkPath("/w", "~/notes.md", "/Users/me")).toBe("/Users/me/notes.md")
  })
})
