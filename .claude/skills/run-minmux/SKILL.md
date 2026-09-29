---
name: run-minmux
description: Launch and drive the real minmux Electron app (Playwright) to verify a change end-to-end — terminals, panes/surfaces, drag & drop, themes, sidebar, Claude hook/transcript features. Use when asked to run/screenshot the app or confirm a change works beyond Vitest.
---

# Drive the real minmux app

Vitest can't load `node-pty` or WebGL, so anything touching `terminal-manager.ts`, real PTYs,
rendering, focus, or Claude integrations needs a check in the **built** app. `driver.mjs` wraps
Playwright's Electron support with the traps below already handled.

```bash
# playwright-core is a devDependency — `npm install` if it's missing (NOT in a worktree whose
# node_modules is a symlink: see Traps)
npx electron-vite build          # the driver runs out/ — rebuild after every change
node .claude/skills/run-minmux/driver.mjs smoke   # → "smoke: PASS — screenshot …"
```

Write a small script for your scenario (keep it in your scratch dir, not the repo):

```js
import { launch } from "<repo>/.claude/skills/run-minmux/driver.mjs"
const s = await launch({ settings: { renderer: "dom" } }) // dom → terminal text is readable
try {
  await s.sleep(1200) // shell startup
  await s.type("echo hi\n") // → the focused terminal; s.type(text, 1) targets pane #2
  await s.page.locator('[title="Split right"]').first().click()
  console.log(await s.terminalText())
  console.log(await s.shot("after-split")) // then LOOK at the PNG
  const [first] = await s.panes() // tab 1's panes: { session, surfaces }
  s.dropHook(first.session, {
    hook_event_name: "Stop",
    session_id: "c1",
    last_assistant_message: "…",
  })
} finally {
  await s.quit()
}
```

## Traps (why the driver looks the way it does)

- **Never touch the user's real config.** `launch()` points `HOME` (and `APPDATA` on Windows —
  where the config dir lives there) at a throwaway dir, so settings.json, workspace.json,
  claude-hooks.json and window-bg are all scratch; plus a throwaway `--user-data-dir`
  (localStorage + the single-instance lock, so it runs beside a real minmux). A real-HOME run
  overwrites the user's saved layout and hook settings. It also strips `ELECTRON_RENDERER_URL`,
  which a dev minmux leaks into its shells and would load dev-server code instead of `out/`.
- **Don't `app.close()`** — the quit guard opens a native "PTYs are running" dialog and the call
  hangs. `s.quit()` kills the process.
- **WebGL text isn't in the DOM.** Assert text with `settings: { renderer: "dom" }`; judge
  visuals (themes, borders, WebGL garble) from screenshots.
- **`[title="Close"]` also matches the window's close button** (it comes first in the DOM) —
  scope selectors, e.g. `.settings-panel [title="Close"]`.
- **`gh` loses its login under a fake HOME** (macOS Keychain lookup goes through `$HOME`) —
  pass `launch({ gh: true })` for PR/sidebar checks (token stays in the process env).
- **Simulate Claude Code** with `s.dropHook(paneId, payload)` — the same file drop the injected
  hook command performs. Payload = Claude's raw hook JSON (`hook_event_name`, `session_id`,
  `transcript_path`, `last_assistant_message`, …). For `/color` / `/rename`, point
  `transcript_path` at a scratch JSONL and append `{"type":"agent-color","agentColor":"orange"}`
  / `{"type":"custom-title","customTitle":"…"}` lines (slash commands fire no hook — the
  transcript watch picks them up).
- **Real mouse vs dispatched events:** `locator.click()` / `page.mouse` exercise real focus
  behaviour (the close-dialog Enter bug only showed with a real click); `dispatchEvent` doesn't.
  HTML5 drag & drop works with `page.mouse.down/move/up`.
- **Worktrees:** a symlinked `node_modules` is fine for building/running, but never run
  `npm install` inside such a worktree — npm replaces the symlink with a fresh, incomplete tree.
