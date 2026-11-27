import { describe, expect, it } from "vitest"
import { shortNames } from "./file-names"

describe("shortNames", () => {
  it("a name, once per file", () => {
    expect(shortNames(["/w/a.ts", "/w/b.ts", "/w/a.ts"])).toEqual(["a.ts", "b.ts"])
  })
  it("its folder when two share a name", () => {
    expect(shortNames(["/w/src/index.ts", "/w/test/index.ts", "/w/x.md"])).toEqual([
      "src/index.ts",
      "test/index.ts",
      "x.md",
    ])
  })
  it("Windows paths too", () => {
    expect(shortNames(["C:\\w\\a.ts"])).toEqual(["a.ts"])
  })
})
