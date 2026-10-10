import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest"
import { threadId } from "node:worker_threads"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import {
  SESSION_ID,
  createOpencodeAdapter,
  mergeOpencodeConfig,
  normalizeOpencodeDrop,
  opencodeShell,
  PLUGIN_FILE,
} from "./opencode"
import { reduceAgentEvents, subAgents, type AgentEvent } from "../../src/lib/agent-graph"
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
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
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
  // Vite only loads modules from the project: the copies go in its cache dir — one folder per
  // test process, so parallel runs (a pre-push hook beside `make test`, worktrees sharing
  // node_modules) never delete each other's copies.
  const mods = path.resolve(`node_modules/.cache/minmux-opencode-test/${process.pid}-${threadId}`)
  fs.mkdirSync(mods, { recursive: true })
  afterAll(() => fs.rmSync(mods, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 }))
  let root = ""
  let load: () => Promise<Factory>
  const saved = ["MINMUX_AGENT_EVENTS", "MINMUX_PANE_ID", "MINMUX_RESUME_SESSION"].map(
    (k) => [k, process.env[k]] as const,
  )
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "minmux-oc-")))
    fs.mkdirSync(path.join(root, "opencode"))
    let n = 0
    // A fresh file per load: a fresh module (its own state), as each OpenCode process has.
    load = async () => {
      const file = path.join(mods, `plugin-${n++}.mjs`)
      fs.writeFileSync(file, OPENCODE_PLUGIN)
      const mod = (await import(/* @vite-ignore */ file)) as { MinmuxPlugin: Factory }
      return mod.MinmuxPlugin
    }
    process.env.MINMUX_AGENT_EVENTS = root
    process.env.MINMUX_PANE_ID = "pane-1"
    delete (globalThis as Record<symbol, unknown>)[LOADED]
  })
  afterEach(async () => {
    // A test may end with a write still on its way (a load it didn't wait for): let the folder
    // go quiet first, or the delete races it (ENOTEMPTY).
    await quiet(() => true, 30, 3000)
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    delete (globalThis as Record<symbol, unknown>)[LOADED]
    // A write still landing can refill a folder mid-delete (ENOTEMPTY): retry (Node's own).
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    fs.rmSync(mods, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
    fs.mkdirSync(mods, { recursive: true })
  })
  const files = () => {
    try {
      return fs.readdirSync(path.join(root, "opencode")).sort()
    } catch {
      return [] // already gone
    }
  }
  const settled = () => files().filter((f) => f.endsWith(".json"))
  /** The plugin's writes are fire-and-forget (temp + rename): wait until no temp file is
   *  mid-write and nothing new has appeared for `ms` (`long` ms until `enough()`), or `cap`
   *  ms in all. A busy machine only makes this slower, never wrong. */
  const quiet = async (enough: () => boolean, ms: number, cap: number, long = ms) => {
    const deadline = Date.now() + cap
    let last = ""
    let since = Date.now()
    while (Date.now() < deadline) {
      const all = files() // one listing per poll
      const now = all.join("|")
      if (now !== last) {
        last = now
        since = Date.now()
      }
      const busy = all.some((f) => !f.endsWith(".json"))
      if (!busy && Date.now() - since >= (enough() ? ms : long)) return
      await new Promise((r) => setTimeout(r, 10))
    }
  }
  /** Every drop, in name order, once exactly-expected `n` have landed and the folder is quiet
   *  (so a stray extra one shows too). Never "whatever came in 500 ms": fewer than `n` waits to
   *  the cap (under the test's 5 s) and the assertion then says what's missing. */
  const drops = async (n: number) => {
    await quiet(() => settled().length >= n, 60, 4000, Infinity)
    const names = settled()
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
    const out = await drops(8)
    expect(out.map((d) => [d.e, d.phase ?? d.status ?? ""])).toEqual([
      ["started", ""],
      ["start", ""],
      ["session", ""],
      ["status", "busy"],
      ["tool", "start"],
      ["tool", "end"],
      ["tool", "start"],
      ["status", "idle"],
    ])
    expect(out.every((d) => d.v === OPENCODE_DROP_VERSION)).toBe(true)
    expect(out[0]).toMatchObject({ directory: "/repo" })
    expect(out[1]).toEqual({
      v: 1,
      e: "start",
      sessionID: "ses_1",
      source: "new",
      directory: "/repo",
    })
    expect(out[2]).toMatchObject({ sessionID: "ses_1", title: "New session", directory: "/repo" })
    expect(out[4]).toMatchObject({ tool: "write", callID: "c1", paths: ["/repo/a.txt"] })
    expect(out[7]!.reply).toBe(long.slice(0, 2000))
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
    // First seen mid-life (picked in /sessions): its prompt brings its info, then busy.
    e(ev("session.updated", { info: { id: "ses_x", directory: "/base" } }))
    e(ev("session.status", { sessionID: "ses_x", status: { type: "busy" } }))
    const out = await drops(11)
    const child = { parentID: "ses_r", rootID: "ses_r" }
    expect(out.slice(1)).toEqual([
      { v: 1, e: "start", sessionID: "ses_r", source: "new", directory: "/base" },
      { v: 1, e: "session", sessionID: "ses_r", title: "t", directory: "/base" },
      { v: 1, e: "start", sessionID: "ses_c", title: "x (@general subagent)", ...child },
      { v: 1, e: "session", sessionID: "ses_c", title: "x (@general subagent)", ...child },
      { v: 1, e: "status", sessionID: "ses_c", status: "busy", ...child },
      { v: 1, e: "session", sessionID: "ses_r", title: "Fix the bug", directory: "/base" },
      {
        v: 1,
        e: "permission",
        phase: "asked",
        sessionID: "ses_r",
        tool: "bash",
        directory: "/base",
      },
      { v: 1, e: "session", sessionID: "ses_x", directory: "/base" },
      // Another root becoming active (picked in /sessions, --session): it starts, as "seen".
      { v: 1, e: "start", sessionID: "ses_x", source: "seen", directory: "/base" },
      { v: 1, e: "status", sessionID: "ses_x", status: "busy", directory: "/base" },
    ])
  })

  it("a root the user left ends once idle; a running one when its turn does", async () => {
    const h = await (await load())({ directory: "/base" })
    const e = h.event!
    const status = (id: string, type: string) =>
      e(ev("session.status", { sessionID: id, status: { type } }))
    e(ev("session.created", { info: { id: "ses_a" } }))
    status("ses_a", "busy")
    e(ev("session.created", { info: { id: "ses_b" } })) // /new while ses_a's turn runs
    status("ses_a", "idle") // …which then ends
    status("ses_b", "busy")
    status("ses_b", "idle")
    e(ev("session.updated", { info: { id: "ses_a", title: "again" } }))
    status("ses_a", "busy") // picked again (or a queued prompt): it starts again; ses_b stays
    const out = await drops(13)
    const life = out
      .filter((d) => d.e === "start" || d.e === "end")
      .map((d) => `${d.e} ${d.sessionID}`)
    expect(life).toEqual(["start ses_a", "start ses_b", "end ses_a", "start ses_a"])
    // ses_a's end comes after its own idle (its reply is on the board first).
    const i = out.findIndex((d) => d.e === "end")
    expect(out[i - 1]).toMatchObject({ e: "status", sessionID: "ses_a", status: "idle" })
  })

  it("a long run's many sub-agents never push out its root", async () => {
    const h = await (await load())({ directory: "/base" })
    const e = h.event!
    e(ev("session.created", { info: { id: "ses_r" } }))
    e(ev("session.status", { sessionID: "ses_r", status: { type: "busy" } }))
    for (let i = 0; i < 300; i++)
      e(ev("session.created", { info: { id: `ses_c${i}`, parentID: "ses_r" } }))
    e(ev("session.created", { info: { id: "ses_n" } })) // /new: the root it left still ends
    e(ev("session.status", { sessionID: "ses_r", status: { type: "idle" } }))
    // started + start r + session r + busy + 300 × (start + session) + start n + session n + idle + end
    const out = await drops(608)
    expect(out.at(-1)).toMatchObject({ e: "end", sessionID: "ses_r", directory: "/base" })
    // The latest children still name their root.
    expect(out.filter((d) => d.sessionID === "ses_c299").every((d) => d.rootID === "ses_r")).toBe(
      true,
    )
  })

  it("tokens: the last reply's context and the session's output, on change, for children too", async () => {
    const h = await (await load())({ directory: "/base" })
    const e = h.event!
    const msg = (sessionID: string, id: string, tokens: object, completed?: number) =>
      e(
        ev("message.updated", {
          info: { id, sessionID, role: "assistant", tokens, time: { completed } },
        }),
      )
    const sess = (id: string, tokens: object, parentID?: string) =>
      e(ev("session.updated", { info: { id, parentID, tokens } }))
    const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    e(ev("session.created", { info: { id: "ses_r", tokens: zero } })) // nothing used: no report
    msg("ses_r", "m1", { input: 9847, output: 33, reasoning: 0, cache: { read: 1938, write: 5 } }) // streaming
    msg(
      "ses_r",
      "m1",
      { input: 9847, output: 33, reasoning: 0, cache: { read: 1938, write: 5 } },
      1,
    )
    sess("ses_r", { input: 9847, output: 33, reasoning: 7, cache: { read: 1938, write: 5 } })
    sess("ses_r", { input: 9847, output: 33, reasoning: 7, cache: { read: 1938, write: 5 } }) // same
    e(ev("session.created", { info: { id: "ses_c", parentID: "ses_r" } }))
    msg("ses_c", "m2", { input: 500, output: 9, reasoning: 0, cache: { read: 0, write: 0 } }, 2)
    const out = (await drops(8)).filter((d) => d.e === "tokens")
    expect(out).toEqual([
      { v: 1, e: "tokens", sessionID: "ses_r", context: 11790, output: 0, directory: "/base" },
      { v: 1, e: "tokens", sessionID: "ses_r", context: 11790, output: 40, directory: "/base" },
      {
        v: 1,
        e: "tokens",
        sessionID: "ses_c",
        context: 500,
        output: 0,
        parentID: "ses_r",
        rootID: "ses_r",
      },
    ])
  })

  it("tokens wait for the session's start and a known context (a resumed one's come first)", async () => {
    const h = await (await load())({ directory: "/base" })
    const e = h.event!
    const t = { input: 100, output: 50, reasoning: 0, cache: { read: 900, write: 0 } }
    // `opencode -s`: its info (with totals) comes before its prompt starts it.
    e(ev("session.updated", { info: { id: "ses_a", title: "old", tokens: t } }))
    e(
      ev("message.updated", {
        info: { id: "m", sessionID: "ses_a", role: "assistant", tokens: t, time: { completed: 1 } },
      }),
    )
    e(ev("session.status", { sessionID: "ses_a", status: { type: "busy" } })) // its start
    const out = await drops(4)
    expect(out.filter((d) => d.e === "tokens")).toEqual([]) // never before its start…
    expect(out.find((d) => d.e === "start")).toMatchObject({ context: 1000, output: 50 }) // …with it
  })

  it("a picked-again root gets its badge back; an aborted reply never reads as 0 context", async () => {
    const h = await (await load())({ directory: "/base" })
    const e = h.event!
    const status = (id: string, type: string) =>
      e(ev("session.status", { sessionID: id, status: { type } }))
    const t = { input: 100, output: 5, reasoning: 0, cache: { read: 900, write: 0 } }
    e(ev("session.created", { info: { id: "ses_a" } }))
    status("ses_a", "busy")
    e(
      ev("message.updated", {
        info: {
          id: "m1",
          sessionID: "ses_a",
          role: "assistant",
          tokens: t,
          time: { completed: 1 },
        },
      }),
    )
    status("ses_a", "idle")
    // Esc mid-reply: completed with an error and no tokens.
    const none = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    e(
      ev("message.updated", {
        info: {
          id: "m2",
          sessionID: "ses_a",
          role: "assistant",
          tokens: none,
          time: { completed: 2 },
          error: { name: "Aborted" },
        },
      }),
    )
    e(ev("session.created", { info: { id: "ses_b" } })) // /new: ses_a ends (idle)
    e(ev("session.updated", { info: { id: "ses_a", title: "x" } }))
    status("ses_a", "busy") // picked again
    const out = await drops(12)
    const a = out.filter(
      (d) => d.sessionID === "ses_a" && (d.e === "tokens" || d.e === "start" || d.e === "end"),
    )
    expect(a.map((d) => `${d.e} ${d.context ?? ""}`.trim())).toEqual([
      "start", // nothing used yet
      "tokens 1000",
      "end",
      "start 1000", // picked again: its badge comes with its new node
    ])
  })

  it("a resume starts at once from OpenCode's own lookup; an unknown id never does", async () => {
    const SES = "ses_f02cfead3ffecevT8eQkttqOR5"
    const info = { id: SES, title: "auth-rework", directory: "/repo" }
    const get = async ({ path: { id } }: { path: { id: string } }) =>
      id === SES ? { data: info } : { error: { name: "NotFoundError" } }
    process.env.MINMUX_RESUME_SESSION = SES
    await (
      await load()
    )({ directory: "/repo", client: { session: { get } } })
    expect(process.env.MINMUX_RESUME_SESSION).toBeUndefined() // not for what it runs
    const out = await drops(3)
    expect(out.slice(1)).toEqual([
      { v: 1, e: "session", sessionID: SES, title: "auth-rework", directory: "/repo" },
      { v: 1, e: "start", sessionID: SES, source: "seen", directory: "/repo" },
    ])
    expect(normalizeOpencodeDrop(out[2])).toMatchObject({ event: "SessionStart", source: "resume" })
  })

  it("a late answer doesn't take over a session the user moved to meanwhile", async () => {
    const SES = "ses_f02cfead3ffecevT8eQkttqOR5"
    let answer: (v: unknown) => void = () => {}
    const get = () => new Promise((r) => (answer = r))
    process.env.MINMUX_RESUME_SESSION = SES
    const h = await (await load())({ directory: "/repo", client: { session: { get } } })
    h.event!(ev("session.created", { info: { id: "ses_new" } })) // /new before the answer
    answer({ data: { id: SES, title: "old", directory: "/repo" } })
    const out = await drops(3)
    expect(out.filter((d) => d.e === "start").map((d) => d.sessionID)).toEqual(["ses_new"])
  })

  it("a resume of an id OpenCode doesn't know reports nothing (it exits 1)", async () => {
    process.env.MINMUX_RESUME_SESSION = "ses_doesnotexist0000000000000"
    const get = async () => ({ error: { name: "NotFoundError" } })
    await (
      await load()
    )({ directory: "/repo", client: { session: { get } } })
    expect(await drops(1)).toHaveLength(1) // `started` only
    process.env.MINMUX_RESUME_SESSION = "not an id; rm -rf ~"
    delete (globalThis as Record<symbol, unknown>)[LOADED] // a fresh OpenCode
    let asked = false
    await (
      await load()
    )({ client: { session: { get: async () => ((asked = true), {}) } } })
    expect(asked).toBe(false) // never even asked
  })

  it("a child whose chain is broken names no root (never filed as one)", async () => {
    const h = await (await load())({ directory: "/base" })
    const e = h.event!
    // ses_c's parent was never seen (this copy loaded mid-session).
    e(ev("session.created", { info: { id: "ses_c", parentID: "ses_gone" } }))
    e(ev("session.status", { sessionID: "ses_c", status: { type: "busy" } }))
    const out = await drops(3)
    expect(out.filter((d) => d.e === "start")).toEqual([])
    expect(out.slice(1).every((d) => d.parentID === "ses_gone" && !("rootID" in d))).toBe(true)
    expect(out.slice(1).map((d) => normalizeOpencodeDrop(d))).toEqual([null, null])
  })

  it("a background session's tools never move the lead; an unknown session never starts", async () => {
    const h = await (await load())({ directory: "/base" })
    const e = h.event!
    const busy = (id: string) =>
      e(ev("session.status", { sessionID: id, status: { type: "busy" } }))
    e(ev("session.created", { info: { id: "ses_a" } }))
    busy("ses_a")
    e(ev("session.created", { info: { id: "ses_b" } })) // /new while ses_a's turn still runs
    busy("ses_b")
    h["tool.execute.before"]!({ tool: "read", sessionID: "ses_a", callID: "c" }, { args: {} })
    busy("ses_u") // no info yet: maybe a child whose parent this copy never saw (a reload)
    h["tool.execute.before"]!({ tool: "read", sessionID: "ses_u", callID: "d" }, { args: {} })
    const out = await drops(10)
    expect(out.filter((d) => d.e === "start").map((d) => d.sessionID)).toEqual(["ses_a", "ses_b"])
    expect(out.filter((d) => d.sessionID === "ses_u").map((d) => d.e)).toEqual(["status", "tool"])
  })

  it("the lead follows activity: back to an earlier root, it starts again; deeper children", async () => {
    const h = await (await load())({ directory: "/base" })
    const e = h.event!
    const busy = (id: string) =>
      e(ev("session.status", { sessionID: id, status: { type: "busy" } }))
    const idle = (id: string) =>
      e(ev("session.status", { sessionID: id, status: { type: "idle" } }))
    e(ev("session.created", { info: { id: "ses_a" } }))
    busy("ses_a")
    idle("ses_a")
    e(ev("session.created", { info: { id: "ses_b" } })) // /new
    busy("ses_b")
    idle("ses_b")
    busy("ses_a") // picked again in /sessions
    e(ev("session.created", { info: { id: "ses_c1", parentID: "ses_a" } }))
    e(ev("session.created", { info: { id: "ses_c2", parentID: "ses_c1" } })) // a custom agent's own
    busy("ses_c2")
    const out = await drops(17)
    const starts = out
      .filter((d) => d.e === "start")
      .map((d) => [d.sessionID, d.source ?? d.rootID])
    expect(starts).toEqual([
      ["ses_a", "new"],
      ["ses_b", "new"],
      ["ses_a", "seen"],
      ["ses_c1", "ses_a"],
      ["ses_c2", "ses_a"],
    ])
    expect(out.at(-1)).toMatchObject({ sessionID: "ses_c2", parentID: "ses_c1", rootID: "ses_a" })
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
    expect((await drops(4)).length).toBe(4) // + the session's start
    expect(files().some((f) => f.endsWith(".tmp"))).toBe(false)
  })

  it("names drops <pane>.<pid>.<ts>.<seq>.json with strictly increasing times", async () => {
    const h = await (await load())({})
    for (let i = 0; i < 20; i++) h.event!(ev("session.created", { info: { id: `ses_${i}` } }))
    await drops(60) // `started`, then a start + a session each, and each one /new left ends
    const names = files()
    const ts = names.map((f) => f.split("."))
    expect(
      ts.every((p) => p.length === 5 && p[0] === "pane-1" && p[1] === String(process.pid)),
    ).toBe(true)
    expect(new Set(ts.map((p) => p[2])).size).toBe(60)
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
    const out = (await drops(3)).filter((d) => d.e === "tool")
    expect(out[0]).not.toHaveProperty("paths")
    expect(out[1]!.paths).toEqual(["/repo/a.ts", "/repo/b.ts"])
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
    const out = (await drops(3)).filter((d) => d.e === "permission")
    expect(out[0]).toMatchObject({
      e: "permission",
      phase: "asked",
      requestID: "per_1",
      callID: "c9",
    })
    expect(out[1]).toMatchObject({
      e: "permission",
      phase: "replied",
      requestID: "per_1",
      callID: "c9",
    })
  })

  it("the same copy called again (another project, a reload) reports too", async () => {
    const factory = await load()
    const a = await factory({ directory: "/one" })
    const b = await factory({ directory: "/two" })
    b.event!(ev("session.created", { info: { id: "ses_b", directory: "/two" } }))
    a.event!(ev("session.created", { info: { id: "ses_a", directory: "/one" } }))
    const out = await drops(6)
    expect(out.map((d) => d.sessionID ?? d.e)).toEqual([
      "started",
      "started",
      "ses_b",
      "ses_b",
      "ses_a",
      "ses_a",
    ])
    expect(new Set(files()).size).toBe(6) // one counter per process: names never collide
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
      fs.rmSync(cfg, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  })
})

