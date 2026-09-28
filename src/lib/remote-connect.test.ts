import { describe, expect, it } from "vitest"
import {
  afterStart,
  banner,
  cleanError,
  cursorBelowContent,
  firstStart,
  idleMessage,
  isIdle,
  onKey,
  type RemotePhase,
} from "./remote-connect"

describe("firstStart", () => {
  it("only a restored pane under on-focus waits (and even then reattaches a live one)", () => {
    expect(firstStart(true, "on-focus")).toBe("attach")
    expect(firstStart(true, "auto")).toBe("spawn")
    expect(firstStart(false, "on-focus")).toBe("spawn")
    expect(firstStart(false, "auto")).toBe("spawn")
  })
})

describe("afterStart", () => {
  it("started: false means nothing was live → waiting; otherwise live", () => {
    expect(afterStart("starting", false)).toBe("waiting")
    expect(afterStart("starting", true)).toBe("live")
    expect(afterStart("starting", undefined)).toBe("live") // older main / local shape
  })

  it("never overrides a phase something else already moved it to", () => {
    for (const p of ["live", "waiting", "closed", "failed"] as RemotePhase[]) {
      expect(afterStart(p, true)).toBe(p)
      expect(afterStart(p, false)).toBe(p)
    }
  })
})

describe("onKey", () => {
  it("forwards everything while starting or live", () => {
    expect(onKey("live", "x")).toBe("forward")
    expect(onKey("starting", "\r")).toBe("forward")
  })

  it("an idle pane connects on a bare Enter and drops anything else", () => {
    for (const p of ["waiting", "closed", "failed"] as RemotePhase[]) {
      expect(onKey(p, "\r")).toBe("connect")
      expect(onKey(p, "x")).toBe("drop")
      expect(onKey(p, "ls\r")).toBe("drop") // a paste ending in Enter isn't a connect
      expect(onKey(p, "\u001b[A")).toBe("drop")
    }
  })
})

describe("isIdle", () => {
  it("is true only for the prompt phases", () => {
    expect(["waiting", "closed", "failed"].every((p) => isIdle(p as RemotePhase))).toBe(true)
    expect(isIdle("live")).toBe(false)
    expect(isIdle("starting")).toBe(false)
    expect(isIdle(undefined)).toBe(false)
  })
})

describe("idleMessage", () => {
  it("names the host and what Enter does", () => {
    expect(idleMessage("waiting", "gpu")).toBe("gpu — press Enter to connect")
    expect(idleMessage("closed", "gpu", { code: 0, signal: 0 })).toBe(
      "session on gpu ended — press Enter to start a new one",
    )
    expect(idleMessage("closed", "gpu", { code: 255, signal: 0 })).toBe(
      "connection to gpu closed (code 255) — press Enter to reconnect",
    )
    expect(idleMessage("closed", "gpu", { code: 0, signal: 9 })).toBe(
      "connection to gpu closed (signal 9) — press Enter to reconnect",
    )
    expect(idleMessage("failed", "gpu", { error: "host not listed" })).toBe(
      "couldn't connect to gpu: host not listed — press Enter to retry",
    )
  })
})

describe("cleanError", () => {
  it("drops Electron's invoke prefix", () => {
    expect(
      cleanError(new Error("Error invoking remote method 'pty:spawn': Error: ssh isn't installed")),
    ).toBe("ssh isn't installed")
  })

  it("replaces control characters (a remote error can't drive the terminal)", () => {
    expect(cleanError("bad\u001b]0;title\u0007 thing\nnext")).toBe("bad ]0;title  thing next")
  })

  it("caps the length and never returns an empty line", () => {
    expect(cleanError("x".repeat(500))).toHaveLength(301)
    expect(cleanError("")).toBe("unknown error")
    expect(cleanError(undefined)).toBe("unknown error")
  })
})

describe("banner", () => {
  it("puts a dim [smterm] line on its own row", () => {
    expect(banner("hi")).toBe("\r\n\u001b[2m[smterm] hi\u001b[0m\r\n")
  })
})

describe("cursorBelowContent", () => {
  it("moves a cursor left above the output down to the last non-blank row", () => {
    // A TUI homed the cursor (row 0) over 10 rows of output; screen top = buffer row 0.
    expect(cursorBelowContent({ lastContentRow: 9, cursorRow: 0, baseY: 0 })).toBe("\u001b[10;1H")
    // Scrolled: rows are absolute, the CSI is screen-relative.
    expect(cursorBelowContent({ lastContentRow: 120, cursorRow: 101, baseY: 100 })).toBe(
      "\u001b[21;1H",
    )
  })

  it("leaves a cursor that's already on or below the output alone", () => {
    expect(cursorBelowContent({ lastContentRow: 9, cursorRow: 9, baseY: 0 })).toBe("")
    expect(cursorBelowContent({ lastContentRow: 9, cursorRow: 12, baseY: 0 })).toBe("")
    expect(cursorBelowContent({ lastContentRow: -1, cursorRow: 0, baseY: 0 })).toBe("")
  })
})
