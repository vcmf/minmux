// @vitest-environment node
// `minmux open` end to end, process level: scripts/minmux against a BUILT app — one cold launch,
// then warm calls that must hand over to it. Needs a display: `make check-cli` (MINMUX_E2E=1).
// The app: $MINMUX_E2E_APP (a .app or an executable), else release/mac-arm64/minmux.app, else
// the dev Electron on out/ (`make build` first). Each case runs on a throwaway HOME and
// user-data-dir (its own lock): never the user's config, never their running minmux.
import { afterEach, describe, expect, it } from "vitest"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { PaneNode } from "../src/types"

const REPO = path.resolve(__dirname, "..")
const SHIM = path.join(REPO, "scripts/minmux")
const PACKAGED = path.join(REPO, "release/mac-arm64/minmux.app")
const DEV = path.join(REPO, "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron")
const app = process.env.MINMUX_E2E_APP || (fs.existsSync(PACKAGED) ? PACKAGED : DEV)
// How fast a warm call must come back (a loaded machine: raise it with MINMUX_E2E_WARM_MS).
const WARM_MS = Number(process.env.MINMUX_E2E_WARM_MS) || 2000

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(get: () => T | undefined, ms: number): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await wait(200)) {
    const v = get()
    if (v !== undefined) return v
  }
  return get()
}

const leaves = (n: PaneNode): number =>
  n.type === "leaf" ? 1 : leaves(n.children[0]) + leaves(n.children[1])
type Workspace = { tabs: { title: string; root: PaneNode }[] }

/** One throwaway profile: its dirs, env, and what the app wrote there. */
function profile() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-e2e-"))
  const home = path.join(scratch, "home")
  const userData = path.join(scratch, "ud")
  const cfg = path.join(home, ".config", "minmux") // the default profile (MINMUX_PROFILE below)
  const dirs = ["w1", "w2", "w3", "w4"].map((d) => path.join(scratch, d))
  const env: Record<string, string | undefined> = {
    ...process.env,
    MINMUX_APP: app,
    HOME: home,
    ZDOTDIR: home,
    TMPDIR: path.join(scratch, "tmp"),
    MINMUX_PROFILE: "default", // a dev build's own default is `dev`; a packaged one ignores it
  }
  delete env.ELECTRON_RENDERER_URL
  for (const d of [cfg, env.TMPDIR!, ...dirs]) fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify({ confirmQuit: false }))
  return {
    scratch,
    cfg,
    dirs,
    env,
    userData,
    // The dev Electron needs the app path first; the switch keeps it off the user's lock.
    prefix: [...(app === DEV ? [REPO] : []), `--user-data-dir=${userData}`],
    /** The app's main process(es) on this user-data-dir (Chromium helpers carry --type=). */
    pids(): number[] {
      return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" })
        .split("\n")
        .filter((l) => l.includes(`--user-data-dir=${userData}`) && !l.includes("--type="))
        .filter((l) => !l.includes("scripts/minmux") && !l.includes("perl"))
        .map((l) => Number(l.trim().split(/\s+/)[0]))
    },
    workspace(): Workspace | undefined {
      try {
        return JSON.parse(fs.readFileSync(path.join(cfg, "workspace.json"), "utf8")) as Workspace
      } catch {
        return undefined
      }
    },
    diag: (re: RegExp) =>
      fs
        .readFileSync(path.join(cfg, "diagnostics.log"), "utf8")
        .split("\n")
        .filter((l) => re.test(l)),
  }
}
type Profile = ReturnType<typeof profile>

// Shaped like the real use (`start-session.sh '🤖 <slug>' <colour>`): two-byte text in the
// request, which a binary hand-over payload broke (see main.ts CLI_SPOOL).
const pane = (dir: string) => ["--cwd", dir, "--", "sh", "-c", "echo ok; sleep 120", "🤖 slug"]
const WAVE_B = "wave B · deploy + apps"
const shape = (ws: Workspace | undefined) =>
  ws?.tabs.map((t) => `${t.title}:${leaves(t.root)}`).join(" ")

/** A cold `open` (its caller's process group then killed, as a sandboxed or scripted shell's
 *  can be), up and restored: the one app pid it runs in. */
async function coldStart(p: Profile): Promise<number> {
  console.log(`app: ${app}`)
  const cold = spawn(SHIM, [...p.prefix, "open", "--tab", "wave A", ...pane(p.dirs[0]!)], {
    env: p.env,
    cwd: p.scratch,
    detached: true,
    stdio: "ignore",
  })
  expect(await new Promise<number | null>((r) => cold.on("exit", r))).toBe(0)
  try {
    process.kill(-cold.pid!, "SIGKILL")
  } catch {
    // the group is already empty
  }
  const pids = await until(() => (p.pids().length ? p.pids() : undefined), 10_000)
  expect(pids).toHaveLength(1)
  // Up and restored before any warm call (each must find the lock held).
  expect(await until(() => (p.diag(/cli-open-taken/).length ? true : undefined), 30_000)).toBe(true)
  return pids![0]!
}

/** A warm `open` through the shim: its exit code, stderr and time. */
function warmOpen(p: Profile, args: string[]) {
  const t = Date.now()
  const r = spawnSync(SHIM, [...p.prefix, "open", ...args], {
    env: p.env,
    encoding: "utf8",
    timeout: 40_000,
  })
  return { code: r.status, err: r.stderr, ms: Date.now() - t }
}