describe("the resume id rule", () => {
  it("the plugin checks the same ids main types (one rule, two places)", () => {
    expect(OPENCODE_PLUGIN).toContain(`/${SESSION_ID.source}/`)
  })
})

describe("normalizeOpencodeDrop", () => {
  // The real plugin's drops from a turn with a `task` sub-agent (OpenCode 1.18.34).
  const drops = fs
    .readFileSync(
      path.join(__dirname, "../../src/test/fixtures/agents/opencode-plugin-run.jsonl"),
      "utf8",
    )
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown)
  const events = drops
    .map((d) => normalizeOpencodeDrop(d, "pane-oc"))
    .filter((e): e is AgentEvent => !!e)
    .map((e) => ({ ...e, agent: "opencode" as const }))

  it("maps a real turn onto the canonical events", () => {
    const flow = events.filter((e) => e.event !== "TokenUsage" && e.event !== "SessionTitle")
    expect(flow.map((e) => e.event + (e.agentId ? "·sub" : ""))).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PreToolUse", // task
      "SubagentStart·sub",
      "SubagentStart·sub", // its busy
      "PreToolUse·sub",
      "PostToolUse·sub",
      "SubagentStop·sub",
      "PostToolUse",
      "PreToolUse", // an edit that never finished (the model retried it)
      "PreToolUse",
      "PostToolUse",
      "Stop",
    ])
    const root = flow[0]!
    expect(root).toMatchObject({
      sessionId: expect.stringMatching(/^ses_/),
      cwd: "/repo",
      source: "startup",
    })
    expect(flow.every((e) => e.sessionId === root.sessionId && e.paneId === "pane-oc")).toBe(true)
    expect(flow[5]).toMatchObject({ agentType: "general" })
    expect(flow[5]).not.toHaveProperty("parentAgentId") // its parent is the root
    // Its titles (main's alone): the placeholder, then OpenCode's automatic one.
    const titles = events.filter((e) => e.event === "SessionTitle").map((e) => e.title)
    expect(titles).toEqual([
      expect.stringMatching(/^New session - /),
      "Count words in a.txt and append bye",
    ])
  })

  it("folds into a two-level tree: the root, its sub-agent, files and replies", () => {
    const g = reduceAgentEvents(events)
    expect(g.rootIds).toHaveLength(1)
    const root = g.nodes[g.rootIds[0]!]!
    expect(root).toMatchObject({
      agent: "opencode",
      status: "idle",
      cwd: "/repo",
      paneId: "pane-oc",
    })
    expect(root.lastMessage).toBe("Done.")
    expect(root.currentTool).toBeUndefined() // the turn's end clears the unfinished edit
    expect(root.recentFiles).toEqual(["/repo/a.txt"])
    expect(root.tokens).toEqual({ context: 10797, output: 418 }) // the badge
    const kids = subAgents(g, root)
    expect(kids.map((k) => [k.node.agentType, k.node.status, k.depth])).toEqual([
      ["general", "done", 1],
    ])
    expect(kids[0]!.node.lastMessage).toMatch(/1/)
    expect(kids[0]!.node.tokens).toEqual({ context: 10100, output: 118 }) // its own badge
  })

  it("deeper children nest under their parent (custom agents)", () => {
    const at = (o: Record<string, unknown>) => normalizeOpencodeDrop({ v: 1, ...o }, "p")!
    const child = (id: string, parentID: string) => ({ sessionID: id, parentID, rootID: "ses_r" })
    const g = reduceAgentEvents([
      at({ e: "start", sessionID: "ses_r", source: "new", directory: "/repo" }),
      at({ e: "start", ...child("ses_1", "ses_r"), title: "plan (@planner subagent)" }),
      at({ e: "start", ...child("ses_2", "ses_1"), title: "dig (@explore subagent)" }),
      at({ e: "tool", phase: "start", ...child("ses_2", "ses_1"), tool: "grep", callID: "c" }),
    ])
    const root = g.nodes["root:ses_r"]!
    expect(subAgents(g, root).map((k) => [k.node.agentType, k.depth, k.node.currentTool])).toEqual([
      ["planner", 1, undefined],
      ["explore", 2, "grep"],
    ])
  })

  it("an approval waits until it's answered (OpenCode says so)", () => {
    const at = (o: Record<string, unknown>) =>
      normalizeOpencodeDrop({ v: 1, sessionID: "ses_r", directory: "/repo", ...o }, "p")!
    const evs = [
      at({ e: "start", source: "new" }),
      at({ e: "status", status: "busy" }),
      at({ e: "tool", phase: "start", tool: "bash", callID: "c1" }),
      at({ e: "permission", phase: "asked", tool: "bash", requestID: "per_1", callID: "c1" }),
    ]
    const root = (g: ReturnType<typeof reduceAgentEvents>) => g.nodes["root:ses_r"]!
    expect(root(reduceAgentEvents(evs)).status).toBe("waiting")
    // The plugin gives a reply its ask's call.
    const reply = { e: "permission", phase: "replied", requestID: "per_1", callID: "c1" }
    const answered = [...evs, at(reply)]
    expect(root(reduceAgentEvents(answered)).status).toBe("working")
    // Another ask's reply doesn't end this one.
    const other = [...evs, at({ ...reply, requestID: "per_9", callID: "c9" })]
    expect(root(reduceAgentEvents(other)).status).toBe("waiting")
  })

  it("a root picked again starts as a resume; a start without a folder isn't one", () => {
    expect(
      normalizeOpencodeDrop({
        v: 1,
        e: "start",
        sessionID: "ses_a",
        source: "seen",
        directory: "/r",
      }),
    ).toMatchObject({ event: "SessionStart", source: "resume", cwd: "/r" })
    expect(normalizeOpencodeDrop({ v: 1, e: "start", sessionID: "ses_a" })).toBeNull()
  })

  it("tokens become a TokenUsage for the session or its sub-agent; titles a SessionTitle", () => {
    const n = (o: Record<string, unknown>) => normalizeOpencodeDrop({ v: 1, ...o })
    expect(
      n({ e: "tokens", sessionID: "ses_r", context: 11790, output: 40, directory: "/r" }),
    ).toMatchObject({
      event: "TokenUsage",
      sessionId: "ses_r",
      tokens: { context: 11790, output: 40 },
    })
    const child = { sessionID: "ses_c", parentID: "ses_r", rootID: "ses_r" }
    expect(n({ e: "tokens", ...child, context: 500, output: 0 })).toMatchObject({
      event: "TokenUsage",
      sessionId: "ses_r",
      agentId: "ses_c",
    })
    expect(n({ e: "tokens", sessionID: "ses_r", context: -1, output: 2 })).toBeNull()
    expect(n({ e: "tokens", sessionID: "ses_r", context: "9", output: 2 })).toBeNull()
    expect(n({ e: "session", sessionID: "ses_r", title: "Fix it", directory: "/r" })).toMatchObject(
      {
        event: "SessionTitle",
        title: "Fix it",
      },
    )
    expect(n({ e: "session", ...child, title: "x (@general subagent)" })).toBeNull()
    // Folded: the badge on the root and on the sub-agent.
    const g = reduceAgentEvents([
      n({ e: "start", sessionID: "ses_r", source: "new", directory: "/r" })!,
      n({ e: "start", ...child, title: "x (@general subagent)" })!,
      n({ e: "tokens", sessionID: "ses_r", context: 11790, output: 40, directory: "/r" })!,
      n({ e: "tokens", ...child, context: 500, output: 9 })!,
    ])
    expect(g.nodes["root:ses_r"]!.tokens).toEqual({ context: 11790, output: 40 })
    // Counts that come with a start (one drop): the badge is there from its first event.
    const picked = n({
      e: "start",
      sessionID: "ses_p",
      source: "seen",
      directory: "/r",
      context: 9,
      output: 1,
    })
    expect(reduceAgentEvents([picked!]).nodes["root:ses_p"]!.tokens).toEqual({
      context: 9,
      output: 1,
    })
    expect(g.nodes.ses_c!.tokens).toEqual({ context: 500, output: 9 })
  })

  it("a root the user left ends on the board; a child's end isn't one", () => {
    const end = normalizeOpencodeDrop({ v: 1, e: "end", sessionID: "ses_a", directory: "/r" })
    expect(end).toMatchObject({ event: "SessionEnd", sessionId: "ses_a", reason: "switch" })
    const g = reduceAgentEvents([
      normalizeOpencodeDrop({
        v: 1,
        e: "start",
        sessionID: "ses_a",
        source: "new",
        directory: "/r",
      })!,
      end!,
    ])
    expect(g.rootIds).toEqual([])
    const child = { v: 1, e: "end", sessionID: "ses_c", parentID: "ses_a", rootID: "ses_a" }
    expect(normalizeOpencodeDrop(child)).toBeNull()
  })

  it("rejects other versions, bad ids and junk; never throws", () => {
    for (const bad of [
      null,
      7,
      "x",
      [],
      {},
      { v: 2, e: "start", sessionID: "ses_a", directory: "/r" },
      { v: 1, e: "status", sessionID: "../x", status: "busy" },
      { v: 1, e: "status", sessionID: "ses_a", status: "weird" },
      { v: 1, e: "tool", sessionID: "ses_a", phase: "middle" },
      { v: 1, e: "permission", sessionID: "ses_a", phase: "maybe" },
      { v: 1, e: "started", directory: "/r" },
      { v: 1, e: "session", sessionID: "ses_a", title: "t" },
      { v: 1, e: "future", sessionID: "ses_a" },
      { v: 1, e: "tool", sessionID: "ses_a", phase: "start", paths: "notalist", tool: 5 },
    ]) {
      expect(() => normalizeOpencodeDrop(bad)).not.toThrow()
    }
    expect(
      normalizeOpencodeDrop({ v: 2, e: "start", sessionID: "ses_a", directory: "/r" }),
    ).toBeNull()
    expect(
      normalizeOpencodeDrop({
        v: 1,
        e: "tool",
        sessionID: "ses_a",
        phase: "start",
        paths: "x",
        tool: 5,
      }),
    ).toMatchObject({ event: "PreToolUse", toolName: undefined, filePath: undefined })
  })
})

