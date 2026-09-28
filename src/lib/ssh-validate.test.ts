import { describe, expect, it } from "vitest"
import { hasControlChar } from "./control-chars"
import {
  isSshEnv,
  isSshTarget,
  DEFAULT_HIDDEN_HOSTS,
  effectiveHidden,
  mergeSshSettings,
  parseRemoteRef,
  parseSshEnv,
  sshLabel,
} from "./ssh-validate"

describe("hasControlChar", () => {
  it("flags C0 controls and DEL only", () => {
    expect(hasControlChar("plain text / é 文")).toBe(false)
    for (const c of ["\u0000", "\n", "\t", "\r", "\u001b", "\u001f", "\u007f"]) {
      expect(hasControlChar(`a${c}b`)).toBe(true)
    }
    expect(hasControlChar("")).toBe(false)
  })
})

describe("isSshTarget", () => {
  it("accepts aliases, user@host, IPv6 and zone ids", () => {
    for (const t of [
      "web",
      "me@web.example",
      "[::1]",
      "root@10.0.0.1",
      "host_1.example",
      "fe80::1%en0",
      "a+b@h",
    ]) {
      expect(isSshTarget(t)).toBe(true)
    }
  })

  it("rejects options, shell metacharacters, whitespace, URIs, oversize and non-strings", () => {
    for (const t of [
      "-v",
      "a b",
      "a\u0000b",
      "",
      "x".repeat(256),
      null,
      {},
      3,
      "$(touch${IFS}/tmp/pwn)@host",
      "`id`@h",
      "a;b",
      "a|b",
      "a'b",
      'a"b',
      "a\\b",
      "ssh://me@web:2222",
      "web prod",
    ]) {
      expect(isSshTarget(t)).toBe(false)
    }
  })
})

describe("parseSshEnv / isSshEnv", () => {
  it("parses native and wsl envs", () => {
    expect(parseSshEnv("native")).toEqual({ kind: "native" })
    expect(parseSshEnv("wsl:Ubuntu-22.04")).toEqual({ kind: "wsl", distro: "Ubuntu-22.04" })
    expect(isSshEnv("wsl:Debian")).toBe(true)
  })

  it("rejects malformed envs and non-strings", () => {
    for (const e of [
      "",
      "wsl:",
      "wsl:Ubuntu; rm -rf",
      "WSL:Ubuntu",
      "docker:x",
      "wsl:a b",
      null,
      1,
    ]) {
      expect(parseSshEnv(e)).toBeNull()
      expect(isSshEnv(e)).toBe(false)
    }
  })
})

describe("mergeSshSettings", () => {
  it("defaults: nothing of your own hidden or shown, nothing pinned, 30 s keepalive, auto", () => {
    for (const v of [undefined, null, {}, "nope", 3]) {
      expect(mergeSshSettings(v)).toEqual({
        hidden: [],
        shown: [],
        pinned: [],
        keepAliveSeconds: 30,
        restore: "auto",
        colors: {},
      })
    }
  })

  it("keeps hidden as unique, trimmed, non-empty strings, capped", () => {
    expect(
      mergeSshSettings({ hidden: ["a", "a", "", " ", 3, null, "b", " prod "] }).hidden,
    ).toEqual(["a", "b", "prod"])
    expect(mergeSshSettings({ hidden: "a" }).hidden).toEqual([])
    expect(mergeSshSettings({ hidden: ["x".repeat(256), "ok", "a\u0007b"] }).hidden).toEqual(["ok"])
    const many = Array.from({ length: 1500 }, (_, i) => `h${i}`)
    expect(mergeSshSettings({ hidden: many }).hidden).toHaveLength(1000)
  })

  it("clamps and rounds keepAliveSeconds; 0 turns it off", () => {
    expect(mergeSshSettings({ keepAliveSeconds: 0 }).keepAliveSeconds).toBe(0)
    expect(mergeSshSettings({ keepAliveSeconds: 15.6 }).keepAliveSeconds).toBe(16)
    expect(mergeSshSettings({ keepAliveSeconds: -5 }).keepAliveSeconds).toBe(0)
    expect(mergeSshSettings({ keepAliveSeconds: 99999 }).keepAliveSeconds).toBe(3600)
    expect(mergeSshSettings({ keepAliveSeconds: "60" }).keepAliveSeconds).toBe(30)
    expect(mergeSshSettings({ keepAliveSeconds: Number.NaN }).keepAliveSeconds).toBe(30)
  })

  it("restore is auto unless explicitly on-focus", () => {
    expect(mergeSshSettings({ restore: "on-focus" }).restore).toBe("on-focus")
    expect(mergeSshSettings({ restore: "never" }).restore).toBe("auto")
  })

  it("returns fresh arrays every call", () => {
    const a = mergeSshSettings({})
    a.hidden.push("x")
    a.pinned.push("y")
    expect(mergeSshSettings({}).hidden).toEqual([])
    expect(mergeSshSettings({}).pinned).toEqual([])
  })
})

