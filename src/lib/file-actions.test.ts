import { describe, it, expect } from "vitest"
import {
  fileMenuItems,
  folderMenuItems,
  clampMenuPosition,
  revealLabel,
  isAbsoluteHostPath,
  isHtmlPath,
} from "./file-actions"

const base = { editorName: "VS Code", editorAvailable: true, revealLabel: "Reveal in Finder" }

describe("fileMenuItems", () => {
  it("file: Preview + Open (named) + Reveal + Copy path + Copy relative", () => {
    const items = fileMenuItems({ ...base, isDir: false })
    expect(items.map((i) => i.id)).toEqual(["preview", "open", "reveal", "copyPath", "copyRel"])
    expect(items.find((i) => i.id === "open")!.label).toBe("Open in VS Code")
    expect(items.find((i) => i.id === "open")!.disabled).toBeFalsy()
    expect(items.find((i) => i.id === "copyPath")!.separatorBefore).toBe(true)
  })

  it("folder: Set as root instead of Preview/Open", () => {
    const items = fileMenuItems({ ...base, isDir: true })
    expect(items.map((i) => i.id)).toEqual(["setRoot", "reveal", "copyPath", "copyRel"])
    expect(items[0]!.label).toBe("Set as root folder")
  })

  it("no editor: Open is disabled with a generic label + hint", () => {
    const items = fileMenuItems({
      isDir: false,
      editorName: "",
      editorAvailable: false,
      revealLabel: "Reveal in Explorer",
    })
    const open = items.find((i) => i.id === "open")!
    expect(open.label).toBe("Open in editor")
    expect(open.disabled).toBe(true)
    expect(open.hint).toBe("not found")
  })

  it("a web page also gets Open in browser, after Open", () => {
    const items = fileMenuItems({ ...base, isDir: false, html: true })
    expect(items.map((i) => i.id)).toEqual([
      "preview",
      "open",
      "browser",
      "reveal",
      "copyPath",
      "copyRel",
    ])
    expect(items.find((i) => i.id === "browser")!.label).toBe("Open in browser")
  })

  it("uses the OS-specific reveal label", () => {
    const items = fileMenuItems({ ...base, isDir: true, revealLabel: "Show in File Manager" })
    expect(items.find((i) => i.id === "reveal")!.label).toBe("Show in File Manager")
  })
})

describe("isHtmlPath", () => {
  it("matches .html and .htm, any case", () => {
    expect(isHtmlPath("/w/index.html")).toBe(true)
    expect(isHtmlPath("/w/a.HTM")).toBe(true)
    expect(isHtmlPath("/w/a.xhtml")).toBe(false)
    expect(isHtmlPath("/w/html")).toBe(false)
    expect(isHtmlPath("/w/a.html.bak")).toBe(false)
  })
})

describe("revealLabel", () => {
  it("names the OS file manager", () => {
    expect(revealLabel("darwin")).toBe("Reveal in Finder")
    expect(revealLabel("win32")).toBe("Reveal in Explorer")
    expect(revealLabel("linux")).toBe("Show in File Manager")
  })
})

describe("isAbsoluteHostPath", () => {
  it("accepts POSIX-absolute, Windows drive and UNC paths", () => {
    expect(isAbsoluteHostPath("/Users/me/x")).toBe(true)
    expect(isAbsoluteHostPath("C:\\Users\\me\\x")).toBe(true)
    expect(isAbsoluteHostPath("D:/repo/x")).toBe(true)
    expect(isAbsoluteHostPath("\\\\server\\share\\proj")).toBe(true)
  })
  it("rejects repo-relative paths", () => {
    expect(isAbsoluteHostPath("src/x.ts")).toBe(false)
    expect(isAbsoluteHostPath("x.ts")).toBe(false)
    expect(isAbsoluteHostPath("")).toBe(false)
  })
})

describe("clampMenuPosition", () => {
  it("passes through when it fits", () => {
    expect(clampMenuPosition(100, 100, 200, 150, 1000, 800)).toEqual({ x: 100, y: 100 })
  })
  it("nudges left/up when it would overflow bottom-right", () => {
    expect(clampMenuPosition(950, 780, 200, 150, 1000, 800)).toEqual({ x: 794, y: 644 })
  })
  it("clamps to the pad when near the top-left edge", () => {
    expect(clampMenuPosition(0, 0, 200, 150, 1000, 800)).toEqual({ x: 6, y: 6 })
  })
})

describe("folderMenuItems", () => {
  it("copy, open a terminal there, reveal — reveal disabled for a WSL path", () => {
    expect(folderMenuItems("Reveal in Finder").map((i) => i.label)).toEqual([
      "Copy path",
      "Open terminal here",
      "Open in a tab",
      "Reveal in Finder",
    ])
    const wsl = folderMenuItems("Reveal in Explorer", "WSL path")[3]
    expect(wsl).toMatchObject({ disabled: true, hint: "WSL path" })
  })
})
