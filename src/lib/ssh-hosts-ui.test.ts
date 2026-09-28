import { describe, expect, it } from "vitest"
import type { Session } from "../types"
import { testHost } from "../test/helpers"
import {
  connectedHostIds,
  envTitle,
  groupHosts,
  hostShellOption,
  patternListMatch,
  hostSubline,
  globMatch,
  hostColor,
  hostColorCss,
  remoteWhere,
  sameHosts,
} from "./ssh-hosts-ui"

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
  it("lists each host with a live session once, sorted; local sessions don't count", () => {
    const web = hostShellOption(testHost("web")).remote
    const db = hostShellOption(testHost("db")).remote
    expect(
      connectedHostIds(
        {
          a: session("a", web),
          b: session("b"),
          c: session("c", db),
          d: session("d", web),
        },
        { a: "live", b: "live", c: "live", d: "live" },
      ),
    ).toEqual(["native:db", "native:web"])
    expect(connectedHostIds({}, {})).toEqual([])
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

describe("remote labels", () => {
  const native = hostShellOption(testHost("web")).remote!
  const wsl = hostShellOption(testHost("gpu", "wsl:Ubuntu")).remote!

  it("remoteWhere is the host's user@hostname from the list, else its alias; + distro for WSL", () => {
    const hosts = [
      testHost("web", "native", "me@10.0.0.1:2222"),
      testHost("gpu", "wsl:Ubuntu", "u@g"),
    ]
    expect(remoteWhere(native, hosts)).toBe("me@10.0.0.1:2222")
    expect(remoteWhere(wsl, hosts)).toBe("u@g · WSL: Ubuntu")
    expect(remoteWhere(native, [])).toBe("web") // not listed (yet): the alias
    expect(remoteWhere(wsl, [])).toBe("gpu · WSL: Ubuntu")
  })

  it("hostSubline is the distro and detail (the row's label is the host), skipping what's unset", () => {
    expect(hostSubline(testHost("web"))).toBe("")
    expect(hostSubline(testHost("web", "native", "me@h"))).toBe("me@h")
    expect(hostSubline(testHost("gpu", "wsl:Ubuntu", "u@g:2222"))).toBe("WSL: Ubuntu · u@g:2222")
  })
})

describe("connectedHostIds — only live panes count", () => {
  it("dialing, waiting, closed, failed and never-started panes don't count; a prompt does", () => {
    const web = hostShellOption(testHost("web")).remote
    const sessions = { a: session("a", web), b: session("b", web) }
    expect(connectedHostIds(sessions, { a: "closed", b: "live" })).toEqual(["native:web"])
    expect(connectedHostIds(sessions, { a: "prompt" })).toEqual(["native:web"]) // ssh runs
    for (const p of ["starting", "waiting", "closed", "failed"]) {
      expect(connectedHostIds(sessions, { a: p, b: p })).toEqual([])
    }
    expect(connectedHostIds(sessions, {})).toEqual([]) // a restored background tab, not started
  })
})

describe("hostColor", () => {
  it("matches ssh-style patterns, case-insensitively; the first match wins", () => {
    const colors = { "prod-*": "red", "staging-?": "amber", "*": "blue" }
    expect(hostColor("prod-db", colors)).toBe("red")
    expect(hostColor("PROD-api", colors)).toBe("red")
    expect(hostColor("staging-1", colors)).toBe("amber")
    expect(hostColor("staging-12", colors)).toBe("blue") // ? is one character
    expect(hostColor("anything", colors)).toBe("blue")
  })

  it("no colour unless one is set; regex characters in a pattern are literal", () => {
    expect(hostColor("web", {})).toBeUndefined()
    expect(hostColor("a.b", { "a.b": "red" })).toBe("red")
    expect(hostColor("axb", { "a.b": "red" })).toBeUndefined()
    expect(hostColor("h(1)", { "h(1)": "blue" })).toBe("blue")
  })
})

describe("hostColorCss", () => {
  it("named colours are theme tokens (light/dark follow); hex passes through", () => {
    expect(hostColorCss("red")).toBe("var(--red)")
    expect(hostColorCss("amber")).toBe("var(--amber)")
    expect(hostColorCss("blue")).toBe("var(--blue)")
    expect(hostColorCss("#aa00ff")).toBe("#aa00ff")
  })
})

describe("globMatch", () => {
  it("* and ?, case-insensitive, whole string", () => {
    expect(globMatch("prod-*", "prod-db")).toBe(true)
    expect(globMatch("*-db", "prod-db")).toBe(true)
    expect(globMatch("p?od", "PROD")).toBe(true)
    expect(globMatch("prod", "prod-db")).toBe(false)
    expect(globMatch("*", "")).toBe(true)
    expect(globMatch("a*b*c", "axxbyyc")).toBe(true)
    expect(globMatch("a*b*c", "axxbyy")).toBe(false)
  })

  it("a pathological pattern stays fast (no regex backtracking)", () => {
    const pattern = "*".repeat(120) + "x"
    const t0 = performance.now()
    for (let i = 0; i < 200; i++) globMatch(pattern, "a".repeat(60))
    expect(performance.now() - t0).toBeLessThan(200)
    expect(globMatch(pattern, "a".repeat(60))).toBe(false)
    expect(globMatch("*a*a*a*a*a*a*a*a*b", "a".repeat(80))).toBe(false)
  })
})

describe("patternListMatch", () => {
  it("ssh-style lists: any positive entry, and no negated one", () => {
    expect(patternListMatch("prod-*,db-*", "db-1")).toBe(true)
    expect(patternListMatch("prod-*, db-*", "db-1")).toBe(true)
    expect(patternListMatch("prod-*,!prod-test", "prod-test")).toBe(false)
    expect(patternListMatch("prod-*,!prod-test", "prod-api")).toBe(true)
    expect(patternListMatch("!bastion", "web")).toBe(false) // negations alone match nothing
    expect(patternListMatch(",,", "web")).toBe(false)
  })
})

describe("sameHosts — the hidden flag", () => {
  it("a relist that only hides or shows a host is a change (Hide host must take effect)", () => {
    const web = testHost("web")
    expect(sameHosts([web], [{ ...web, hidden: true }])).toBe(false)
  })
})
