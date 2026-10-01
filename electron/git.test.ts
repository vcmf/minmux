import { describe, it, expect } from "vitest"
import {
  expandDirs,
  splitRename,
  unquotePath,
  parseStatusEntries,
  parseBranchLine,
  statusOf,
  parseNumstat,
  parseDiff,
  wslGitArgs,
} from "./git"

describe("parseBranchLine", () => {
  it("reads branch + ahead/behind", () => {
    expect(parseBranchLine("## main...origin/main [ahead 2, behind 1]")).toEqual({
      branch: "main",
      ahead: 2,
      behind: 1,
    })
    expect(parseBranchLine("## feat/x...origin/feat/x [ahead 3]")).toEqual({
      branch: "feat/x",
      ahead: 3,
      behind: 0,
    })
    expect(parseBranchLine("## main")).toEqual({ branch: "main", ahead: 0, behind: 0 })
  })
})

describe("statusOf", () => {
  it("reduces XY pairs to one display status", () => {
    expect(statusOf("??")).toBe("?")
    expect(statusOf(" M")).toBe("M")
    expect(statusOf("M ")).toBe("M")
    expect(statusOf("A ")).toBe("A")
    expect(statusOf(" D")).toBe("D")
    expect(statusOf("R ")).toBe("R")
  })
})

describe("parseNumstat", () => {
  it("maps path → add/del, handling binary and renames", () => {
    const m = parseNumstat("6\t2\tsrc/a.ts\n-\t-\timg.png\n1\t0\tsrc/{x => y}/f.ts\n")
    expect(m.get("src/a.ts")).toEqual({ add: 6, del: 2 })
    expect(m.get("img.png")).toEqual({ add: 0, del: 0 })
    expect(m.get("src/y/f.ts")).toEqual({ add: 1, del: 0 })
  })
})

describe("parseDiff", () => {
  it("classifies lines and tracks gutter numbers", () => {
    const out = [
      "diff --git a/f.ts b/f.ts",
      "index 111..222 100644",
      "--- a/f.ts",
      "+++ b/f.ts",
      "@@ -1,3 +1,4 @@",
      " ctx",
      "-old",
      "+new1",
      "+new2",
    ].join("\n")
    const lines = parseDiff(out)
    expect(lines.map((l) => l.type)).toEqual(["hunk", "context", "del", "add", "add"])
    const ctx = lines[1]
    expect(ctx).toMatchObject({ type: "context", text: "ctx", oldNo: 1, newNo: 1 })
    expect(lines[2]).toMatchObject({ type: "del", text: "old", oldNo: 2 })
    expect(lines[3]).toMatchObject({ type: "add", text: "new1", newNo: 2 })
    expect(lines[4]).toMatchObject({ type: "add", text: "new2", newNo: 3 })
  })
})

describe("wslGitArgs", () => {
  it("runs git in the given distro at the Linux cwd via --cd", () => {
    expect(wslGitArgs("Ubuntu", "/home/me/repo", ["status", "--porcelain=v1"])).toEqual([
      "-d",
      "Ubuntu",
      "--cd",
      "/home/me/repo",
      "--",
      "git",
      "-c",
      "core.quotepath=false",
      "status",
      "--porcelain=v1",
    ])
  })

  it("omits -d for the default distro", () => {
    expect(wslGitArgs(undefined, "/home/me/repo", ["diff", "HEAD"])).toEqual([
      "--cd",
      "/home/me/repo",
      "--",
      "git",
      "-c",
      "core.quotepath=false",
      "diff",
      "HEAD",
    ])
  })
})

describe("parseStatusEntries", () => {
  it("an untracked folder is one entry, flagged isDir, without its trailing slash", () => {
    const r = parseStatusEntries("## main\n M a.ts\n?? docs/node_modules/\n?? new.md\n")
    expect(r.header).toBe("## main")
    expect(r.entries).toEqual([
      { xy: " M", path: "a.ts", isDir: false },
      { xy: "??", path: "docs/node_modules", isDir: true },
      { xy: "??", path: "new.md", isDir: false },
    ])
    expect(r.total).toBe(3)
  })
  it("caps the entries but counts them all", () => {
    const lines = Array.from({ length: 12 }, (_, i) => ` M f${i}.ts`).join("\n")
    const r = parseStatusEntries(`## main\n${lines}\n`, 5)
    expect(r.entries).toHaveLength(5)
    expect(r.total).toBe(12)
  })
})

