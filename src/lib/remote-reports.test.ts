import { describe, expect, it } from "vitest"
import { parseRemoteReport } from "./remote-reports"

const N = "0123456789abcdef".repeat(2)

describe("parseRemoteReport", () => {
  it("reads the hooks' three reports", () => {
    expect(parseRemoteReport(`${N};C`, N)).toEqual({ kind: "start" })
    expect(parseRemoteReport(`${N};D;0`, N)).toEqual({ kind: "end", code: 0 })
    expect(parseRemoteReport(`${N};D;130`, N)).toEqual({ kind: "end", code: 130 })
    expect(parseRemoteReport(`${N};7;file://gpu-box/home/q/llm%20train`, N)).toEqual({
      kind: "cwd",
      host: "gpu-box",
      dir: "/home/q/llm train",
    })
  })

  it("only this connection's nonce counts", () => {
    const other = "f".repeat(32)
    expect(parseRemoteReport(`${other};C`, N)).toBeNull() // a nested integrated shell, a fake
    expect(parseRemoteReport(`${N};C`, undefined)).toBeNull() // not integrated (yet)
    expect(parseRemoteReport(`${N.slice(0, 31)};C`, N.slice(0, 31))).toBeNull() // not a nonce
    expect(parseRemoteReport(`${N}C`, N)).toBeNull()
    expect(parseRemoteReport(`x${N};C`, N)).toBeNull()
  })

  it("ignores the bootstrap's own marks and anything malformed", () => {
    for (const d of ["boot;c0ffee00c0ffee00", "hello;c0ffee00c0ffee00", "skip;ab", ""]) {
      expect(parseRemoteReport(d, N)).toBeNull()
    }
    for (const rest of ["D;", "D;x", "D;1234", "C;extra", "7;", "7;not a url", "7;file://h/C:/x"]) {
      expect(parseRemoteReport(`${N};${rest}`, N)).toBeNull()
    }
    // A folder with control / format characters is refused (cleanRemoteCwd).
    expect(parseRemoteReport(`${N};7;file://h/a%1bb`, N)).toBeNull()
    expect(parseRemoteReport(`${N};7;file://h/a%E2%80%AEb`, N)).toBeNull()
  })
})
