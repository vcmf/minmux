import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  expandGlob,
  globSegmentToRegExp,
  loadSshConfig,
  nodeMiniFs,
  parseSshConfig,
  resolveIncludePath,
  tokenizeLine,
  type MiniFs,
  type SshConfigHost,
} from "./ssh-config"

/** An in-memory MiniFs: files by absolute path; directories are implied by file paths. */
function fakeFs(files: Record<string, string>, p = path.posix): MiniFs & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    readFile: async (f) => {
      reads.push(f)
      return Object.prototype.hasOwnProperty.call(files, f) ? files[f]! : null
    },
    readdir: async (dir) => {
      const prefix = dir.endsWith(p.sep) ? dir : dir + p.sep
      const names = new Set<string>()
      for (const f of Object.keys(files)) {
        if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split(p.sep)[0]!)
      }
      return names.size ? [...names] : null
    },
  }
}

const hostsOf = (text: string) =>
  parseSshConfig(text).flatMap((i) => (i.type === "host" ? [i.host] : []))
const aliases = (hs: SshConfigHost[]) => hs.map((h) => h.alias)

describe("tokenizeLine", () => {
  it("splits keyword and arguments on whitespace", () => {
    expect(tokenizeLine("Host a b  c")).toEqual(["Host", "a", "b", "c"])
    expect(tokenizeLine("\tHostName\t10.0.0.1  ")).toEqual(["HostName", "10.0.0.1"])
  })

  it("accepts `=` between keyword and value, with or without spaces", () => {
    expect(tokenizeLine("Port=2222")).toEqual(["Port", "2222"])
    expect(tokenizeLine("Port = 2222")).toEqual(["Port", "2222"])
    expect(tokenizeLine("Port =2222")).toEqual(["Port", "2222"])
    expect(tokenizeLine("User= me")).toEqual(["User", "me"])
  })

  it("keeps `=` inside a value", () => {
    expect(tokenizeLine("SetEnv FOO=bar")).toEqual(["SetEnv", "FOO=bar"])
    expect(tokenizeLine("SetEnv=FOO=bar")).toEqual(["SetEnv", "FOO=bar"])
  })

  it("groups double-quoted values, including spaces and an empty string", () => {
    expect(tokenizeLine('Host "my box" other')).toEqual(["Host", "my box", "other"])
    expect(tokenizeLine('IdentityFile "~/My Keys/id"')).toEqual(["IdentityFile", "~/My Keys/id"])
    expect(tokenizeLine('Host ""')).toEqual(["Host", ""])
  })

  it("tolerates an unterminated quote (takes the rest of the line)", () => {
    expect(tokenizeLine('Host "open ended')).toEqual(["Host", "open ended"])
  })

  it("treats `#` lines and trailing `#` tokens as comments", () => {
    expect(tokenizeLine("# a comment")).toEqual([])
    expect(tokenizeLine("   # indented comment")).toEqual([])
    expect(tokenizeLine("Host a # trailing")).toEqual(["Host", "a"])
  })

  it("keeps `#` that isn't at the start of a token, and a quoted `#`", () => {
    expect(tokenizeLine("Host a#b")).toEqual(["Host", "a#b"])
    expect(tokenizeLine('Host "#x"')).toEqual(["Host", "#x"])
  })

  it("returns [] for empty and whitespace-only lines, and a bare `=`", () => {
    expect(tokenizeLine("")).toEqual([])
    expect(tokenizeLine("   \t ")).toEqual([])
    expect(tokenizeLine("=value")).toEqual([])
  })

  it("returns the keyword alone when it has no value", () => {
    expect(tokenizeLine("Host")).toEqual(["Host"])
    expect(tokenizeLine("Port=")).toEqual(["Port"])
  })
})

