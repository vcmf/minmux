// "Open in browser" for a web page: the OS's default app for .html may be an editor, so the
// file goes to the default *web browser* (the https handler) instead. Pure: main looks the
// handler up and runs the plan; no plan (or a failed one) falls back to the default app.

import type { Os } from "./open-policy"

/** How to launch the browser on a file; `wait` = its exit code says whether it worked. */
export interface BrowserLaunch {
  cmd: string
  args: string[]
  wait: boolean
}

// `handler` is the default browser as each OS names it: macOS an .app path, Windows an .exe
// path (Electron's getApplicationInfoForProtocol), Linux a desktop-file id (xdg-settings).
/** The command that opens `file` in the default browser, or null when the handler is unusable. */
export function browserLaunch(os: Os, file: string, handler: string): BrowserLaunch | null {
  const h = handler.trim()
  if (os === "darwin" && /\.app\/?$/i.test(h))
    return { cmd: "open", args: ["-a", h, file], wait: true }
  // The browser itself: it may run until it's closed, so starting it is the success.
  if (os === "win32" && /\.exe$/i.test(h)) return { cmd: h, args: [file], wait: false }
  if (os === "linux" && /^[\w.-]+\.desktop$/.test(h))
    return { cmd: "gtk-launch", args: [h.replace(/\.desktop$/, ""), file], wait: true }
  return null
}
