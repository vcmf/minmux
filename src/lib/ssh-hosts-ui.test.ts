import { describe, expect, it } from "vitest"
import type { Session } from "../types"
import { testHost } from "../test/helpers"
import { connectedHostIds, envTitle, groupHosts, hostShellOption, sameHosts } from "./ssh-hosts-ui"

const session = (id: string, remote?: Session["remote"]): Session => ({
  id,
  title: "",
  command: remote ? "ssh" : "/bin/zsh",
  args: [],
  status: "idle",
  unread: false,
  ...(remote ? { remote } : {}),
})

describe("hostShellOption", () => {
  it("carries only the host's identity, never its detail", () => {
    const opt = hostShellOption(testHost("gpu", "wsl:Ubuntu", "me@10.0.0.2"))
    expect(opt).toEqual({
      id: "wsl:Ubuntu:gpu",
      label: "gpu",
      command: "ssh",
      args: [],
      remote: { hostId: "wsl:Ubuntu:gpu", label: "gpu", target: "gpu", env: "wsl:Ubuntu" },
    })
  })

  it("returns a fresh remote object (a session never shares the store's host)", () => {
    const h = testHost("web")
    const opt = hostShellOption(h)
    expect(opt.remote).not.toBe(h)
  })
})

describe("envTitle", () => {
  it("names this machine and WSL distros", () => {
    expect(envTitle("native")).toBe("This machine")
    expect(envTitle("wsl:Ubuntu-22.04")).toBe("WSL: Ubuntu-22.04")
  })
})

describe("groupHosts", () => {
  it("groups by env in first-seen order, keeping host order", () => {
    const groups = groupHosts([
      testHost("a"),
      testHost("u1", "wsl:Ubuntu"),
      testHost("b"),
      testHost("d1", "wsl:Debian"),
      testHost("u2", "wsl:Ubuntu"),
    ])
    expect(groups.map((g) => [g.title, g.hosts.map((h) => h.label)])).toEqual([
      ["This machine", ["a", "b"]],
      ["WSL: Ubuntu", ["u1", "u2"]],
      ["WSL: Debian", ["d1"]],
    ])
  })

  it("is empty for no hosts", () => {
    expect(groupHosts([])).toEqual([])
  })
})

describe("connectedHostIds", () => {
  it("lists each host with an open session once, sorted; local sessions don't count", () => {
    const web = hostShellOption(testHost("web")).remote
    const db = hostShellOption(testHost("db")).remote
    expect(
      connectedHostIds({
        a: session("a", web),
        b: session("b"),
        c: session("c", db),
        d: session("d", web),
      }),
    ).toEqual(["native:db", "native:web"])
    expect(connectedHostIds({})).toEqual([])
  })
})

describe("sameHosts", () => {
  it("compares every listed field, in order", () => {
    const a = [testHost("a", "native", "x"), testHost("b")]
    expect(sameHosts(a, [testHost("a", "native", "x"), testHost("b")])).toBe(true)
    expect(sameHosts(a, [testHost("b"), testHost("a", "native", "x")])).toBe(false)
    expect(sameHosts(a, [testHost("a", "native", "y"), testHost("b")])).toBe(false)
    expect(sameHosts(a, [testHost("a", "native", "x")])).toBe(false)
    expect(sameHosts(a, [testHost("a", "native", "x"), { ...testHost("b"), target: "c" }])).toBe(
      false,
    )
  })
})