describe("parseSshConfig", () => {
  it("lists every alias of a multi-alias Host line, sharing the block's fields", () => {
    const hs = hostsOf("Host a b c\n  HostName 10.0.0.9\n  User deploy\n  Port 2200\n")
    expect(aliases(hs)).toEqual(["a", "b", "c"])
    for (const h of hs)
      expect(h).toMatchObject({ hostName: "10.0.0.9", user: "deploy", port: "2200" })
  })

  it("skips wildcard and negated patterns but keeps plain aliases on the same line", () => {
    const hs = hostsOf("Host *.corp web-? !bad prod\n  User x\nHost *\n  User y\n")
    expect(aliases(hs)).toEqual(["prod"])
    expect(hs[0]!.user).toBe("x")
  })

  it("ignores fields of a pattern-only block (they don't leak into the previous host)", () => {
    const hs = hostsOf("Host a\n  User first\nHost *\n  User wild\n  HostName nope\n")
    expect(hs).toEqual([{ alias: "a", user: "first" }])
  })

  it("keeps the first value of a field within a block (OpenSSH semantics)", () => {
    const hs = hostsOf("Host a\n  HostName one\n  HostName two\n")
    expect(hs[0]!.hostName).toBe("one")
  })

  it("matches keywords case-insensitively", () => {
    const hs = hostsOf("HOST a\n  hostname h\n  USER u\n  pOrT 1\n")
    expect(hs).toEqual([{ alias: "a", hostName: "h", user: "u", port: "1" }])
  })

  it("ignores global fields before the first Host", () => {
    const hs = hostsOf("User global\nHostName g\nHost a\n")
    expect(hs).toEqual([{ alias: "a" }])
  })

  it("ignores Match blocks and their fields, then resumes at the next Host", () => {
    const hs = hostsOf(
      "Host a\nMatch host foo exec true\n  User fromMatch\nHost b\n  User b-user\n",
    )
    expect(hs).toEqual([{ alias: "a" }, { alias: "b", user: "b-user" }])
  })

  it("handles CRLF line endings", () => {
    const hs = hostsOf("Host a\r\n  User u\r\nHost b\r\n")
    expect(hs).toEqual([{ alias: "a", user: "u" }, { alias: "b" }])
  })

  it("keeps quoted aliases and drops empty ones", () => {
    const hs = hostsOf('Host "my box" ""\n  HostName h\n')
    expect(hs).toEqual([{ alias: "my box", hostName: "h" }])
  })

  it("treats a bare `Host` as a block with no aliases", () => {
    const hs = hostsOf("Host a\nHost\n  User orphan\n")
    expect(hs).toEqual([{ alias: "a" }])
  })

  it("returns Include directives in order with all their patterns", () => {
    const items = parseSshConfig("Host a\nInclude one two/*\nHost b\nInclude\n")
    expect(items.map((i) => i.type)).toEqual(["host", "include", "host"])
    expect(items[1]).toEqual({ type: "include", patterns: ["one", "two/*"] })
  })

  it("is not confused by keywords that are Object.prototype names", () => {
    const hs = hostsOf("Host a\n  constructor x\n  __proto__ y\n  toString z\n")
    expect(hs).toEqual([{ alias: "a" }])
  })

  it("returns [] for empty text and comment-only files", () => {
    expect(parseSshConfig("")).toEqual([])
    expect(parseSshConfig("# nothing\n\n   # here\n")).toEqual([])
  })

  it("accepts `Host=alias` syntax", () => {
    expect(aliases(hostsOf("Host=a\nHost = b c\n"))).toEqual(["a", "b", "c"])
  })
})

describe("globSegmentToRegExp", () => {
  const m = (seg: string, name: string) => globSegmentToRegExp(seg).test(name)

  it("supports *, ? and character classes", () => {
    expect(m("*.conf", "a.conf")).toBe(true)
    expect(m("*.conf", "a.confx")).toBe(false)
    expect(m("host-?", "host-1")).toBe(true)
    expect(m("host-?", "host-12")).toBe(false)
    expect(m("[ab]x", "bx")).toBe(true)
    expect(m("[ab]x", "cx")).toBe(false)
    expect(m("[a-c]", "b")).toBe(true)
  })

  it("supports negated classes with ! and ^", () => {
    expect(m("[!a]x", "bx")).toBe(true)
    expect(m("[!a]x", "ax")).toBe(false)
    expect(m("[^a]x", "ax")).toBe(false)
  })

  it("escapes regex metacharacters and treats an unterminated [ literally", () => {
    expect(m("a.b", "axb")).toBe(false)
    expect(m("a.b", "a.b")).toBe(true)
    expect(m("a+(b)", "a+(b)")).toBe(true)
    expect(m("[abc", "[abc")).toBe(true)
  })

  it("anchors the whole name", () => {
    expect(m("conf", "myconf")).toBe(false)
  })
})

