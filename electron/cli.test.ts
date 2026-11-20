import { describe, expect, it } from "vitest"
import { ackOf, asOpenRequest, isStale, parseCli, receivedOpen, STALE_MS } from "./cli"

const app = "/Applications/minmux.app/Contents/MacOS/minmux"
const parse = (...args: string[]) => parseCli([app, ...args], "/home/me/repo")

describe("parseCli", () => {
  it("no subcommand is a plain launch (dev app path, Chromium switches)", () => {
    expect(parse()).toBeNull()
    expect(parse(".", "--profile=dev")).toBeNull()
    expect(parse("-psn_0_12345")).toBeNull()
  })

  it("help: --help, help, open --help", () => {
    expect(parse("--help")).toEqual({ help: true })
    expect(parse("help")).toEqual({ help: true })
    expect(parse("open", "--tab", "x", "-h")).toEqual({ help: true })
  })

  it("open defaults to the caller's cwd, the active tab, the shell", () => {
    expect(parse("open")).toEqual({ open: { cwd: "/home/me/repo" } })
    expect(parse(".", "--profile=dev", "open")).toEqual({ open: { cwd: "/home/me/repo" } })
  })

  it("takes --tab, --cwd (relative to the caller), --split, both spellings", () => {
    expect(parse("open", "--tab", "wave 1", "--cwd", "../wt", "--split", "down")).toEqual({
      open: { tab: "wave 1", cwd: "/home/me/wt", split: "down" },
    })
    expect(parse("open", "--tab=a=b", "--cwd=/abs", "--split=right")).toEqual({
      open: { tab: "a=b", cwd: "/abs", split: "right" },
    })
  })

  it("everything after -- is the command, verbatim (its own flags included)", () => {
    expect(parse("open", "--", "sh", "-c", "echo hi; sleep 30", "--tab")).toEqual({
      open: { cwd: "/home/me/repo", command: ["sh", "-c", "echo hi; sleep 30", "--tab"] },
    })
  })

  it("errors: unknown options, stray words, missing or bad values", () => {
    expect(parse("open", "--tabs", "x")).toEqual({ error: "unknown option --tabs" })
    expect(parse("open", "claude")).toEqual({
      error: "unexpected argument claude (put the command after --)",
    })
    expect(parse("open", "--tab")).toEqual({ error: "--tab needs a value" })
    expect(parse("open", "--tab", "--cwd", "/x")).toEqual({ error: "--tab needs a value" })
    expect(parse("open", "--tab=--cwd")).toEqual({ open: { cwd: "/home/me/repo", tab: "--cwd" } })
    expect(parse("open", "--tab", " ")).toEqual({ error: "--tab needs a non-empty title" })
    expect(parse("open", "--cwd=")).toEqual({ error: "--cwd needs a directory" })
    expect(parse("open", "--split", "left")).toEqual({
      error: "--split must be right or down, not left",
    })
    expect(parse("open", "--")).toEqual({ error: "missing command after --" })
  })
})

describe("asOpenRequest", () => {
  it("keeps a well-formed request, nothing else", () => {
    const req = { cwd: "/a", tab: "t", split: "down", command: ["sh"] }
    expect(asOpenRequest({ ...req, extra: 1 })).toEqual(req)
    expect(asOpenRequest({ cwd: "/a" })).toEqual({ cwd: "/a" })
  })

  it("rejects what parseCli would never produce", () => {
    for (const bad of [
      null,
      "open",
      {},
      { cwd: "rel" },
      { cwd: "/a", tab: "" },
      { cwd: "/a", split: "left" },
      { cwd: "/a", command: [] },
      { cwd: "/a", command: ["sh", 1] },
    ])
      expect(asOpenRequest(bad)).toBeNull()
  })
})

describe("receivedOpen (the lock holder's second-instance path)", () => {
  const run = (data: unknown) => {
    const invalid: string[] = []
    return { req: receivedOpen(data, (r) => invalid.push(r)), invalid }
  }

  it("a plain second launch carries nothing: no request, nothing logged", () => {
    for (const data of [undefined, null, {}, "x", 3]) expect(run(data)).toEqual({ invalid: [] })
  })

  it("hands a valid request on", () => {
    expect(run({ open: { cwd: "/w", tab: "t", command: ["sh"] } }).req).toEqual({
      cwd: "/w",
      tab: "t",
      command: ["sh"],
    })
  })

  it("never throws on a malformed one: logs it and opens nothing", () => {
    const cyclic: Record<string, unknown> = { cwd: "rel" }
    cyclic.self = cyclic
    const hostile = {
      get open(): unknown {
        throw new Error("boom")
      },
    }
    for (const data of [
      { open: null },
      { open: "open" },
      { open: { cwd: "rel" } },
      { open: { cwd: "/w", command: [1n] } },
      { open: cyclic },
      hostile,
    ]) {
      const r = run(data)
      expect(r.req).toBeUndefined()
      expect(r.invalid).toHaveLength(1)
    }
  })
})

describe("ackOf", () => {
  it("only the shim's own ack file, never another path a request names", () => {
    const ack = "/var/folders/x/T/minmux-cli.Ab12Cd/ack"
    expect(ackOf({ ack })).toBe(ack)
    for (const bad of ["/Users/me/.zshrc", "/tmp/minmux-cli.x/other", "rel/minmux-cli.x/ack", 3])
      expect(ackOf({ ack: bad })).toBeUndefined()
    expect(ackOf(null)).toBeUndefined()
    expect(
      ackOf({
        get ack(): unknown {
          throw new Error("boom")
        },
      }),
    ).toBeUndefined()
  })
})

describe("isStale", () => {
  it("older than STALE_MS by the sender's clock; no time → never stale", () => {
    expect(isStale({ at: 1000 }, 1000 + STALE_MS)).toBe(false)
    expect(isStale({ at: 1000 }, 1001 + STALE_MS)).toBe(true)
    expect(isStale({ open: {} }, Date.now())).toBe(false)
    expect(isStale(null, Date.now())).toBe(false)
  })
})
