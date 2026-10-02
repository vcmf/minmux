import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createOpencodeAdapter, mergeOpencodeConfig, opencodeShell, PLUGIN_FILE } from "./opencode"
import { OPENCODE_DROP_VERSION, OPENCODE_PLUGIN } from "./opencode-plugin"

const URL_ = "file:///home/u/.config/minmux/agents/minmux-opencode.js"
const plugins = (json: string | undefined) => (JSON.parse(json!) as { plugin: unknown[] }).plugin

describe("mergeOpencodeConfig", () => {
  it("no config of the user's: just our plugin", () => {
    expect(plugins(mergeOpencodeConfig(undefined, URL_))).toEqual([URL_])
    expect(plugins(mergeOpencodeConfig("  ", URL_))).toEqual([URL_])
  })
  it("keeps the user's config and plugins, adds ours", () => {
    const out = mergeOpencodeConfig('{"model":"x","plugin":["file:///p/user.js"]}', URL_)
    expect(JSON.parse(out!)).toEqual({ model: "x", plugin: [URL_, "file:///p/user.js"] })
    expect(plugins(mergeOpencodeConfig('{"model":"x"}', URL_))).toEqual([URL_])
  })
  it("drops another minmux's copy (a minmux started from a minmux pane), never twice ours", () => {
    const other = "file:///home/u/.config/minmux-dev/agents/minmux-opencode.js"
    const out = mergeOpencodeConfig(JSON.stringify({ plugin: [other, "npm-plugin", URL_] }), URL_)
    expect(plugins(out)).toEqual([URL_, "npm-plugin"])
  })
  it("leaves alone what it can't add to", () => {
    for (const bad of ["{not json", "[1]", '"x"', "null", '{"plugin":"one"}'])
      expect(mergeOpencodeConfig(bad, URL_)).toBeUndefined()
  })
})

const has = (bin: string) => spawnSync("which", [bin]).status === 0

describe("the rc wrapper keeps our plugin in OpenCode's inline config", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-oc-rc-"))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
  const url = pathToFileURL(path.join(dir, "a b", "agents", PLUGIN_FILE)).href
  // A fake `opencode` that prints the config it was started with.
  fs.writeFileSync(path.join(dir, "opencode"), '#!/bin/sh\nprintf %s "$OPENCODE_CONFIG_CONTENT"\n')
  fs.chmodSync(path.join(dir, "opencode"), 0o755)
  const run = (shell: "zsh" | "bash", value: string | undefined) => {
    const rc = path.join(dir, `rc.${shell}`)
    fs.writeFileSync(rc, `${opencodeShell[shell].join("\n")}\n`)
    // The user's rc exports its own value AFTER minmux set the env; `opencode` then runs.
    const set =
      value === undefined ? "unset OPENCODE_CONFIG_CONTENT" : 'export OPENCODE_CONFIG_CONTENT="$V"'
    const args = shell === "zsh" ? ["-i", "-c"] : ["--norc", "-i", "-c"]
    return execFileSync(shell, [...args, `source '${rc}'; ${set}; opencode`], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: dir,
        ZDOTDIR: dir,
        MINMUX_OPENCODE_PLUGIN: url,
        OPENCODE_CONFIG_CONTENT: '{"plugin":["set by minmux"]}',
        ...(value === undefined ? {} : { V: value }),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  }
  const shells = (["zsh", "bash"] as const).filter(has)
  const cases: [string | undefined, unknown[]][] = [
    [undefined, [url]],
    ["", [url]],
    ["{}", [url]],
    [" { } ", [url]],
    ['{"model":"x"}', [url]],
    ['{"plugin":[]}', [url]],
    ['{ "plugin" : [ "file:///p/user.js" ], "model": "x" }', [url, "file:///p/user.js"]],
    ['{\n  "plugin": ["a", "b"]\n}', [url, "a", "b"]],
  ]
  for (const shell of shells) {
    it(`${shell}: adds ours to whatever config the user set (valid JSON out)`, () => {
      for (const [value, want] of cases) expect(plugins(run(shell, value))).toEqual(want)
      expect(JSON.parse(run(shell, '{"model":"x"}'))).toEqual({ plugin: [url], model: "x" })
    })
    it(`${shell}: leaves alone a config that has ours, or that it can't add to`, () => {
      const ours = JSON.stringify({ plugin: [url] })
      for (const v of [ours, "[1]", "garbage", '{"plugin":"one"}']) expect(run(shell, v)).toBe(v)
    })
  }
})

