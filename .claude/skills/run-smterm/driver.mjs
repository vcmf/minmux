// Drive the BUILT smterm app with Playwright's Electron support — for agents verifying a
// change in the real app (not just Vitest). See SKILL.md next to this file.
//
//   import { launch } from "./.claude/skills/run-smterm/driver.mjs"
//   const s = await launch({ settings: { renderer: "dom" } })
//   await s.type("echo hi\n"); console.log(await s.terminalText()); await s.shot("hi")
//   await s.quit()
//
// CLI smoke test:  node .claude/skills/run-smterm/driver.mjs smoke

import { _electron as electron } from "playwright-core"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..")

const electronBin = () => {
  const dist = path.join(REPO, "node_modules/electron/dist")
  if (process.platform === "darwin") return path.join(dist, "Electron.app/Contents/MacOS/Electron")
  if (process.platform === "win32") return path.join(dist, "electron.exe")
  return path.join(dist, "electron")
}

/**
 * Launch the built app ISOLATED from the user's real config: a throwaway HOME (settings.json,
 * workspace.json, claude-hooks.json, window-bg all live under it) and a throwaway Chromium
 * user-data dir (localStorage + the single-instance lock — so it runs next to a real smterm).
 *
 * @param {object} [o]
 * @param {object} [o.settings] written as settings.json before launch (e.g. { renderer: "dom" }
 *   so terminal text is in the DOM; { theme, appearance } for theme checks)
 * @param {boolean} [o.gh] pass the user's gh token as GH_TOKEN — gh keeps its login in the macOS
 *   Keychain, which a fake HOME can't reach (in-memory for this process only)
 * @param {string} [o.scratch] where HOME/user-data live (default: a fresh temp dir)
 * @param {string} [o.profile] SMTERM_PROFILE for the app (default "default": HOME is throwaway
 *   anyway, so the plain ~/.config/smterm paths)
 */
export async function launch(o = {}) {
  if (!fs.existsSync(path.join(REPO, "out/main/main.js"))) {
    throw new Error("No build found — run `npx electron-vite build` first (the driver runs out/).")
  }
  const scratch = o.scratch ?? fs.mkdtempSync(path.join(os.tmpdir(), "smterm-drive-"))
  const home = path.join(scratch, "home")
  // Must match main's configDir(): %APPDATA%\smterm on Windows, ~/.config/smterm elsewhere.
  const appData = path.join(scratch, "appdata")
  const profile = o.profile ?? "default"
  const dirName = profile === "default" || profile === "prod" ? "smterm" : `smterm-${profile}`
  const cfg =
    process.platform === "win32" ? path.join(appData, dirName) : path.join(home, ".config", dirName)
  fs.mkdirSync(cfg, { recursive: true })
  if (o.settings) fs.writeFileSync(path.join(cfg, "settings.json"), JSON.stringify(o.settings))

  const env = { ...process.env, HOME: home, ZDOTDIR: home, APPDATA: appData, USERPROFILE: home }
  // Inherited from a dev smterm's shell (main copies its env into every PTY): the dev-server
  // URL would make this "built" app load live dev code instead of out/.
  delete env.ELECTRON_RENDERER_URL
  delete env.ELECTRON_RUN_AS_NODE
  // HOME and --user-data-dir are already throwaway: the default profile's paths unless the
  // caller asked for another (an unpackaged build would otherwise pick `dev`).
  env.SMTERM_PROFILE = profile
  if (o.gh) {
    try {
      env.GH_TOKEN = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim()
    } catch {
      // gh missing / logged out — PR lookups will just stay hidden
    }
  }
  const app = await electron.launch({
    executablePath: electronBin(),
    args: [REPO, `--user-data-dir=${path.join(scratch, "ud")}`],
    env,
    timeout: 30_000,
  })
  let page
  try {
    page = await app.firstWindow()
    await page.waitForSelector(".terminal-pane", { timeout: 20_000 })
  } catch (e) {
    app.process().kill("SIGKILL") // don't orphan an Electron (+ its PTYs) on a failed launch
    throw e
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

  return {
    app,
    page,
    scratch,
    cfg,
    sleep,
    /** Type keys. With `pane` (index in DOM order) that pane's terminal is focused first —
     *  which also moves the app's focus there, like a click would. Without it, keys go to
     *  whatever terminal has focus now (the focused pane after launch / a split / ⌘T). */
    async type(text, pane) {
      if (pane !== undefined) {
        await page.locator(".terminal-pane").nth(pane).locator(".xterm-helper-textarea").focus()
      }
      await page.keyboard.type(text)
    },
    /** On-screen terminal text (panes only — parked terminals are excluded). Needs settings
     *  { renderer: "dom" }: WebGL draws on a canvas. */
    async terminalText() {
      return (await page.locator(".terminal-pane .xterm-rows").allInnerTexts()).join("\n")
    },
    /** Screenshot → path (use for anything visual; WebGL text isn't in the DOM). */
    async shot(name) {
      const p = path.join(scratch, `${name}.png`)
      await page.screenshot({ path: p })
      return p
    },
    /** Tab 1's panes from the persisted workspace (debounced ~600 ms): per pane its visible
     *  session id (what hook events call the "pane id") and all its surfaces. */
    async panes() {
      const file = path.join(cfg, "workspace.json")
      for (let i = 0; i < 20 && !fs.existsSync(file); i++) await sleep(200)
      if (!fs.existsSync(file)) throw new Error(`no ${file} yet — did the app finish starting?`)
      await sleep(700) // let the debounced save catch up with recent layout changes
      const ws = JSON.parse(fs.readFileSync(file, "utf8"))
      const walk = (n) =>
        n.type === "leaf"
          ? [{ session: n.activeSessionId, surfaces: n.sessionIds }]
          : n.children.flatMap(walk)
      return walk(ws.tabs[0].root)
    },
    /** Simulate a Claude Code hook event from pane `paneId` exactly as the injected hook
     *  command would (a file in the per-launch drop dir). `payload` is Claude's raw hook JSON,
     *  e.g. { hook_event_name: "Stop", session_id: "c1", last_assistant_message: "…" }. */
    dropHook(paneId, payload) {
      const hooks = JSON.parse(fs.readFileSync(path.join(cfg, "claude-hooks.json"), "utf8"))
      const dir = hooks.hooks.SessionStart[0].hooks[0].args[2]
      const name = `${paneId}.1.${Date.now()}.${Math.random().toString(36).slice(2)}.json`
      fs.writeFileSync(path.join(dir, name), JSON.stringify(payload))
    },
    /** Kill the app. NOT app.close(): the quit guard shows a native confirm dialog while PTYs
     *  are alive, so a graceful close hangs. */
    async quit() {
      app.process().kill("SIGKILL")
    },
  }
}

// CLI: a quick end-to-end smoke test.
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "smoke") {
  const s = await launch({ settings: { renderer: "dom" } })
  try {
    await s.sleep(1200) // shell startup
    await s.type("echo smterm-smoke-ok\n")
    await s.sleep(800)
    const ok = (await s.terminalText()).includes("smterm-smoke-ok")
    console.log(`smoke: ${ok ? "PASS" : "FAIL"} — screenshot ${await s.shot("smoke")}`)
    process.exitCode = ok ? 0 : 1
  } finally {
    await s.quit()
  }
}
