// @vitest-environment node
// scripts/minmux's handshake, against a fake app: which launches it treats as the app (left
// running, detached), which as a second instance (output, exit code and the app's answer
// relayed), and which as stuck (killed: an error, never a silent 0).
import { afterEach, describe, expect, it } from "vitest"
import { execFileSync, spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const SHIM = path.resolve(__dirname, "../scripts/minmux")

// The fake app: FAKE_MODE picks how it behaves; it records its pid for the cleanup.
const FAKE = `#!/bin/sh
echo $$ > "$FAKE_PIDFILE"
case $FAKE_MODE in
  app) : > "$MINMUX_CLI_READY"; sleep 30 ;;
  stuck) sleep 30 ;;
  handed) printf ok > "$MINMUX_CLI_ACK"; echo "args:$*"; exit 0 ;;
  unanswered) printf pending > "$MINMUX_CLI_ACK"; exit 0 ;;
  refused) printf "minmux is quitting" > "$MINMUX_CLI_ACK"; exit 0 ;;
  help) echo usage; exit 0 ;;
  error) echo "minmux: bad" >&2; exit 2 ;;
esac
`

let dir = ""
// 0 when it never started — never signal that (pid 0 = this whole process group).
const fakePid = () => {
  const f = path.join(dir, "pid")
  return fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) || 0 : 0
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function shim(mode: string, args: string[] = [], env: Record<string, string> = {}) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-shim-"))
  const app = path.join(dir, "fake-app")
  fs.writeFileSync(app, FAKE, { mode: 0o755 })
  const t = Date.now()
  const r = spawnSync(SHIM, args, {
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      MINMUX_APP: app,
      FAKE_MODE: mode,
      FAKE_PIDFILE: path.join(dir, "pid"),
      TMPDIR: dir,
      ...env,
    },
  })
  return { code: r.status, out: r.stdout, err: r.stderr, ms: Date.now() - t }
}

describe.skipIf(process.platform === "win32")("scripts/minmux", () => {
  afterEach(() => {
    try {
      if (fakePid() > 0) process.kill(fakePid(), "SIGKILL")
    } catch {
      // exited on its own
    }
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it("ready file seen → the app: returns 0 at once, leaves it running in its own group", () => {
    const r = shim("app", ["open"])
    expect(r.code).toBe(0)
    expect(r.ms).toBeLessThan(2000)
    const pid = fakePid()
    expect(alive(pid)).toBe(true)
    // Its own process group: the caller's group ending (or killed) doesn't take it along.
    const pgid = Number(
      execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], { encoding: "utf8" }),
    )
    expect(pgid).toBe(pid)
  })

  it("exit 0, the app answered ok → handed over: output relayed, arguments verbatim", () => {
    const r = shim("handed", ["open", "--tab", "wave 1", "--", "sh", "-c", "echo a; b"])
    expect(r.code).toBe(0)
    expect(r.out).toBe("args:open --tab wave 1 -- sh -c echo a; b\n")
    expect(r.ms).toBeLessThan(2000)
  })

  it("quick non-zero exit → an error: its stderr and exit code relayed", () => {
    const r = shim("error", ["open", "--split", "up"])
    expect(r.code).toBe(2)
    expect(r.err).toBe("minmux: bad\n")
  })

  it("exit 0 but the app never answered, or said no → an error, not a silent 0", () => {
    const never = shim("unanswered", ["open"])
    expect(never.code).toBe(1)
    expect(never.err).toBe(
      "minmux: the running minmux didn't take the request: it never answered\n",
    )
    const no = shim("refused", ["open"])
    expect(no.code).toBe(1)
    expect(no.err).toContain("didn't take the request: minmux is quitting")
  })

  it("exit 0 with nothing to answer (--help, a plain launch) → 0, output relayed", () => {
    const r = shim("help", ["--help"])
    expect(r.code).toBe(0)
    expect(r.out).toBe("usage\n")
  })

  it("neither ready nor exited in time (the app doesn't answer) → killed, an error", () => {
    const r = shim("stuck", ["open"], { MINMUX_CLI_TIMEOUT: "1" })
    expect(r.code).toBe(1)
    expect(r.err).toContain("didn't answer; nothing was opened")
    expect(alive(fakePid())).toBe(false) // before Chromium would kill the app in its place
  })

  it("no app → 127, saying where it looked", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "minmux-shim-"))
    const r = spawnSync(SHIM, ["open"], {
      encoding: "utf8",
      env: { ...process.env, MINMUX_APP: path.join(dir, "nope.app") },
    })
    expect(r.status).toBe(127)
    expect(r.stderr).toContain("nope.app/Contents/MacOS/minmux")
  })
})