describe("the rc wrapper passes a resume's id to that one run", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-oc-rs-"))
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))
  fs.writeFileSync(
    path.join(dir, "opencode"),
    '#!/bin/sh\nprintf "run=[%s] " "$MINMUX_RESUME_SESSION"\n',
  )
  fs.chmodSync(path.join(dir, "opencode"), 0o755)
  const run = (shell: string, args: string[], rcLines: string[]) => {
    const rc = path.join(dir, `rc.${path.basename(shell)}`)
    fs.writeFileSync(rc, `${rcLines.join("\n")}\n`)
    const script = `source '${rc}'; MINMUX_RESUME_SESSION=ses_x opencode; opencode; printf "shell=[%s]" "\${MINMUX_RESUME_SESSION-}"`
    return execFileSync(shell, [...args, script], {
      env: {
        PATH: `${dir}:/usr/bin:/bin`,
        HOME: dir,
        ZDOTDIR: dir,
        MINMUX_OPENCODE_PLUGIN: "file:///p.js",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  }
  const want = "run=[ses_x] run=[] shell=[]" // that run only; the next is plain; nothing stays
  it.skipIf(!has("zsh"))("zsh", () =>
    expect(run("zsh", ["-i", "-c"], opencodeShell.zsh)).toBe(want),
  )
  it.skipIf(!has("bash"))(
    "bash, also in POSIX mode (a K=V before a function stays set there)",
    () => {
      expect(run("bash", ["--norc", "-i", "-c"], opencodeShell.bash)).toBe(want)
      expect(run("bash", ["--norc", "--posix", "-i", "-c"], opencodeShell.bash)).toBe(want)
    },
  )
})