describe("unquotePath", () => {
  it("undoes git's C-quoting (spaces, quotes, escapes, octal UTF-8)", () => {
    expect(unquotePath("plain/path")).toBe("plain/path")
    expect(unquotePath('"my dir/"')).toBe("my dir/")
    expect(unquotePath('"say \\"hi\\".txt"')).toBe('say "hi".txt')
    expect(unquotePath('"tab\\there"')).toBe("tab\there")
    expect(unquotePath('"caf\\303\\251"')).toBe("café")
  })
  it("a quoted untracked folder is still a folder", () => {
    const r = parseStatusEntries('## main\n?? "my dir/"\n')
    expect(r.entries).toEqual([{ xy: "??", path: "my dir", isDir: true }])
  })
})

describe("renames and quoting (status ↔ numstat must agree)", () => {
  it("splitRename splits outside quotes; the row is the new path", () => {
    expect(splitRename("a.ts -> b.ts")).toEqual(["a.ts", "b.ts"])
    expect(splitRename('"q\\"t" -> "n\\"w"')).toEqual(['"q\\"t"', '"n\\"w"'])
    expect(splitRename("no-arrow")).toBeNull()
    const r = parseStatusEntries('## main\nR  "q\\"t" -> "n\\"w"\nR  ab/h -> "ab/h 2"\n')
    expect(r.entries.map((e) => e.path)).toEqual(['n"w', "ab/h 2"])
  })
  it("a numstat rename with quoted sides keys on the unquoted new path", () => {
    expect(parseNumstat('2\t0\t"x\\"y.txt" => "z\\"w.txt"\n').get('z"w.txt')).toEqual({
      add: 2,
      del: 0,
    })
    expect(parseNumstat('1\t1\tplain.txt => "p\\"q.txt"\n').get('p"q.txt')).toEqual({
      add: 1,
      del: 1,
    })
  })
  it("numstat keys are unquoted like porcelain paths", () => {
    const m = parseNumstat('3\t1\t"say \\"hi\\".txt"\n')
    expect(m.get('say "hi".txt')).toEqual({ add: 3, del: 1 })
  })
  it("a brace rename with an empty side keys on a clean path", () => {
    const m = parseNumstat("2\t0\tlib/{sub => }/x.ts\n4\t1\t{ => src}/y.ts\n")
    expect(m.get("lib/x.ts")).toEqual({ add: 2, del: 0 })
    expect(m.get("src/y.ts")).toEqual({ add: 4, del: 1 })
  })
})

describe("expandDirs (small new folders list their files)", () => {
  const e = [
    { xy: " M", path: "a.ts", isDir: false },
    { xy: "??", path: "feat", isDir: true },
    { xy: "??", path: "docs", isDir: true },
  ]
  it("puts a small folder's files in its place; a big (null) one stays one row", () => {
    const out = expandDirs(
      e,
      new Map([
        ["feat", ["feat/x.ts", "feat/y/z.ts"]],
        ["docs", null],
      ]),
    )
    expect(out.map((x) => x.path)).toEqual(["a.ts", "feat/x.ts", "feat/y/z.ts", "docs"])
    expect(out[1]).toEqual({ xy: "??", path: "feat/x.ts", isDir: false })
  })
  it("a nested repo inside (listed as dir/) stays a folder row", () => {
    const out = expandDirs(e, new Map([["feat", ["feat/a.ts", "feat/vendor/"]]]))
    expect(out.filter((x) => x.path.startsWith("feat"))).toEqual([
      { xy: "??", path: "feat/a.ts", isDir: false },
      { xy: "??", path: "feat/vendor", isDir: true },
    ])
  })
  it("an unchecked or empty listing keeps the row", () => {
    expect(expandDirs(e, new Map([["feat", []]]))).toEqual(e)
  })
})
