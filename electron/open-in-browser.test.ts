import { describe, it, expect } from "vitest"
import { browserLaunch } from "./open-in-browser"

describe("browserLaunch", () => {
  it("macOS: open -a the browser app, its exit code tells", () => {
    expect(browserLaunch("darwin", "/w/a.html", "/Applications/Safari.app")).toEqual({
      cmd: "open",
      args: ["-a", "/Applications/Safari.app", "/w/a.html"],
      wait: true,
    })
  })

  it("Windows: the browser exe itself, started (it may run until closed)", () => {
    const exe = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    expect(browserLaunch("win32", "C:\\w\\a.html", exe)).toEqual({
      cmd: exe,
      args: ["C:\\w\\a.html"],
      wait: false,
    })
  })

  it("Linux: gtk-launch the default browser's desktop id", () => {
    expect(browserLaunch("linux", "/w/a.html", "firefox.desktop\n")).toEqual({
      cmd: "gtk-launch",
      args: ["firefox", "/w/a.html"],
      wait: true,
    })
  })

  it("no usable handler: no plan (the caller falls back to the default app)", () => {
    expect(browserLaunch("darwin", "/w/a.html", "")).toBeNull()
    expect(browserLaunch("darwin", "/w/a.html", "/usr/local/bin/tool")).toBeNull()
    expect(browserLaunch("win32", "C:\\w\\a.html", "C:\\x\\run.bat")).toBeNull()
    expect(browserLaunch("linux", "/w/a.html", "../x.desktop; rm")).toBeNull()
  })
})
