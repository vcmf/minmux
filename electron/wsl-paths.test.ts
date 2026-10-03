import { describe, it, expect } from "vitest"
import { wslUncCandidates, uncToWslPath } from "./wsl-paths"

describe("wslUncCandidates", () => {
  it("maps an absolute Linux path into both share forms, newest first", () => {
    expect(wslUncCandidates("Ubuntu", "/home/me/proj")).toEqual([
      "\\\\wsl.localhost\\Ubuntu\\home\\me\\proj",
      "\\\\wsl$\\Ubuntu\\home\\me\\proj",
    ])
  })
  it("handles the filesystem root", () => {
    expect(wslUncCandidates("Ubuntu", "/")[0]).toBe("\\\\wsl.localhost\\Ubuntu\\")
  })
  it("keeps a distro name with dots/dashes", () => {
    expect(wslUncCandidates("Ubuntu-22.04", "/srv")[0]).toBe("\\\\wsl.localhost\\Ubuntu-22.04\\srv")
  })
  it("returns [] without a distro (can't form a UNC)", () => {
    expect(wslUncCandidates(undefined, "/home/me")).toEqual([])
  })
  it("returns [] for a non-absolute path", () => {
    expect(wslUncCandidates("Ubuntu", "relative/x")).toEqual([])
    expect(wslUncCandidates("Ubuntu", "")).toEqual([])
  })
})

describe("uncToWslPath", () => {
  it("maps a WSL UNC path back to its Linux form", () => {
    expect(uncToWslPath("\\\\wsl.localhost\\Ubuntu\\home\\me\\proj")).toBe("/home/me/proj")
    expect(uncToWslPath("\\\\wsl$\\Ubuntu-22.04\\srv")).toBe("/srv")
  })
  it("maps the distro root to /", () => {
    expect(uncToWslPath("\\\\wsl.localhost\\Ubuntu")).toBe("/")
  })
  it("returns null for a non-WSL-UNC path", () => {
    expect(uncToWslPath("C:\\Users\\me")).toBeNull()
    expect(uncToWslPath("/home/me")).toBeNull()
    expect(uncToWslPath("\\\\server\\share\\x")).toBeNull()
  })
})
