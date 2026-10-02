import { describe, it, expect } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  addCodexTokenLine,
  addThreadNameLine,
  codexApproved,
  codexHookArgs,
  codexTrustHashes,
  codexIndexFor,
  codexSessionRules,
  codexShell,
  CodexTokens,
  normalizeCodexEvent,
  type ThreadName,
} from "./codex"
import { AGENT_SHELL } from "."
import { reduceAgentEvents, type AgentEvent } from "../../src/lib/agent-graph"
import type { LedgerEntry } from "../agent-sessions"

// The captured S1 streams (src/test/fixtures/agents): `ours` = our hooks' payloads.
const fixture = (name: string) =>
  fs
    .readFileSync(path.join(__dirname, "../../src/test/fixtures/agents", name), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { source: string; pane: string; payload: unknown })
    .filter((l) => l.source === "ours")
const events = (name: string) =>
  fixture(name)
    .map((l) => normalizeCodexEvent(l.payload, l.pane))
    .filter((e): e is AgentEvent => !!e)
    .map((e) => ({ ...e, agent: "codex" as const })) // as the watcher stamps it from the folder

/** The value of a `hooks.<Event>=[…]` arg's `command="…"` (TOML basic string, decoded). */
const commandOf = (arg: string) => {
  const m = /command="((?:[^"\\]|\\.)*)"/.exec(arg)
  return m ? m[1]!.replace(/\\(.)/g, "$1") : null
}

