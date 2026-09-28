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
  shortRemoteCwd,
} from "./remote-cwd"

describe("cleanRemoteCwd", () => {
  it("absolute, ~ or ~/…", () => {
    expect(cleanRemoteCwd("/srv/app")).toBe("/srv/app")
    expect(cleanRemoteCwd("~")).toBe("~")
    expect(cleanRemoteCwd("~/projects/x ")).toBe("~/projects/x")
  })

  it("rejects relative paths, control characters, ! (csh), oversize, non-strings", () => {
    for (const bad of [
      "projects",
      "~user/x",
      "/a\nb",
      "/a\u001b[2J",
      "/a!b",
      "/" + "x".repeat(1100),
      3,
      null,
      "",
    ]) {
      expect(cleanRemoteCwd(bad)).toBeNull()
    }
  })
})

describe("cwdFromOsc7 / cwdFromTitle", () => {
  it("OSC 7 file URLs, percent-decoded", () => {
    expect(cwdFromOsc7("file://gpu/home/me/my%20proj")).toBe("/home/me/my proj")
    expect(cwdFromOsc7("not a url")).toBeNull()
  })

  it("the Debian / Ubuntu title user@host: dir, and nothing else", () => {
    expect(cwdFromTitle("quang@gpu-box: ~/projects/llm")).toBe("~/projects/llm")
    expect(cwdFromTitle("root@db: /var/log")).toBe("/var/log")
    expect(cwdFromTitle("vim notes.md")).toBeNull()
    expect(cwdFromTitle("quang@gpu-box: htop")).toBeNull() // not a path
  })
})

describe("remoteCwdName / shortRemoteCwd", () => {
  it("the last segment; a long path keeps its tail", () => {
    expect(remoteCwdName("~/projects/llm-train/")).toBe("llm-train")
    expect(remoteCwdName("~")).toBe("~")
    expect(remoteCwdName("/")).toBe("/")
    expect(shortRemoteCwd("~/a/b")).toBe("~/a/b")
    const long = "/very/long/path/that/goes/on/and/on/and/finally/ends/here"
    const s = shortRemoteCwd(long, 24)
    expect(s.startsWith("…/")).toBe(true)
    expect(s.endsWith("ends/here")).toBe(true)
    expect(s.length).toBeLessThanOrEqual(24)
  })
})

// ssh hands the command to the remote login shell as `$SHELL -c '<command>'`. Run it that way
// in every shell here, with a SHELL that prints where it landed instead of starting a login.
const shells = ["sh", "bash", "zsh", "fish", "dash"].filter(
  (sh) => spawnSync("sh", ["-c", `command -v ${sh}`]).status === 0,
)

describe.each(shells)("remoteCdCommand through %s", (loginShell) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rcd-"))
  const probe = path.join(home, "probe.sh")
  fs.writeFileSync(probe, "#!/bin/sh\npwd\n", { mode: 0o755 })
  const run = (dir: string) =>
    execFileSync(loginShell, ["-c", remoteCdCommand(dir)], {
      encoding: "utf8",
      cwd: home, // ssh starts the remote command in the home directory
      env: { PATH: process.env.PATH, HOME: home, SHELL: probe },
    }).trim()
  const real = (p: string) => fs.realpathSync(p)

  it("lands in the folder, whatever its name holds", () => {
    for (const name of [
      "plain",
      "with space",
      "it's",
      'dq"x',
      "$HOME",
      "`id`",
      "semi;colon",
      "-dash",
    ]) {
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