describe("expandGlob", () => {
  const files = {
    "/h/.ssh/config.d/b.conf": "",
    "/h/.ssh/config.d/a.conf": "",
    "/h/.ssh/config.d/.hidden": "",
    "/h/.ssh/config.d/notes.txt": "",
    "/h/.ssh/work/x/config": "",
    "/h/.ssh/work/y/config": "",
  }

  it("returns a path without wildcards unchanged (existence is the reader's job)", async () => {
    expect(await expandGlob("/h/.ssh/missing", fakeFs(files), path.posix)).toEqual([
      "/h/.ssh/missing",
    ])
  })

  it("expands the last segment, sorted, skipping dotfiles", async () => {
    expect(await expandGlob("/h/.ssh/config.d/*", fakeFs(files), path.posix)).toEqual([
      "/h/.ssh/config.d/a.conf",
      "/h/.ssh/config.d/b.conf",
      "/h/.ssh/config.d/notes.txt",
    ])
    expect(await expandGlob("/h/.ssh/config.d/*.conf", fakeFs(files), path.posix)).toEqual([
      "/h/.ssh/config.d/a.conf",
      "/h/.ssh/config.d/b.conf",
    ])
  })

  it("matches dotfiles only when the segment starts with a dot", async () => {
    expect(await expandGlob("/h/.ssh/config.d/.*", fakeFs(files), path.posix)).toEqual([
      "/h/.ssh/config.d/.hidden",
    ])
  })

  it("expands wildcards in a middle segment", async () => {
    expect(await expandGlob("/h/.ssh/work/*/config", fakeFs(files), path.posix)).toEqual([
      "/h/.ssh/work/x/config",
      "/h/.ssh/work/y/config",
    ])
  })

  it("returns [] when a directory in the pattern is missing", async () => {
    expect(await expandGlob("/nope/*/config", fakeFs(files), path.posix)).toEqual([])
  })

  it("works with win32 paths", async () => {
    const p = path.win32
    const win = fakeFs(
      { "C:\\Users\\me\\.ssh\\conf.d\\one": "", "C:\\Users\\me\\.ssh\\conf.d\\two": "" },
      p,
    )
    expect(await expandGlob("C:\\Users\\me\\.ssh\\conf.d\\*", win, p)).toEqual([
      "C:\\Users\\me\\.ssh\\conf.d\\one",
      "C:\\Users\\me\\.ssh\\conf.d\\two",
    ])
  })
})

describe("resolveIncludePath", () => {
  it("expands ~ and resolves relative paths against ~/.ssh", () => {
    const p = path.posix
    expect(resolveIncludePath("~", "/home/me", p)).toBe("/home/me")
    expect(resolveIncludePath("~/extra", "/home/me", p)).toBe("/home/me/extra")
    expect(resolveIncludePath("config.d/*", "/home/me", p)).toBe("/home/me/.ssh/config.d/*")
    expect(resolveIncludePath("/etc/ssh/extra", "/home/me", p)).toBe("/etc/ssh/extra")
  })

  it("handles win32 homes and both ~ separators", () => {
    const p = path.win32
    expect(resolveIncludePath("~\\x", "C:\\Users\\me", p)).toBe("C:\\Users\\me\\x")
    expect(resolveIncludePath("~/x", "C:\\Users\\me", p)).toBe("C:\\Users\\me\\x")
    expect(resolveIncludePath("conf.d\\a", "C:\\Users\\me", p)).toBe(
      "C:\\Users\\me\\.ssh\\conf.d\\a",
    )
    expect(resolveIncludePath("D:\\ssh\\extra", "C:\\Users\\me", p)).toBe("D:\\ssh\\extra")
  })
})

