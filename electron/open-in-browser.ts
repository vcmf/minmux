// "Open in browser" for a web page: on macOS and Windows the default app for .html is often an
// editor, so the file goes to the default *web browser* (the https handler) instead. Linux has
// no reliable way to launch "the browser" on a file (xdg-settings, gtk-launch, gio, KDE's form
// all differ), and its .html default is usually the browser: there the default app opens it.
// Pure: main looks the handler up and runs the plan; no plan falls back to the default app.

import type { Os } from "./open-policy"

/** How to launch the browser on a file: `wait` = a launcher, whose exit code says if it worked. */
export interface BrowserLaunch {
  cmd: string
  args: string[]
  wait: boolean
}

// https handlers on Windows that aren't a browser taking a file: they'd run or misread it.
const NOT_BROWSER = new Set(
  (
    "rundll32 openwith launchwinapp explorer hh mshta msiexec regsvr32 cmd powershell pwsh " +
    "wscript cscript conhost wsl bash node python pythonw"
  ).split(" "),
)

const baseName = (p: string) => (p.split(/[\\/]/).pop() ?? "").toLowerCase()

// `handler` is the default browser from Electron's getApplicationInfoForProtocol: an .app path
// on macOS, an .exe path on Windows.
/** The command that opens `file` in the default browser, or null (none usable, or Linux). */
export function browserLaunch(os: Os, file: string, handler: string): BrowserLaunch | null {
  const h = handler.trim()
  if (os === "darwin" && /\.app\/?$/i.test(h))
    return { cmd: "open", args: ["-a", h, file], wait: true }
  if (os === "win32") {
    const exe = baseName(h)
    // The browser itself: starting it is the success (it may run until closed, and one handing
    // the file to a running copy exits with a code of its own, not 0).
    if (exe.endsWith(".exe") && !NOT_BROWSER.has(exe.slice(0, -4)))
      return { cmd: h, args: [file], wait: false }
  }
  return null
}
