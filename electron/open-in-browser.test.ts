import { describe, it, expect } from "vitest"
import { browserLaunches, desktopFileCandidates } from "./open-in-browser"

describe("browserLaunches", () => {
  it("macOS: open -a the browser app, its exit code tells", () => {
    expect(browserLaunches("darwin", "/w/a.html", "/Applications/Safari.app")).toEqual([
      { cmd: "open", args: ["-a", "/Applications/Safari.app", "/w/a.html"], wait: true },
    ])
  })

  it("Windows: the browser exe itself, started (it may run until closed)", () => {
    const exe = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    expect(browserLaunches("win32", "C:\\w\\a.html", exe)).toEqual([
      { cmd: exe, args: ["C:\\w\\a.html"], wait: false },
    ])
  })

  it("Windows: an https handler that isn't a browser is never handed the file", () => {
    for (const h of [
      "C:\\Windows\\System32\\rundll32.exe",
      "C:\\Windows\\System32\\OpenWith.exe",
      "C:\\Windows\\explorer.exe",
      "C:\\x\\run.bat",
    ])
      expect(browserLaunches("win32", "C:\\w\\a.html", h)).toEqual([])
  })

  it("Linux: gtk-launch, then gio launch on its desktop file, then x-www-browser", () => {
    const plans = browserLaunches(
      "linux",
      "/w/a.html",
      "firefox.desktop\n",
      "/usr/share/applications/firefox.desktop",
    )
    expect(plans).toEqual([
      { cmd: "gtk-launch", args: ["firefox", "/w/a.html"], wait: true },
      {
        cmd: "gio",
        args: ["launch", "/usr/share/applications/firefox.desktop", "/w/a.html"],
        wait: true,
      },
      { cmd: "x-www-browser", args: ["/w/a.html"], wait: false },
    ])
  })

  it("Linux: KDE's !command runs that browser; no desktop file skips gio", () => {
    expect(browserLaunches("linux", "/w/a.html", "!firefox")[0]).toEqual({
      cmd: "firefox",
      args: ["/w/a.html"],
      wait: false,
    })
    const plans = browserLaunches("linux", "/w/a.html", "brave.desktop")
    expect(plans.map((p) => p.cmd)).toEqual(["gtk-launch", "x-www-browser"])
  })

  it("no usable handler: nothing to try (the caller falls back to the default app)", () => {
    expect(browserLaunches("darwin", "/w/a.html", "")).toEqual([])
    expect(browserLaunches("darwin", "/w/a.html", "/usr/local/bin/tool")).toEqual([])
    expect(browserLaunches("linux", "/w/a.html", "../x.desktop; rm").map((p) => p.cmd)).toEqual([
      "x-www-browser",
    ])
  })
})

describe("desktopFileCandidates", () => {
  it("the user's data dir first, then XDG_DATA_DIRS (default when unset)", () => {
    expect(desktopFileCandidates("firefox.desktop", {}, "/home/u")).toEqual([
      "/home/u/.local/share/applications/firefox.desktop",
      "/usr/local/share/applications/firefox.desktop",
      "/usr/share/applications/firefox.desktop",
    ])
    expect(
      desktopFileCandidates(
        "a.desktop",
        { XDG_DATA_HOME: "/x", XDG_DATA_DIRS: "/var/lib/flatpak/exports/share/:rel" },
        "/h",
      ),
    ).toEqual([
      "/x/applications/a.desktop",
      "/var/lib/flatpak/exports/share/applications/a.desktop",
    ])
  })

  it("not a desktop id: nothing", () => {
    expect(desktopFileCandidates("../../etc/x", {}, "/h")).toEqual([])
  })
})
