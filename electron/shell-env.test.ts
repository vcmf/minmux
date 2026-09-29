import { describe, it, expect } from "vitest"
import { parseEnvBlock } from "./shell-env"

const D = "__MINMUX_ENV__"

describe("parseEnvBlock", () => {
  it("parses KEY=VALUE lines between the delimiters", () => {
    const out = `${D}\nPATH=/opt/homebrew/bin:/usr/bin\nHOME=/Users/x\n${D}\n`
    expect(parseEnvBlock(out)).toEqual({ PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/Users/x" })
  })

  it("ignores prompt/init noise printed outside the delimiters", () => {
    const out = `some rc noise\n${D}\nPATH=/bin\n${D}\ntrailing prompt $ `
    expect(parseEnvBlock(out)).toEqual({ PATH: "/bin" })
  })

  it("keeps '=' inside values (e.g. LS_COLORS)", () => {
    const out = `${D}\nLS_COLORS=di=34:ln=35\n${D}`
    expect(parseEnvBlock(out)).toEqual({ LS_COLORS: "di=34:ln=35" })
  })

  it("returns {} when the delimiters are absent or unbalanced", () => {
    expect(parseEnvBlock("no delimiters here")).toEqual({})
    expect(parseEnvBlock(`${D}\nPATH=/bin\n`)).toEqual({}) // only one delimiter
  })
})