describe("parseRemoteRef", () => {
  it("keeps a valid ref's identity and drops anything else", () => {
    expect(
      parseRemoteRef({
        hostId: "native:web",
        label: "web",
        target: "web",
        env: "native",
        extra: 1,
      }),
    ).toEqual({ hostId: "native:web", label: "web", target: "web", env: "native" })
  })

  it("rejects bad ids, targets, envs and non-objects", () => {
    for (const bad of [
      null,
      "x",
      {},
      { hostId: "", target: "t", env: "native" },
      { hostId: "x".repeat(301), target: "t", env: "native" },
      { hostId: "a\u0000", target: "t", env: "native" },
      { hostId: "x", target: "a b", env: "native" },
      { hostId: "x", target: "t", env: "nope" },
    ]) {
      expect(parseRemoteRef(bad)).toBeNull()
    }
  })
})

describe("sshLabel", () => {
  it("uses a clean label, else the fallback, capped at 200", () => {
    expect(sshLabel("gpu box", "t")).toBe("gpu box")
    for (const bad of [undefined, "", "  ", "a\nb", 3]) expect(sshLabel(bad, "t")).toBe("t")
    expect(sshLabel("y".repeat(500), "t")).toHaveLength(200)
  })
})

describe("mergeSshSettings — colors", () => {
  it("keeps named colours and #rrggbb (lowercased), in order; drops the rest", () => {
    const c = mergeSshSettings({
      colors: {
        "prod-*": "red",
        " staging-* ": "AMBER",
        lab: "#AA00FF",
        bad1: "purple",
        bad2: "#abc",
        bad3: 3,
        "": "red",
        "a\u0007b": "red",
      },
    }).colors
    expect(c).toEqual({ "prod-*": "red", "staging-*": "amber", lab: "#aa00ff" })
    expect(Object.keys(c)).toEqual(["prod-*", "staging-*", "lab"])
  })

  it("isn't an object → none; capped at 100 patterns", () => {
    expect(mergeSshSettings({ colors: "red" }).colors).toEqual({})
    expect(mergeSshSettings({ colors: ["red"] }).colors).toEqual({})
    const many = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`h${i}`, "red"]))
    expect(Object.keys(mergeSshSettings({ colors: many }).colors)).toHaveLength(100)
  })
})

describe("mergeSshSettings — colors, edge cases", () => {
  it("colour names in any case; no named green (the focus / connected colour)", () => {
    expect(mergeSshSettings({ colors: { a: "Red", b: "BLUE", c: "green" } }).colors).toEqual({
      a: "red",
      b: "blue",
    })
  })

  it("patterns that look like object members are ordinary patterns", () => {
    const c = mergeSshSettings({
      colors: JSON.parse('{"constructor": "red", "toString": "amber", "__proto__": "blue"}'),
    }).colors
    expect(Object.keys(c).sort()).toEqual(["__proto__", "constructor", "toString"])
    expect(c.constructor).toBe("red")
    expect(Object.getPrototypeOf(c)).toBe(Object.prototype) // not replaced by "__proto__"
  })
})

describe("mergeSshSettings — pinned", () => {
  it("unique host ids, no control characters, capped", () => {
    expect(
      mergeSshSettings({ pinned: ["native:web", "native:web", "", 3, "a\u0007", "wsl:U:gpu"] })
        .pinned,
    ).toEqual(["native:web", "wsl:U:gpu"])
    expect(mergeSshSettings({ pinned: "native:web" }).pinned).toEqual([])
    const many = Array.from({ length: 300 }, (_, i) => `native:h${i}`)
    expect(mergeSshSettings({ pinned: many }).pinned).toHaveLength(200)
  })
})

describe("effectiveHidden", () => {
  it("your list plus the git defaults you haven't shown — a saved [] never unhides them", () => {
    expect(effectiveHidden({ hidden: [], shown: [] })).toEqual([...DEFAULT_HIDDEN_HOSTS])
    expect(effectiveHidden({ hidden: ["bastion"], shown: ["GitHub.com"] })).toEqual([
      "bastion",
      ...DEFAULT_HIDDEN_HOSTS.filter((a) => a !== "github.com"),
    ])
  })
})
