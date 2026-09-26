import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  expandGlob,
  globSegmentToRegExp,
  hostMatcher,
  hostsFromBlocks,
  loadSshConfig,
  nodeMiniFs,
  parseSshConfig,
  resolveIncludePath,
  tokenizeLine,
  wslMiniFs,
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
  hostsFromBlocks(parseSshConfig(text).flatMap((i) => (i.type === "block" ? [i] : [])))
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

  it("rejects a line with an unterminated quote (ssh refuses it too)", () => {
    expect(tokenizeLine('Host "open ended')).toEqual([])
    expect(tokenizeLine("Host 'open")).toEqual([])
  })

  it("handles quotes opening mid-token and single quotes", () => {
    expect(tokenizeLine('HostName foo"bar baz"')).toEqual(["HostName", "foobar baz"])
    expect(tokenizeLine("Host 'my box' x")).toEqual(["Host", "my box", "x"])
    expect(tokenizeLine(`Host "it's" 'say "hi"'`)).toEqual(["Host", "it's", 'say "hi"'])
  })

  it("handles backslash escapes like argv_split", () => {
    expect(tokenizeLine('Host a\\"b')).toEqual(["Host", 'a"b'])
    expect(tokenizeLine("Host a\\ b")).toEqual(["Host", "a b"])
    expect(tokenizeLine('Host "a\\ b"')).toEqual(["Host", "a\\ b"])
    expect(tokenizeLine("IdentityFile C:\\Users\\me\\id")).toEqual([
      "IdentityFile",
      "C:\\Users\\me\\id",
    ])
    expect(tokenizeLine("Host a\\\\b")).toEqual(["Host", "a\\b"])
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

  it("applies a later `Host *` block's values the host doesn't set itself", () => {
    const hs = hostsOf("Host a\n  User first\nHost *\n  User wild\n  HostName fallback\n")
    expect(hs).toEqual([{ alias: "a", user: "first", hostName: "fallback" }])
  })

  it("lets an earlier `Host *` win over the host's own block (first match wins)", () => {
    expect(hostsOf("Host *\n  User bob\nHost foo\n  User alice\n")).toEqual([
      { alias: "foo", user: "bob" },
    ])
  })

  it("merges values from every block that names the alias", () => {
    const hs = hostsOf("Host foo\n  User a\nHost foo bar\n  HostName x\n")
    expect(hs).toEqual([
      { alias: "foo", user: "a", hostName: "x" },
      { alias: "bar", hostName: "x" },
    ])
  })

  it("applies wildcard blocks by pattern and honours negations", () => {
    const hs = hostsOf(
      "Host web-1 web-2 db\nHost web-* !web-2\n  User webuser\nHost *.corp\n  User corp\n",
    )
    expect(hs).toEqual([{ alias: "web-1", user: "webuser" }, { alias: "web-2" }, { alias: "db" }])
  })

  it("expands %h and %% in HostName", () => {
    expect(hostsOf("Host box\nHost *\n  HostName %h.corp.example\n")[0]!.hostName).toBe(
      "box.corp.example",
    )
    expect(hostsOf("Host a\n  HostName 100%%.x\n")[0]!.hostName).toBe("100%.x")
  })

  it("keeps the first value of a field within a block (OpenSSH semantics)", () => {
    const hs = hostsOf("Host a\n  HostName one\n  HostName two\n")
    expect(hs[0]!.hostName).toBe("one")
  })

  it("matches keywords case-insensitively", () => {
    const hs = hostsOf("HOST a\n  hostname h\n  USER u\n  pOrT 1\n")
    expect(hs).toEqual([{ alias: "a", hostName: "h", user: "u", port: "1" }])
  })

  it("applies options before the first Host to every host (an implicit Host *)", () => {
    const hs = hostsOf("User global\nHost a\n  User own\nHost b\n")
    expect(hs).toEqual([
      { alias: "a", user: "global" },
      { alias: "b", user: "global" },
    ])
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

  it("treats a bare `Host` as a block with no patterns", () => {
    const hs = hostsOf("Host a\nHost\n  User orphan\n")
    expect(hs).toEqual([{ alias: "a" }])
  })

  it("returns Include directives in order, with the Host patterns in effect", () => {
    const items = parseSshConfig("Host a\nInclude one two/*\nHost b c\nInclude three\nInclude\n")
    const incs = items.filter((i) => i.type === "include")
    expect(incs).toEqual([
      { type: "include", patterns: ["one", "two/*"], context: ["a"] },
      { type: "include", patterns: ["three"], context: ["b", "c"] },
    ])
  })

  it("gives an Include inside a Match block an empty context", () => {
    const items = parseSshConfig("Match all\nInclude x\n")
    expect(items.find((i) => i.type === "include")).toMatchObject({ context: [] })
  })

  it("starts with a `*` block for options before the first Host", () => {
    expect(parseSshConfig("User u\n")[0]).toEqual({
      type: "block",
      patterns: ["*"],
      fields: { user: "u" },
    })
  })

  it("continues a block after an Include so the included options come first", () => {
    const items = parseSshConfig("Host foo\n  User a\n  Include x\n  HostName b\n")
    expect(items.map((i) => i.type)).toEqual(["block", "block", "include", "block"]) // lead `*` first
    expect(items[1]).toMatchObject({ patterns: ["foo"], fields: { user: "a" } })
    expect(items[3]).toMatchObject({ patterns: ["foo"], fields: { hostName: "b" } })
  })

  it("marks hosts whose config sets ControlMaster or ControlPath", () => {
    expect(hostsOf("Host a\n  ControlMaster no\nHost b\n")).toEqual([
      { alias: "a", ownMux: true },
      { alias: "b" },
    ])
    expect(hostsOf("Host *\n  ControlPath ~/.ssh/cm-%C\nHost a\n")).toEqual([
      { alias: "a", ownMux: true },
    ])
    expect(hostsOf("Host a\n  ControlPersist 5m\n")).toEqual([{ alias: "a" }])
  })

  it("lists an alias once when spelled in different cases", () => {
    expect(hostsOf("Host Prod\n  User u\nHost prod\n  HostName h\n")).toEqual([
      { alias: "Prod", user: "u", hostName: "h" },
    ])
  })

  it("doesn't list an alias its own line negates", () => {
    expect(hostsOf("Host foo !foo bar\n")).toEqual([{ alias: "bar" }])
  })

  it("is not confused by keywords that are Object.prototype names", () => {
    const hs = hostsOf("Host a\n  constructor x\n  __proto__ y\n  toString z\n")
    expect(hs).toEqual([{ alias: "a" }])
  })

  it("lists no hosts for empty text and comment-only files", () => {
    expect(hostsOf("")).toEqual([])
    expect(hostsOf("# nothing\n\n   # here\n")).toEqual([])
  })

  it("accepts `Host=alias` syntax", () => {
    expect(aliases(hostsOf("Host=a\nHost = b c\n"))).toEqual(["a", "b", "c"])
  })
})

describe("hostMatcher", () => {
  it("matches exact names case-insensitively", () => {
    expect(hostMatcher(["Web"])("web")).toBe(true)
    expect(hostMatcher(["web"])("WEB")).toBe(true)
    expect(hostMatcher(["web"])("web2")).toBe(false)
  })

  it("supports * and ? and treats regex specials literally", () => {
    expect(hostMatcher(["*.corp"])("a.corp")).toBe(true)
    expect(hostMatcher(["*.corp"])("acorp")).toBe(false)
    expect(hostMatcher(["h?"])("h1")).toBe(true)
    expect(hostMatcher(["a+b"])("a+b")).toBe(true)
    expect(hostMatcher(["a+b"])("aab")).toBe(false)
  })

  it("vetoes on any negated match and needs a positive one", () => {
    expect(hostMatcher(["*", "!secret"])("secret")).toBe(false)
    expect(hostMatcher(["*", "!secret"])("other")).toBe(true)
    expect(hostMatcher(["!secret"])("other")).toBe(false)
    expect(hostMatcher([])("x")).toBe(false)
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

  it("treats `]` right after `[` or `[!` as a class member", () => {
    expect(m("[]a]*", "a.conf")).toBe(true)
    expect(m("[]a]*", "].conf")).toBe(true)
    expect(m("[]a]*", "b.conf")).toBe(false)
    expect(m("[!]a]x", "bx")).toBe(true)
    expect(m("[!]a]x", "]x")).toBe(false)
  })

  it("treats `[!]` with no closing bracket as literal text, never as match-anything", () => {
    expect(m("[!]", "[!]")).toBe(true)
    expect(m("[!]", "x")).toBe(false)
    expect(m("[]", "[]")).toBe(true)
  })

  it("escapes regex specials inside a class", () => {
    expect(m("[\\]", "\\")).toBe(true)
    expect(m("[.^]", "^")).toBe(true)
    expect(m("[.^]", "a")).toBe(false)
    expect(m("[a-]", "-")).toBe(true)
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
      // `Host *` makes the Include unconditional (after `Host first` it would only apply to first).
      "/h/.ssh/config": "Host first\nHost *\n  Include extra\nHost last\n",
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
      "/h/.ssh/inner": "HostName inner.example\nHost b\n",
    })
    // Its options apply to a; the hosts it defines only exist when connecting to a.
    expect(r.hosts).toEqual([{ alias: "a", user: "u", hostName: "inner.example" }])
  })

  it("skips a missing Include target without failing", async () => {
    const r = await load({ "/h/.ssh/config": "Include gone\nHost a\n" })
    expect(aliases(r.hosts)).toEqual(["a"])
    expect(r.files).toEqual(["/h/.ssh/config"])
  })

  it("survives an Include cycle", async () => {
    const r = await load({
      "/h/.ssh/config": "Include b\nHost a\n",
      "/h/.ssh/b": "Include config\nInclude b\nHost b\n",
    })
    expect(aliases(r.hosts)).toEqual(["b", "a"])
  })

  it("reads a file included from two parents only once", async () => {
    const files = {
      "/h/.ssh/config": "Include x y\n",
      "/h/.ssh/x": "Include shared\n",
      "/h/.ssh/y": "Include shared\n",
      "/h/.ssh/shared": "Host s\n",
    }
    const f = fakeFs(files)
    const r = await loadSshConfig({ file: "/h/.ssh/config", home: "/h", fs: f, path: path.posix })
    expect(aliases(r.hosts)).toEqual(["s"])
    expect(r.files).toEqual(["/h/.ssh/config", "/h/.ssh/x", "/h/.ssh/shared", "/h/.ssh/y"])
    expect(f.reads.filter((x) => x === "/h/.ssh/shared")).toHaveLength(1)
  })

  it("stays linear on a chain where every file includes the next twice", async () => {
    const files: Record<string, string> = {}
    for (let i = 0; i < 16; i++)
      files[i === 0 ? "/h/.ssh/config" : `/h/.ssh/f${i}`] =
        `Include f${i + 1} f${i + 1}\nHost h${i}\n`
    const f = fakeFs(files)
    const r = await loadSshConfig({ file: "/h/.ssh/config", home: "/h", fs: f, path: path.posix })
    expect(r.hosts).toHaveLength(16)
    expect(f.reads.length).toBeLessThanOrEqual(17)
  })

  it("scopes an included file's leading lines to the including Host block", async () => {
    const r = await load({
      "/h/.ssh/config": "Host a b\nHost a\n  Include a-extra\n",
      "/h/.ssh/a-extra": "User only-a\n",
    })
    expect(r.hosts).toEqual([{ alias: "a", user: "only-a" }, { alias: "b" }])
  })

  it("doesn't list hosts from an Include under a Host block they don't match", async () => {
    const r = await load({
      "/h/.ssh/config": "Host work-*\n  Include work.conf\nHost home\n",
      "/h/.ssh/work.conf": "Host bastion\n  HostName 10.0.0.5\nHost work-db\n  User dba\n",
    })
    expect(r.hosts).toEqual([{ alias: "work-db", user: "dba" }, { alias: "home" }])
  })

  it("doesn't list hosts from an Include under Match", async () => {
    const r = await load({
      "/h/.ssh/config": "Match exec true\n  Include extra\nHost a\n",
      "/h/.ssh/extra": "Host hidden\n",
    })
    expect(aliases(r.hosts)).toEqual(["a"])
  })

  it("applies nested include guards together", async () => {
    const r = await load({
      "/h/.ssh/config": "Host *.corp\n  Include l1\n",
      "/h/.ssh/l1": "Host db.corp web.corp\n  Include l2\n",
      "/h/.ssh/l2": "Host db.corp other.corp\n  User deep\n",
    })
    expect(r.hosts).toEqual([{ alias: "db.corp", user: "deep" }, { alias: "web.corp" }])
  })

  it("reads an included file's options before the rest of the including block", async () => {
    const r = await load({
      "/h/.ssh/config": "Host foo\n  Include extra.conf\n  HostName b.example\n",
      "/h/.ssh/extra.conf": "HostName a.example\n",
    })
    expect(r.hosts).toEqual([{ alias: "foo", hostName: "a.example" }])
  })

  it("applies a global Host * from an included file", async () => {
    const r = await load({
      "/h/.ssh/config": "Include defaults\nHost a\n",
      "/h/.ssh/defaults": "Host *\n  User everyone\n",
    })
    expect(r.hosts).toEqual([{ alias: "a", user: "everyone" }])
  })

  it("stops at the depth cap", async () => {
    const files: Record<string, string> = { "/h/.ssh/config": "Include d1\nHost d0\n" }
    for (let i = 1; i <= 5; i++) files[`/h/.ssh/d${i}`] = `Include d${i + 1}\nHost d${i}\n`
    const r = await load(files, 2)
    expect(aliases(r.hosts)).toEqual(["d2", "d1", "d0"])
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

describe("wslMiniFs", () => {
  const unc = (p: string) => "\\\\wsl.localhost\\Ubuntu" + p.replace(/\//g, "\\")
  const legacy = (p: string) => "\\\\wsl$\\Ubuntu" + p.replace(/\//g, "\\")

  it("maps Linux paths onto the distro's UNC share", async () => {
    const base = fakeFs({ [unc("/home/u/.ssh/config")]: "Host a\n" }, path.win32)
    const w = wslMiniFs("Ubuntu", base)
    expect(await w.readFile("/home/u/.ssh/config")).toBe("Host a\n")
    expect(await w.readdir("/home/u/.ssh")).toEqual(["config"])
  })

  it("falls back to the legacy \\\\wsl$ share", async () => {
    const base = fakeFs({ [legacy("/etc/ssh/extra")]: "Host e\n" }, path.win32)
    expect(await wslMiniFs("Ubuntu", base).readFile("/etc/ssh/extra")).toBe("Host e\n")
  })

  it("remembers the share prefix that answers", async () => {
    const files = {
      [legacy("/home/u/.ssh/config")]: "Include one two\n",
      [legacy("/home/u/.ssh/one")]: "Host one\n",
      [legacy("/home/u/.ssh/two")]: "Host two\n",
    }
    const base = fakeFs(files, path.win32)
    const r = await loadSshConfig({
      file: "/home/u/.ssh/config",
      home: "/home/u",
      fs: wslMiniFs("Ubuntu", base),
      path: path.posix,
    })
    expect(aliases(r.hosts)).toEqual(["one", "two"])
    // Only the first read misses on \\wsl.localhost; later ones go straight to \\wsl$.
    expect(base.reads.filter((x) => x.startsWith("\\\\wsl.localhost"))).toHaveLength(1)
  })

  it("returns null for relative paths and missing files", async () => {
    const w = wslMiniFs("Ubuntu", fakeFs({}, path.win32))
    expect(await w.readFile("relative")).toBeNull()
    expect(await w.readFile("/missing")).toBeNull()
  })

  it("lets the loader resolve absolute Includes inside the distro", async () => {
    const base = fakeFs(
      {
        [unc("/home/u/.ssh/config")]: "Include /etc/ssh/ssh_config.d/*.conf\nHost a\n",
        [unc("/etc/ssh/ssh_config.d/10-corp.conf")]: "Host corp\n",
      },
      path.win32,
    )
    const r = await loadSshConfig({
      file: "/home/u/.ssh/config",
      home: "/home/u",
      fs: wslMiniFs("Ubuntu", base),
      path: path.posix,
    })
    expect(aliases(r.hosts)).toEqual(["corp", "a"])
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
    fs.writeFileSync(path.join(dir, ".ssh", "config"), "Include config.d/*\nHost a\n")
    fs.writeFileSync(path.join(dir, ".ssh", "config.d", "work"), "Host b\n  HostName b.example\n")
    const r = await loadSshConfig({
      file: path.join(dir, ".ssh", "config"),
      home: dir,
      fs: nodeMiniFs,
      path,
    })
    expect(r.hosts).toEqual([{ alias: "b", hostName: "b.example" }, { alias: "a" }])
    expect(r.files).toHaveLength(2)
  })
})
