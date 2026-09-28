import { describe, expect, it } from "vitest"
import {
  cleanRemoteCwd,
  cwdFromOsc7,
  cwdFromTitle,
  detailUser,
  homeRelative,
  remoteCwdName,
  sameMachine,
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

describe("sameMachine", () => {
  it("compares the first label (a title's short host vs OSC 7's full one)", () => {
    expect(sameMachine("box", "box.corp.example")).toBe(true)
    expect(sameMachine("box.corp.example", "box")).toBe(true)
    expect(sameMachine("box", "db")).toBe(false)
  })
})

describe("cleanRemoteCwd — spoofing", () => {
  it("rejects bidi, zero-width and C1 characters (they'd fake what the row shows)", () => {
    for (const bad of ["/home/u/\u202Egnp.cod", "/a\u200Bb", "/a\u2066b", "/a\u0085b"]) {
      expect(cleanRemoteCwd(bad)).toBeNull()
    }
    expect(cleanRemoteCwd("/données/项目")).toBe("/données/项目")
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
