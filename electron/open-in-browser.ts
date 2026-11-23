// "Open in browser" for a web page: the OS's default app for .html may be an editor, so the
// file goes to the default *web browser* (the https handler) instead. Pure: main looks the
// handler up and tries each plan in turn; none working falls back to the default app.

import type { Os } from "./open-policy"

/** How to launch the browser on a file; `wait` = a launcher, whose exit code says if it worked. */
export interface BrowserLaunch {
  cmd: string
  args: string[]
  wait: boolean
}

// https handlers on Windows that aren't a browser taking a file: they'd run or misread it.
const NOT_BROWSER = new Set(
  "rundll32 openwith explorer cmd powershell pwsh wscript cscript mshta conhost".split(" "),
)

const baseName = (p: string) => (p.split(/[\\/]/).pop() ?? "").toLowerCase()

// `handler` is the default browser as each OS names it: macOS an .app path, Windows an .exe
// path (Electron's getApplicationInfoForProtocol), Linux what xdg-settings says (a desktop-file
// id, or KDE's "!command"). `desktopFile` = where that id's desktop file is ("" if not found).
/** The plans that may open `file` in the default browser, in try order; [] = none usable. */
export function browserLaunches(
  os: Os,
  file: string,
  handler: string,
  desktopFile = "",
): BrowserLaunch[] {
  const h = handler.trim()
  if (os === "darwin")
    return /\.app\/?$/i.test(h) ? [{ cmd: "open", args: ["-a", h, file], wait: true }] : []
  if (os === "win32") {
    const exe = baseName(h)
    const ok = exe.endsWith(".exe") && !NOT_BROWSER.has(exe.slice(0, -4))
    // The browser itself: it may run until it's closed, so starting (no quick failure) is enough.
    return ok ? [{ cmd: h, args: [file], wait: false }] : []
  }
  const plans: BrowserLaunch[] = []
  const command = /^!([\w.+-]+)$/.exec(h)?.[1]
  if (command) plans.push({ cmd: command, args: [file], wait: false })
  if (/^[\w.+-]+\.desktop$/.test(h)) {
    // gtk-launch isn't everywhere (a separate package on KDE); gio launch takes the file's path.
    plans.push({ cmd: "gtk-launch", args: [h.replace(/\.desktop$/, ""), file], wait: true })
    if (desktopFile) plans.push({ cmd: "gio", args: ["launch", desktopFile, file], wait: true })
  }
  plans.push({ cmd: "x-www-browser", args: [file], wait: false }) // Debian's alternatives link
  return plans
}

/** Where a desktop file id may live (XDG data dirs, user's first), for gio launch. */
export function desktopFileCandidates(
  id: string,
  env: { XDG_DATA_HOME?: string; XDG_DATA_DIRS?: string },
  home: string,
): string[] {
  if (!/^[\w.+-]+\.desktop$/.test(id)) return []
  const dirs = [
    env.XDG_DATA_HOME || `${home}/.local/share`,
    ...(env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":"),
  ]
  return dirs
    .filter((d) => d.startsWith("/"))
    .map((d) => `${d.replace(/\/$/, "")}/applications/${id}`)
}