describe("the plugin (loaded from its source, as OpenCode does)", () => {
  type Hooks = {
    event?: (a: { event: { type: string; properties?: unknown } }) => unknown
    "tool.execute.before"?: (input: unknown, output: unknown) => unknown
    "tool.execute.after"?: (input: unknown, output: unknown) => unknown
  }
  type Factory = (ctx: unknown) => Promise<Hooks>
  const LOADED = Symbol.for("minmux.opencode")
  // Vite only loads modules from the project: the copies go in its cache dir.
  const mods = path.resolve("node_modules/.cache/minmux-opencode-test")
  fs.mkdirSync(mods, { recursive: true })
  let root = ""
  let load: () => Promise<Factory>
  const saved = ["MINMUX_AGENT_EVENTS", "MINMUX_PANE_ID"].map((k) => [k, process.env[k]] as const)
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "minmux-oc-")))
    fs.mkdirSync(path.join(root, "opencode"))
    let n = 0
    // A fresh file per load: a fresh module (its own state), as each OpenCode process has.
    load = async () => {
      const file = path.join(mods, `plugin-${process.pid}-${n++}.mjs`)
      fs.writeFileSync(file, OPENCODE_PLUGIN)
      const mod = (await import(/* @vite-ignore */ file)) as { MinmuxPlugin: Factory }
      return mod.MinmuxPlugin
    }
    process.env.MINMUX_AGENT_EVENTS = root
    process.env.MINMUX_PANE_ID = "pane-1"
    delete (globalThis as Record<symbol, unknown>)[LOADED]
  })
  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    delete (globalThis as Record<symbol, unknown>)[LOADED]
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(mods, { recursive: true, force: true })
    fs.mkdirSync(mods, { recursive: true })
  })
  const files = () => fs.readdirSync(path.join(root, "opencode")).sort()
  /** Every drop, in name order, once the fire-and-forget writes have landed. */
  const drops = async (n: number) => {
    for (let i = 0; i < 100 && files().filter((f) => f.endsWith(".json")).length < n; i++)
      await new Promise((r) => setTimeout(r, 10))
    await new Promise((r) => setTimeout(r, 20))
    const names = files().filter((f) => f.endsWith(".json"))
    names.sort((a, b) => Number(a.split(".")[2]) - Number(b.split(".")[2]))
    return names.map((f) => JSON.parse(fs.readFileSync(path.join(root, "opencode", f), "utf8")))
  }
  const ev = (type: string, properties: unknown) => ({ event: { type, properties } })
  const root1 = { id: "ses_1", title: "New session", directory: "/repo" }

  it("a full turn: started, session, busy once, tools, idle with the bounded reply", async () => {
    const h = await (await load())({ directory: "/repo" })
    const e = h.event!
    e(ev("session.created", { info: root1 }))
    e(ev("session.updated", { info: root1 })) // unchanged: nothing
    e(ev("message.updated", { info: { id: "m_u", sessionID: "ses_1", role: "user" } }))
    e(
      ev("message.part.updated", {
        part: { type: "text", sessionID: "ses_1", messageID: "m_u", text: "MY PROMPT" },
      }),
    )
    for (let i = 0; i < 3; i++)
      e(ev("session.status", { sessionID: "ses_1", status: { type: "busy" } }))
    h["tool.execute.before"]!(
      { tool: "write", sessionID: "ses_1", callID: "c1" },
      { args: { filePath: "/repo/a.txt", content: "FILE CONTENT" } },
    )
    h["tool.execute.after"]!(
      { tool: "write", sessionID: "ses_1", callID: "c1" },
      { output: "TOOL OUTPUT" },
    )
    h["tool.execute.before"]!(
      { tool: "bash", sessionID: "ses_1", callID: "c2" },
      { args: { command: "rm X" } },
    )
    e(ev("message.updated", { info: { id: "m_a", sessionID: "ses_1", role: "assistant" } }))
    e(
      ev("message.part.updated", {
        part: { type: "text", sessionID: "ses_1", messageID: "m_a", text: "Do" },
      }),
    )
    const long = "Done. " + "x".repeat(5000)
    e(
      ev("message.part.updated", {
        part: { type: "text", sessionID: "ses_1", messageID: "m_a", text: long },
      }),
    )
    e(ev("session.status", { sessionID: "ses_1", status: { type: "idle" } }))
    e(ev("session.idle", { sessionID: "ses_1" })) // the same idle again: nothing
    const out = await drops(7)
    expect(out.map((d) => [d.e, d.phase ?? d.status ?? ""])).toEqual([
      ["started", ""],
      ["session", ""],
      ["status", "busy"],
      ["tool", "start"],
      ["tool", "end"],
      ["tool", "start"],
      ["status", "idle"],
    ])
    expect(out.every((d) => d.v === OPENCODE_DROP_VERSION)).toBe(true)
    expect(out[0]).toMatchObject({ directory: "/repo" })
    expect(out[1]).toMatchObject({ sessionID: "ses_1", title: "New session", directory: "/repo" })
    expect(out[3]).toMatchObject({ tool: "write", callID: "c1", paths: ["/repo/a.txt"] })
    expect(out[6]!.reply).toBe(long.slice(0, 2000))
    // A projection: no prompt, file, command or tool output ever leaves OpenCode.
    const all = JSON.stringify(out)
    for (const secret of ["MY PROMPT", "FILE CONTENT", "TOOL OUTPUT", "rm X"])
      expect(all).not.toContain(secret)
  })

  it("children name their parent; roots their folder; titles report on change", async () => {
    const h = await (await load())({ directory: "/base" })
    const e = h.event!
    e(ev("session.created", { info: { id: "ses_r", title: "t" } })) // no folder: the plugin's
    e(
      ev("session.created", {
        info: { id: "ses_c", parentID: "ses_r", title: "x (@general subagent)" },
      }),
    )
    e(ev("session.status", { sessionID: "ses_c", status: { type: "busy" } }))
    e(ev("session.updated", { info: { id: "ses_r", title: "Fix the bug" } }))
    e(
      ev("permission.asked", {
        sessionID: "ses_r",
        permission: "bash",
        metadata: { command: "SECRET" },
      }),
    )
    e(ev("session.status", { sessionID: "ses_x", status: { type: "busy" } })) // first seen mid-life
    const out = await drops(7)
    expect(out.slice(1)).toEqual([
      { v: 1, e: "session", sessionID: "ses_r", title: "t", directory: "/base" },
      { v: 1, e: "session", sessionID: "ses_c", title: "x (@general subagent)", parentID: "ses_r" },
      { v: 1, e: "status", sessionID: "ses_c", status: "busy", parentID: "ses_r" },
      { v: 1, e: "session", sessionID: "ses_r", title: "Fix the bug", directory: "/base" },
      {
        v: 1,
        e: "permission",
        phase: "asked",
        sessionID: "ses_r",
        tool: "bash",
        directory: "/base",
      },
      { v: 1, e: "status", sessionID: "ses_x", status: "busy", directory: "/base" },
    ])
  })

  it("never awaits: handlers return nothing and the write lands later", async () => {
    const h = await (await load())({ directory: "/repo" })
    await drops(1) // `started`
    const json = () => files().filter((f) => f.endsWith(".json")).length
    const before = json()
    expect(h.event!(ev("session.created", { info: root1 }))).toBeUndefined()
    expect(
      h["tool.execute.before"]!({ tool: "read", sessionID: "ses_1" }, { args: {} }),
    ).toBeUndefined()
    expect(json()).toBe(before) // not delivered synchronously
    expect((await drops(3)).length).toBe(3)
    expect(files().some((f) => f.endsWith(".tmp"))).toBe(false)
  })

  it("names drops <pane>.<pid>.<ts>.<seq>.json with strictly increasing times", async () => {
    const h = await (await load())({})
    for (let i = 0; i < 20; i++) h.event!(ev("session.created", { info: { id: `ses_${i}` } }))
    await drops(21)
    const names = files()
    const ts = names.map((f) => f.split("."))
    expect(
      ts.every((p) => p.length === 5 && p[0] === "pane-1" && p[1] === String(process.pid)),
    ).toBe(true)
    expect(new Set(ts.map((p) => p[2])).size).toBe(21)
  })

  it("ignores what it doesn't know, and junk never throws", async () => {
    const h = await (await load())({})
    for (const bad of [
      undefined,
      {},
      { event: null },
      ev("file.edited", { file: "/x" }),
      ev("session.status", null),
      ev("session.status", { sessionID: "s", status: { type: "weird" } }),
      ev("session.created", { info: 7 }),
      ev("message.part.updated", {}),
    ])
      expect(() => h.event!(bad as never)).not.toThrow()
    expect(() => h["tool.execute.before"]!(null, null)).not.toThrow()
    expect(await drops(1)).toHaveLength(1) // `started` only
  })

  it("tool paths: an edit's file and a patch's files, never a search tool's folder", async () => {
    const h = await (await load())({})
    const before = h["tool.execute.before"]!
    before({ tool: "grep", sessionID: "s" }, { args: { path: "/repo", pattern: "x" } })
    const patchText =
      "*** Begin Patch\n*** Update File: /repo/a.ts\n@@\n-SECRET\n*** Add File: /repo/b.ts\n+x\n*** End Patch"
    before({ tool: "apply_patch", sessionID: "s" }, { args: { patchText } })
    const out = await drops(3)
    expect(out[1]).not.toHaveProperty("paths")
    expect(out[2]!.paths).toEqual(["/repo/a.ts", "/repo/b.ts"])
    expect(JSON.stringify(out)).not.toContain("SECRET")
  })

  it("permissions say which ask a reply answers", async () => {
    const h = await (await load())({})
    h.event!(
      ev("permission.asked", {
        id: "per_1",
        sessionID: "s",
        permission: "bash",
        tool: { callID: "c9" },
      }),
    )
    h.event!(ev("permission.replied", { requestID: "per_1", sessionID: "s", reply: "once" }))
    const out = await drops(3)
    expect(out[1]).toMatchObject({
      e: "permission",
      phase: "asked",
      requestID: "per_1",
      callID: "c9",
    })
    expect(out[2]).toMatchObject({ e: "permission", phase: "replied", requestID: "per_1" })
  })

  it("the same copy called again (another project, a reload) reports too", async () => {
    const factory = await load()
    const a = await factory({ directory: "/one" })
    const b = await factory({ directory: "/two" })
    b.event!(ev("session.created", { info: { id: "ses_b", directory: "/two" } }))
    a.event!(ev("session.created", { info: { id: "ses_a", directory: "/one" } }))
    const out = await drops(4)
    expect(out.map((d) => d.sessionID ?? d.e)).toEqual(["started", "started", "ses_b", "ses_a"])
    expect(new Set(files()).size).toBe(4) // one counter per process: names never collide
  })

  it("inert outside a minmux pane, and loads once per process", async () => {
    delete process.env.MINMUX_AGENT_EVENTS
    expect(await (await load())({})).toEqual({})
    process.env.MINMUX_AGENT_EVENTS = root
    process.env.MINMUX_PANE_ID = "../escape"
    expect(await (await load())({})).toEqual({})
    process.env.MINMUX_PANE_ID = "pane-1"
    expect(Object.keys(await (await load())({}))).toContain("event")
    expect(await (await load())({})).toEqual({}) // another minmux's copy, in the same OpenCode
  })
})

describe("the opencode adapter", () => {
  const env = process.env.OPENCODE_CONFIG_CONTENT
  afterEach(() => {
    if (env === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = env
  })
  it("install writes the plugin; panes get it merged into the user's inline config", () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-oc-cfg-"))
    try {
      const a = createOpencodeAdapter()
      expect(a.env()).toEqual({})
      a.install(cfg)
      const file = path.join(cfg, "agents", PLUGIN_FILE)
      expect(fs.readFileSync(file, "utf8")).toBe(OPENCODE_PLUGIN)
      const url = pathToFileURL(file).href
      process.env.OPENCODE_CONFIG_CONTENT = '{"plugin":["mine"]}'
      expect(a.env()).toEqual({
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugin: [url, "mine"] }),
        MINMUX_OPENCODE_PLUGIN: url,
      })
      process.env.OPENCODE_CONFIG_CONTENT = "{jsonc /* comment */}"
      expect(a.env()).toEqual({}) // theirs wins: left as it is, and no wrapper either
    } finally {
      fs.rmSync(cfg, { recursive: true, force: true })
    }
  })
})
