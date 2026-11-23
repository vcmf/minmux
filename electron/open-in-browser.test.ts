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

  it("Windows: an https handler that isn't a browser is never handed the file", () => {
    for (const h of [
      "C:\\Windows\\System32\\rundll32.exe",
      "C:\\Windows\\System32\\OpenWith.exe",
      "C:\\Windows\\System32\\LaunchWinApp.exe",
      "C:\\Windows\\explorer.exe",
      "C:\\Windows\\hh.exe",
      "C:\\Windows\\System32\\msiexec.exe",
      "C:\\x\\run.bat",
    ])
      expect(browserLaunch("win32", "C:\\w\\a.html", h)).toBeNull()
  })

  it("Linux, or no usable handler: no plan (the caller opens it in the default app)", () => {
    expect(browserLaunch("linux", "/w/a.html", "firefox.desktop")).toBeNull()
    expect(browserLaunch("darwin", "/w/a.html", "")).toBeNull()
    expect(browserLaunch("darwin", "/w/a.html", "/usr/local/bin/tool")).toBeNull()
  })
})