const has = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`]).status === 0

describe("codexHookArgs", () => {
  const args = codexHookArgs("/cfg/agents/drop.js")
  it("adds one -c override per event, byte-stable for the same script path", () => {
    expect(args.length % 2).toBe(0)
    expect(args.filter((_, i) => i % 2 === 0).every((a) => a === "-c")).toBe(true)
    const keys = args.filter((_, i) => i % 2 === 1).map((a) => a.split("=")[0])
    expect(keys).toContain("hooks.SessionStart")
    expect(keys).toContain("hooks.PermissionRequest")
    expect(codexHookArgs("/cfg/agents/drop.js")).toEqual(args) // approval is keyed by these bytes
  })
  it("never passes anything but hooks overrides (they add to the user's hooks, S1-a)", () => {
    for (const a of args.filter((_, i) => i % 2 === 1)) expect(a).toMatch(/^hooks\.[A-Za-z]+=\[/)
  })
  it("keeps SessionEnd/Interrupt within Codex's 3 s and SessionEnd synchronous (no /hooks Issues)", () => {
    const of = (e: string) => args.find((a) => a.startsWith(`hooks.${e}=`))!
    expect(of("SessionEnd")).toContain("timeout=3")
    expect(of("SessionEnd")).not.toContain("async")
    expect(of("Interrupt")).toContain("timeout=3")
    expect(of("Stop")).toContain("async=true")
    expect(of("PreToolUse")).toContain('matcher=""')
  })
  it("quotes the script path for TOML and the shell: it survives `sh -c` intact", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-codex-"))
    try {
      // A fake `node` that prints its arguments, one per line.
      fs.writeFileSync(
        path.join(dir, "node"),
        '#!/bin/sh\nfor a in "$@"; do printf "%s\\n" "$a"; done\n',
      )
      fs.chmodSync(path.join(dir, "node"), 0o755)
      const weird = `/tmp/it's a "dir" with $HOME and \\back/drop.js`
      const cmd = commandOf(codexHookArgs(weird)[1]!)!
      const out = execFileSync("sh", ["-c", cmd], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        encoding: "utf8",
      })
      expect(out).toBe(`${weird}\ncodex\n`)
      expect(cmd.startsWith("exec node ")).toBe(true) // node's parent is then Codex itself
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("codex() wrapper", () => {
  // Run the generated rc lines in a real shell with a fake `codex` that prints its argv.
  const run = (shell: "zsh" | "bash") => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-codexw-"))
    try {
      fs.writeFileSync(
        path.join(dir, "codex"),
        '#!/bin/sh\nfor a in "$@"; do printf "[%s]\\n" "$a"; done\n',
      )
      fs.chmodSync(path.join(dir, "codex"), 0o755)
      const argsFile = path.join(dir, "codex args") // a space in the path, too
      const args = codexHookArgs(`/tmp/x y/drop.js`)
      fs.writeFileSync(argsFile, `${args.join("\n")}\n`)
      const rc = path.join(dir, "rc")
      fs.writeFileSync(rc, `${(shell === "zsh" ? codexShell.zsh : codexShell.bash).join("\n")}\n`)
      const out = execFileSync(shell, ["-i", "-c", `source '${rc}'; codex resume 'a b'`], {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          MINMUX_CODEX_ARGS: argsFile,
          HOME: dir,
          ZDOTDIR: dir,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
      return { out, args }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  for (const shell of ["zsh", "bash"] as const)
    it.skipIf(!has(shell))(`passes every hook argument intact, then the user's (${shell})`, () => {
      const { out, args } = run(shell)
      expect(out).toBe([...args, "resume", "a b"].map((a) => `[${a}]`).join("\n") + "\n")
    })
})

describe("agent wrappers vs the user's aliases", () => {
  for (const shell of ["zsh", "bash"] as const)
    it.skipIf(!has(shell))(`survive \`alias claude=…\` and \`alias codex=…\` (${shell})`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-alias-"))
      try {
        const rc = path.join(dir, "rc")
        const lines = AGENT_SHELL.flatMap((a) => (shell === "zsh" ? a.zsh : a.bash))
        fs.writeFileSync(rc, `${lines.join("\n")}\necho rc-done\n`)
        const script = `alias claude='echo c'; alias codex='echo x'; source '${rc}'; type codex | head -1`
        const r = spawnSync(shell, ["-i", "-c", script], {
          env: {
            ...process.env,
            HOME: dir,
            ZDOTDIR: dir,
            MINMUX_CODEX_ARGS: rc,
            MINMUX_CLAUDE_SETTINGS: rc,
          },
          encoding: "utf8",
        })
        expect(r.stderr).not.toMatch(/parse error|syntax error/)
        expect(r.stdout).toContain("rc-done") // the rest of the rc still ran
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
})

describe("normalizeCodexEvent (captured S1 streams)", () => {
  it("maps the exec run: tools, an apply_patch file, a sub-agent", () => {
    const ev = events("codex-exec.jsonl")
    expect(ev.every((e) => e.agent === "codex" && e.paneId === "pane-123")).toBe(true)
    expect(ev.map((e) => e.event)).toContain("SubagentStart")
    const patch = ev.find((e) => e.toolName === "apply_patch")
    expect(patch?.filePath).toBe("/repo/a.txt")
    const sub = ev.filter((e) => e.agentId)
    expect(sub.length).toBeGreaterThan(2) // the sub-agent's own tool calls carry its id
  })
  it("gives an approval the same call key as the call it asks about", () => {
    const ev = events("codex-tui.jsonl")
    const perm = ev.find((e) => e.event === "PermissionRequest")!
    const after = ev.slice(ev.indexOf(perm) + 1).find((e) => e.event === "PreToolUse")!
    expect(perm.toolKey).toBeDefined()
    expect(after.toolKey).toBe(perm.toolKey) // same command; the approval's description ignored
  })

  it("turns Interrupt into a turn end and keeps PermissionRequest", () => {
    const ev = events("codex-tui.jsonl")
    expect(ev.map((e) => e.event)).not.toContain("Interrupt")
    const perm = ev.find((e) => e.event === "PermissionRequest")
    expect(perm?.toolName).toBe("Bash")
  })
  it("drops junk without throwing", () => {
    expect(normalizeCodexEvent(null)).toBeNull()
    expect(normalizeCodexEvent({ hook_event_name: "Stop" })).toBeNull()
    expect(
      normalizeCodexEvent({
        hook_event_name: "PreToolUse",
        session_id: "s",
        tool_name: "apply_patch",
        tool_input: { command: 5 },
      })?.filePath,
    ).toBeUndefined()
  })
})

describe("the agent graph over Codex's streams", () => {
  it("builds root → sub-agent with the sub-agent's tools on it", () => {
    const g = reduceAgentEvents(events("codex-exec.jsonl").filter((e) => e.event !== "SessionEnd"))
    const root = Object.values(g.nodes).find((n) => n.agentType === "root")!
    expect(root.agent).toBe("codex")
    expect(root.childIds).toHaveLength(1)
    const sub = g.nodes[root.childIds[0]!]!
    expect(sub.status).toBe("done")
    expect(sub.agent).toBe("codex")
  })
  it("waits on the approval, idles after the interrupt, ignores the stray SessionEnd", () => {
    const ev = events("codex-tui.jsonl")
    const upTo = (i: number) => reduceAgentEvents(ev.slice(0, i + 1))
    const live = ev.filter((e) => e.event !== "SessionEnd")
    const permAt = ev.findIndex((e) => e.event === "PermissionRequest")
    const sid = ev[permAt]!.sessionId
    expect(upTo(permAt).nodes[`root:${sid}`]!.status).toBe("waiting")
    expect(reduceAgentEvents(live).nodes[`root:${sid}`]!.status).toBe("idle")
    // the first drop is a SessionEnd for a session that never started (S1)
    expect(reduceAgentEvents(ev.slice(0, 1)).rootIds).toEqual([])
  })
})

describe("codexSessionRules", () => {
  const lead = (pid?: number): LedgerEntry => ({
    agent: "codex",
    sessionId: "x",
    cwd: "/r",
    updatedAt: 1,
    pid,
  })
  const start = (pid?: number): AgentEvent => ({
    agent: "codex",
    event: "SessionStart",
    sessionId: "y",
    pid,
  })
  it("a new thread in the leading process is a switch; another process's is a background agent", () => {
    expect(codexSessionRules.isSwitch(start(42), lead(42))).toBe(true)
    expect(codexSessionRules.isSwitch(start(43), lead(42))).toBe(false)
    expect(codexSessionRules.isSwitch(start(), lead())).toBe(false) // unknown process: not a switch
  })
  it("resumes a UUID session id only", () => {
    const e = { ...lead(), sessionId: "01a0f3f0-41df-7e00-8190-0eefd9149881" }
    expect(codexSessionRules.resumeCommand(e, false)).toBe(`codex resume ${e.sessionId}`)
    expect(codexSessionRules.resumeCommand({ ...e, sessionId: "x; rm -rf ~" }, false)).toBeNull()
  })
})

describe("Codex tokens (rollout token_count)", () => {
  const tc = (info: unknown) =>
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", info } })
  const info = (input: number, out: number, window = 258400) => ({
    last_token_usage: { input_tokens: input, cached_input_tokens: input - 100, output_tokens: 7 },
    total_token_usage: { input_tokens: input * 2, output_tokens: out },
    model_context_window: window,
  })
  const zero = { context: 0, output: 0 }
  it("takes the latest request's context, the session's output so far and the window", () => {
    let u = addCodexTokenLine(zero, tc(info(13215, 358)))
    u = addCodexTokenLine(u, tc(info(16245, 900)))
    expect(u).toEqual({ context: 16245, output: 900, window: 258400 })
  })
  it("skips everything else, including the record before any usage", () => {
    const u = addCodexTokenLine(zero, tc(info(500, 10)))
    for (const l of [
      tc(null),
      "{}",
      "not json",
      '{"type":"event_msg","payload":{"type":"agent_message"}}',
      "",
    ])
      expect(addCodexTokenLine(u, l)).toBe(u)
  })
  it("reads a rollout incrementally", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-ctok-"))
    const f = path.join(dir, "rollout.jsonl")
    try {
      fs.writeFileSync(f, `{"type":"session_meta","payload":{}}\n${tc(info(1000, 50))}\n`)
      const r = new CodexTokens()
      expect(await r.update(f)).toEqual({ context: 1000, output: 50, window: 258400 })
      fs.appendFileSync(f, `${tc(info(2000, 80))}\n`)
      expect(await r.update(f)).toEqual({ context: 2000, output: 80, window: 258400 })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Codex thread names", () => {
  it("finds the index next to the sessions folder the rollout lives in", () => {
    expect(codexIndexFor("/home/u/.codex/sessions/2026/10/02/rollout-x.jsonl")).toBe(
      "/home/u/.codex/session_index.jsonl",
    )
    expect(codexIndexFor("/srv/ch/sessions/2026/10/02/rollout-y.jsonl")).toBe(
      "/srv/ch/session_index.jsonl",
    )
    expect(codexIndexFor("/tmp/other.jsonl")).toBeNull()
    expect(codexIndexFor(undefined)).toBeNull()
  })
  it("treats a thread's first name as Codex's and the same name again as no rename", () => {
    let m: Map<string, ThreadName> | null = null
    for (const l of ['{"id":"a","thread_name":"Fix"}', '{"id":"a","thread_name":"Fix"}'])
      m = addThreadNameLine(m, l)
    expect(m!.get("a")).toEqual({ name: "Fix", user: false })
  })
  it("keeps the latest name per thread and ignores junk", () => {
    let m: Map<string, ThreadName> | null = null
    for (const l of [
      '{"id":"a","thread_name":"Run curl"}',
      '{"id":"b","thread_name":"Other"}',
      '{"id":"a","thread_name":" Run curl HEAD request "}',
      "junk",
      '{"id":5,"thread_name":"x"}',
    ])
      m = addThreadNameLine(m, l)
    expect(Object.fromEntries(m!)).toEqual({
      a: { name: "Run curl HEAD request", user: true }, // a later, different name: /rename
      b: { name: "Other", user: false }, // Codex's own
    })
    expect(m!.get("constructor")).toBeUndefined() // a Map: no prototype names
  })
  it("folds a long index in linear time (it runs on the main process)", () => {
    const lines = Array.from(
      { length: 20000 },
      (_, i) => `{"id":"t${i % 5000}","thread_name":"n${i}"}`,
    )
    const t0 = performance.now()
    let m: Map<string, ThreadName> | null = null
    for (const l of lines) m = addThreadNameLine(m, l)
    expect(m!.size).toBe(5000)
    expect(performance.now() - t0).toBeLessThan(500) // the O(N²) copy took seconds here
  })
})

describe("Codex hook approval (its own trust records)", () => {
  // A hash Codex itself recorded when our SessionStart hook was trusted in a real run.
  const DROP =
    "/var/folders/2h/p050c52s2976v5kxlgbrmb580000gn/T/minmux-pr7h-VOS4Z3/home/.config/minmux/agents/drop.cjs"
  const RECORDED = "sha256:1c1d7e9a0047b00274e966257a919a9bae09fc4eae5b677ea6748b24bbb506b8"
  it("computes the same trust hash Codex records", () => {
    const h = codexTrustHashes(DROP)
    expect(h.size).toBe(10)
    expect(h.get("/<session-flags>/config.toml:session_start:0:0")).toBe(RECORDED)
  })
  const toml = (entries: [string, string][]) =>
    entries.map(([k, v]) => `[hooks.state."${k}"]\ntrusted_hash = "${v}"\n`).join("\n")
  it("approved only when every one of our hooks is trusted with today's definition", () => {
    const h = codexTrustHashes("/cfg/agents/drop.cjs")
    const all = [...h]
    expect(codexApproved(toml(all), h)).toBe(true)
    expect(codexApproved(toml(all.slice(1)), h)).toBe(false) // one missing
    const changed = all.map(([k, v], i) => [k, i ? v : "sha256:old"] as [string, string])
    expect(codexApproved(toml(changed), h)).toBe(false) // a definition that changed since
    expect(codexApproved('model = "x"\n', h)).toBe(false)
  })
  it("keeps snake_case event labels apart (stop vs subagent_stop)", () => {
    const keys = [...codexTrustHashes("/d").keys()]
    expect(keys).toContain("/<session-flags>/config.toml:stop:0:0")
    expect(keys).toContain("/<session-flags>/config.toml:subagent_stop:0:0")
    expect(keys).toContain("/<session-flags>/config.toml:permission_request:0:0")
  })
})

describe("the launch marker (approval hint)", () => {
  // A real terminal for the wrapper's stdout: macOS `script` gives the shell a pty.
  const tty = process.platform === "darwin" && has("zsh") && has("script")
  const run = (args: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-mark-"))
    try {
      fs.writeFileSync(path.join(dir, "codex"), "#!/bin/sh\nexit 0\n")
      fs.chmodSync(path.join(dir, "codex"), 0o755)
      const argsFile = path.join(dir, "args")
      fs.writeFileSync(argsFile, "-c\nhooks.Stop=[]\n")
      const rc = path.join(dir, "rc")
      fs.writeFileSync(rc, `${codexShell.zsh.join("\n")}\n`)
      return execFileSync(
        "script",
        ["-q", "/dev/null", "zsh", "-i", "-c", `source '${rc}'; codex ${args}`],
        {
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            MINMUX_CODEX_ARGS: argsFile,
            HOME: dir,
            ZDOTDIR: dir,
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"], // `script` wants no pipe on stdin
        },
      )
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
  it.skipIf(!tty)("is printed onto a terminal for Codex's UI, not for its other commands", () => {
    expect(run("")).toContain("\x1b]6974;agent;codex\x07")
    expect(run("resume abc")).toContain("\x1b]6974;agent;codex\x07")
    expect(run("exec 'do it'")).not.toContain("6974")
    expect(run("--version")).not.toContain("6974")
    // Global flags (and their values) come before the subcommand.
    expect(run("-m o3 exec 'do it'")).not.toContain("6974")
    expect(run("-c a=b --cd /tmp review")).not.toContain("6974")
    expect(run("-m o3 'fix the bug'")).toContain("\x1b]6974;agent;codex\x07")
    expect(run("--yolo resume abc")).toContain("\x1b]6974;agent;codex\x07")
  })
})