describe("loadSshConfig", () => {
  const load = (files: Record<string, string>, maxDepth?: number) =>
    loadSshConfig({
      file: "/h/.ssh/config",
      home: "/h",
      fs: fakeFs(files),
      path: path.posix,
      ...(maxDepth !== undefined ? { maxDepth } : {}),
    })

  it("returns an empty list when the config doesn't exist", async () => {
    expect(await load({})).toEqual({ hosts: [], files: [] })
  })

  it("places included hosts at the Include position", async () => {
    const r = await load({
      "/h/.ssh/config": "Host first\nInclude extra\nHost last\n",
      "/h/.ssh/extra": "Host middle\n",
    })
    expect(aliases(r.hosts)).toEqual(["first", "middle", "last"])
    expect(r.files).toEqual(["/h/.ssh/config", "/h/.ssh/extra"])
  })

  it("keeps the first definition of an alias across files", async () => {
    const r = await load({
      "/h/.ssh/config": "Include extra\nHost a\n  User later\n",
      "/h/.ssh/extra": "Host a\n  User early\n",
    })
    expect(r.hosts).toEqual([{ alias: "a", user: "early" }])
  })

  it("expands glob Includes in sorted order", async () => {
    const r = await load({
      "/h/.ssh/config": "Include config.d/*\n",
      "/h/.ssh/config.d/20-b": "Host b\n",
      "/h/.ssh/config.d/10-a": "Host a\n",
    })
    expect(aliases(r.hosts)).toEqual(["a", "b"])
  })

  it("follows several patterns on one Include line, and ~ paths", async () => {
    const r = await load({
      "/h/.ssh/config": "Include one ~/other\n",
      "/h/.ssh/one": "Host one\n",
      "/h/other": "Host other\n",
    })
    expect(aliases(r.hosts)).toEqual(["one", "other"])
  })

  it("follows an Include inside a Host block", async () => {
    const r = await load({
      "/h/.ssh/config": "Host a\n  User u\n  Include inner\n",
      "/h/.ssh/inner": "Host b\n",
    })
    expect(aliases(r.hosts)).toEqual(["a", "b"])
  })

  it("skips a missing Include target without failing", async () => {
    const r = await load({ "/h/.ssh/config": "Include gone\nHost a\n" })
    expect(aliases(r.hosts)).toEqual(["a"])
    expect(r.files).toEqual(["/h/.ssh/config"])
  })

  it("survives an Include cycle", async () => {
    const r = await load({
      "/h/.ssh/config": "Host a\nInclude b\n",
      "/h/.ssh/b": "Host b\nInclude config\nInclude b\n",
    })
    expect(aliases(r.hosts)).toEqual(["a", "b"])
  })

  it("re-reads a file included twice from different parents (not a cycle)", async () => {
    const r = await load({
      "/h/.ssh/config": "Include x\nInclude y\n",
      "/h/.ssh/x": "Include shared\n",
      "/h/.ssh/y": "Include shared\n",
      "/h/.ssh/shared": "Host s\n",
    })
    expect(aliases(r.hosts)).toEqual(["s"])
  })

  it("stops at the depth cap", async () => {
    const files: Record<string, string> = { "/h/.ssh/config": "Host d0\nInclude d1\n" }
    for (let i = 1; i <= 5; i++) files[`/h/.ssh/d${i}`] = `Host d${i}\nInclude d${i + 1}\n`
    const r = await load(files, 2)
    expect(aliases(r.hosts)).toEqual(["d0", "d1", "d2"])
  })

  it("parses a large config quickly", async () => {
    const big = Array.from(
      { length: 1000 },
      (_, i) => `Host h${i}\n  HostName 10.0.${i % 255}.1\n  User u\n`,
    ).join("")
    const t0 = performance.now()
    const r = await load({ "/h/.ssh/config": big })
    expect(r.hosts).toHaveLength(1000)
    expect(performance.now() - t0).toBeLessThan(250)
  })
})

describe("nodeMiniFs", () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "smterm-sshcfg-"))
  })
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it("reads a file and lists a directory", async () => {
    fs.writeFileSync(path.join(dir, "config"), "Host a\n")
    expect(await nodeMiniFs.readFile(path.join(dir, "config"))).toBe("Host a\n")
    expect(await nodeMiniFs.readdir(dir)).toEqual(["config"])
  })

  it("returns null for missing paths, directories and oversized files", async () => {
    expect(await nodeMiniFs.readFile(path.join(dir, "missing"))).toBeNull()
    expect(await nodeMiniFs.readdir(path.join(dir, "missing"))).toBeNull()
    expect(await nodeMiniFs.readFile(dir)).toBeNull()
    fs.writeFileSync(path.join(dir, "huge"), Buffer.alloc(1024 * 1024 + 1, 0x41))
    expect(await nodeMiniFs.readFile(path.join(dir, "huge"))).toBeNull()
  })

  it("loads a real config tree end to end", async () => {
    fs.mkdirSync(path.join(dir, ".ssh", "config.d"), { recursive: true })
    fs.writeFileSync(path.join(dir, ".ssh", "config"), "Host a\nInclude config.d/*\n")
    fs.writeFileSync(path.join(dir, ".ssh", "config.d", "work"), "Host b\n  HostName b.example\n")
    const r = await loadSshConfig({
      file: path.join(dir, ".ssh", "config"),
      home: dir,
      fs: nodeMiniFs,
      path,
    })
    expect(r.hosts).toEqual([{ alias: "a" }, { alias: "b", hostName: "b.example" }])
    expect(r.files).toHaveLength(2)
  })
})
