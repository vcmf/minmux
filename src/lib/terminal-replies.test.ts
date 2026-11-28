import { describe, expect, it } from "vitest"
import { isFocusReport, isTerminalReply } from "./terminal-replies"

describe("terminal replies", () => {
  it("tells xterm's answers from typing", () => {
    for (const r of [
      "\x1b[12;1R",
      "\x1b[?62;22c",
      "\x1b[>0;276;0c",
      "\x1b[?2031;2$y",
      "\x1b[?997;1n",
      "\x1b[0n",
      "\x1b[8;24;80t",
      "\x1b]11;rgb:0000/0000/0000\x1b\\",
      "\x1b]10;rgb:ffff/ffff/ffff\x07",
      "\x1bP>|xterm.js(5.5.0)\x1b\\",
    ])
      expect(isTerminalReply(r)).toBe(true)
    for (const k of ["a", "ls\r", "\x1b[A", "\x1b[15~", "\x03", "\x1b"])
      expect(isTerminalReply(k)).toBe(false)
    expect(isFocusReport("\x1b[I")).toBe(true)
    expect(isFocusReport("\x1b[O")).toBe(true)
    expect(isFocusReport("\x1b[A")).toBe(false)
  })
})
