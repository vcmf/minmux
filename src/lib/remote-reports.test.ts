import { describe, expect, it } from "vitest"
import { folderFromHex, parseRemoteReport } from "./remote-reports"

const N = "0123456789abcdef".repeat(2)
const hex = (s: string) => Buffer.from(s, "utf8").toString("hex")
const P = (dir: string, host = "gpu-box") => `${N};P;${host};${hex(dir)}`

describe("parseRemoteReport", () => {
  it("reads the hooks' three reports", () => {
    expect(parseRemoteReport(`${N};C`, N)).toEqual({ kind: "start" })
    expect(parseRemoteReport(`${N};D;0`, N)).toEqual({ kind: "end", code: 0 })
    expect(parseRemoteReport(`${N};D;130`, N)).toEqual({ kind: "end", code: 130 })
    expect(parseRemoteReport(P("/home/q/llm train", "GPU-Box.lan"), N)).toEqual({
      kind: "cwd",
      host: "gpu-box.lan",
      dir: "/home/q/llm train",
    })
  })

  it("only this connection's nonce counts", () => {
    const other = "f".repeat(32)
    expect(parseRemoteReport(`${other};C`, N)).toBeNull() // a nested integrated shell, a fake
    expect(parseRemoteReport(`${N};C`, undefined)).toBeNull() // not confirmed (yet)
    expect(parseRemoteReport(`${N.slice(0, 31)};C`, N.slice(0, 31))).toBeNull() // not a nonce
    expect(parseRemoteReport(`${N}C`, N)).toBeNull()
    expect(parseRemoteReport(`x${N};C`, N)).toBeNull()
  })

  it("ignores the bootstrap's own marks and anything malformed", () => {
    for (const d of ["boot;c0ffee00c0ffee00", "hello;c0ffee00c0ffee00", "ok;ab", "skip;ab", ""]) {
      expect(parseRemoteReport(d, N)).toBeNull()
    }
    for (const rest of ["D;", "D;x", "D;1234", "C;extra", "7;file://h/x", "P;h", "P;h;2f;x"]) {
      expect(parseRemoteReport(`${N};${rest}`, N)).toBeNull()
    }
  })

  it("a folder it can't take is still a move (dir null), and an odd host is dropped", () => {
    expect(parseRemoteReport(`${N};P;h;zz`, N)).toEqual({ kind: "cwd", host: "h", dir: null })
    expect(parseRemoteReport(P("/x", "bad host!"), N)).toEqual({ kind: "cwd", host: "", dir: "/x" })
  })
})

describe("folderFromHex", () => {
  it("is exactly the shell's $PWD — nothing a URL would re-read", () => {
    for (const d of ["/srv/proj#2", "/a?b", "/tmp/..\\..\\opt", "/x%2F..%2Fy", "/café", "/a  b "]) {
      expect(folderFromHex(hex(d))).toBe(d)
    }
  })

  it("refuses what it won't show or reopen, never repairing it", () => {
    for (const d of ["relative", "/a/../b", "/a/./b", "/a/..", "/nl\nx", "/bidi‮b", "/zw​x"]) {
      expect(folderFromHex(hex(d))).toBeNull()
    }
    expect(folderFromHex(hex("/" + "a".repeat(1100)))).toBeNull() // capped
    expect(folderFromHex("2fe2")).toBeNull() // not UTF-8 (a truncated sequence)
    expect(folderFromHex("2f6")).toBeNull() // odd length
    expect(folderFromHex("2F61")).toBeNull() // the hooks send lowercase
    expect(folderFromHex("")).toBeNull()
  })
})
