// Dev-only cosmetic: rename the Electron.app bundle used by `electron-vite dev` so the
// macOS dock/menu read "minmux" instead of "Electron". In dev the app runs from
// node_modules/electron/dist/Electron.app, whose Info.plist CFBundleName is fixed at launch
// (app.setName can't override it) — packaged builds already read productName. Idempotent and
// self-healing: runs before every `npm run dev` (predev), so a reinstall that resets the
// bundle is re-patched on the next start. macOS-only; a no-op everywhere else.
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"

if (process.platform !== "darwin") process.exit(0)

const NAME = "minmux"
const require = createRequire(import.meta.url)

let plist
try {
  // electron's main export is the path to its binary: .../dist/Electron.app/Contents/MacOS/Electron
  const bin = require("electron")
  plist = bin.replace(/\/Contents\/MacOS\/.*$/, "/Contents/Info.plist")
} catch {
  process.exit(0)
}
if (!plist || !existsSync(plist)) process.exit(0)

const get = (key) => {
  try {
    return execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], {
      encoding: "utf8",
    }).trim()
  } catch {
    return ""
  }
}
const set = (key, val) => {
  const has = get(key) !== ""
  const cmd = has ? `Set :${key} ${val}` : `Add :${key} string ${val}`
  try {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", cmd, plist])
  } catch {
    /* best-effort dev nicety; never fail the dev run */
  }
}

if (get("CFBundleName") !== NAME) set("CFBundleName", NAME)
if (get("CFBundleDisplayName") !== NAME) set("CFBundleDisplayName", NAME)