/** coldStart, then three warm calls 2 s apart: every one handed over to that one app. */
async function coldThenWarm(p: Profile, expected: string): Promise<void> {
  const pid = await coldStart(p)

  const warm: [string, ...string[]][] = [
    ["wave A", ...pane(p.dirs[1]!)],
    [WAVE_B, ...pane(p.dirs[2]!)],
    [WAVE_B, "--split", "down", ...pane(p.dirs[3]!)],
  ]
  for (const [tab, ...rest] of warm) {
    await wait(2000)
    const r = warmOpen(p, ["--tab", tab, ...rest])
    console.log(`open --tab ${JSON.stringify(tab)} ${rest[0]} → exit ${r.code} in ${r.ms}ms`)
    expect(r.code).toBe(0)
    expect(r.ms).toBeLessThan(WARM_MS)
    expect(p.pids()).toEqual([pid]) // handed over: still the one app
  }

  const got = await until(() => (shape(p.workspace()) === expected ? expected : undefined), 10_000)
  console.log(`tabs: ${shape(p.workspace())}`)
  console.log(
    `requests: ${p
      .diag(/cli-open/)
      .map((l) => l.split(" ")[1])
      .join(", ")}`,
  )
  expect(got).toBe(expected)
  const waveB = p.workspace()!.tabs.find((t) => t.title === WAVE_B)!.root
  expect(waveB.type === "split" && waveB.direction).toBe("column")
  const boots = p.diag(/ boot pid=/)
  console.log(`boot lines: ${boots.length} (${boots.join(" | ")})`)
  expect(boots).toHaveLength(1)
  expect(boots[0]).toContain(`pid=${pid}`)
  expect(p.pids()).toEqual([pid])
  // Every request was received and opened: 4 in, 4 opened, none dropped.
  expect(p.diag(/cli-open-received/)).toHaveLength(4)
  expect(p.diag(/cli-open-opened/)).toHaveLength(4)
  expect(p.diag(/cli-open-(dropped|invalid)/)).toEqual([])
}

/** A saved workspace (v2, as minmux writes it): two tabs of two zsh panes each, the second
 *  titled like the first `open --tab`, the other one active (its panes start; wave A's don't). */
function savedWorkspace(home: string) {
  const ids = ["s1", "s2", "s3", "s4"].map((s) => `00000000-0000-4000-8000-00000000000${s[1]}`)
  const leaf = (n: number) => ({
    type: "leaf",
    id: `p${n}`,
    sessionIds: [ids[n]],
    activeSessionId: ids[n],
    sessionId: ids[n], // the legacy mirror older builds read
  })
  const tab = (id: string, title: string, a: number, b: number) => ({
    id,
    title,
    root: { type: "split", id: `${id}-split`, direction: "row", children: [leaf(a), leaf(b)] },
    activeSessionId: ids[b],
  })
  return {
    version: 2,
    activeTabId: "t1",
    tabs: [tab("t1", "review", 0, 1), tab("t2", "wave A", 2, 3)],
    sessions: ids.map((id) => ({ id, title: "zsh", command: "/bin/zsh", args: [], cwd: home })),
    rightPanelWidth: 380,
  }
}

describe.skipIf(process.env.MINMUX_E2E !== "1" || process.platform !== "darwin")(
  "minmux open, end to end",
  () => {
    let p: Profile | undefined
    afterEach(() => {
      if (!p) return
      for (const pid of p.pids()) process.kill(pid, "SIGKILL")
      spawnSync("pkill", ["-9", "-f", "--", `--user-data-dir=${p.userData}`])
      p = undefined
    })

    it("nothing saved: a cold launch, then three warm calls, one app throughout", async () => {
      p = profile()
      await coldThenWarm(p, `wave A:2 ${WAVE_B}:2`)
    }, 120_000)

    it("a saved workspace restored first: the same calls land in it", async () => {
      p = profile()
      const home = path.dirname(path.dirname(p.cfg))
      fs.writeFileSync(path.join(p.cfg, "workspace.json"), JSON.stringify(savedWorkspace(home)))
      await coldThenWarm(p, `review:2 wave A:4 ${WAVE_B}:2`)
    }, 120_000)

    it("an app that doesn't answer: the call fails loudly and the app survives it", async () => {
      const q = (p = profile())
      const pid = await coldStart(q)
      process.kill(pid, "SIGSTOP") // busy / unreachable: the singleton socket goes unanswered
      let r: ReturnType<typeof warmOpen>
      try {
        r = warmOpen(q, ["--tab", "wave A", ...pane(q.dirs[1]!)])
      } finally {
        process.kill(pid, "SIGCONT")
      }
      console.log(`frozen app: exit ${r.code} in ${r.ms}ms: ${r.err.trim()}`)
      expect(r.code).toBe(1)
      expect(r.err).toContain("didn't answer")
      expect(r.ms).toBeLessThan(20_000) // before Chromium kills the app to take its place
      await wait(1000)
      expect(q.pids()).toEqual([pid]) // not replaced
      // Answering again: the next call lands in it.
      const again = warmOpen(q, ["--tab", "wave A", ...pane(q.dirs[2]!)])
      console.log(`after: exit ${again.code} in ${again.ms}ms`)
      expect(again.code).toBe(0)
      const got = await until(
        () => (shape(q.workspace()) === "wave A:2" ? true : undefined),
        10_000,
      )
      console.log(`tabs: ${shape(q.workspace())}`)
      console.log(
        `requests: ${q
          .diag(/cli-open/)
          .map((l) => l.split(" ").slice(1, 2))
          .join(", ")}`,
      )
      expect(got).toBe(true)
      expect(q.diag(/cli-open-opened/)).toHaveLength(2) // the frozen-time one never opens
      expect(q.pids()).toEqual([pid])
      expect(q.diag(/ boot pid=/)).toHaveLength(1)
    }, 120_000)
  },
)
