import { describe, it, expect } from "vitest"
import { execFileSync } from "node:child_process"
import { posixQuote } from "./shell-quote"

describe("posixQuote", () => {
  it("round-trips anything through sh unchanged", () => {
    for (const s of ["plain", "it's", `"$HOME" \`x\` \\n`, "", "a b\tc"]) {
      const out = execFileSync("sh", ["-c", `printf %s ${posixQuote(s)}`], { encoding: "utf8" })
      expect(out).toBe(s)
    }
  })
})
