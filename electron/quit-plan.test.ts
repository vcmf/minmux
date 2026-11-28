import { describe, it, expect } from "vitest"
import { closeStep, quitNeedsConfirm, quitStep, type QuitState } from "./quit-plan"

const base: QuitState = {
  phase: "running",
  confirmed: false,
  asking: false,
  needsConfirm: false,
  livePtys: 2,
  osEnding: false,
}
const step = (o: Partial<QuitState>) => quitStep({ ...base, ...o })

describe("quitStep", () => {
  it("asks the page what's unsaved first, whatever the confirm setting, before the drain", () => {
    expect(step({ canAskUnsaved: true, livePtys: 0 })).toBe("checkUnsaved")
    expect(step({ canAskUnsaved: true, needsConfirm: true })).toBe("checkUnsaved")
    expect(step({ canAskUnsaved: true, checkingUnsaved: true })).toBe("hold")
    expect(step({ canAskUnsaved: true, asking: true })).toBe("hold")
    expect(step({ canAskUnsaved: true, unsavedChecked: true, livePtys: 0 })).toBe("proceed")
    expect(step({ canAskUnsaved: false, livePtys: 0 })).toBe("proceed") // no page to ask
  })
  it("then waits for writes in flight (once)", () => {
    expect(step({ unsavedChecked: true, savesInFlight: 1 })).toBe("waitSaves")
    expect(step({ savesInFlight: 1, waitingSaves: true })).toBe("hold")
  })
  it("an OS logout is never held for unsaved files or saves", () => {
    expect(step({ osEnding: true, canAskUnsaved: true, savesInFlight: 1 })).toBe("killNow")
    expect(step({ osEnding: true, needsConfirm: true })).toBe("killNow") // no confirm either
    expect(step({ osEnding: true, needsConfirm: true, livePtys: 0 })).toBe("proceed")
  })

  it("live PTYs → drain first; nothing alive → quit right away", () => {
    expect(step({})).toBe("drain")
    expect(step({ livePtys: 0 })).toBe("proceed")
  })
  it("asks first when the confirm dialog applies; a confirmed quit drains", () => {
    expect(step({ needsConfirm: true })).toBe("confirm")
    expect(step({ needsConfirm: true, confirmed: true })).toBe("drain")
  })
  it("a dialog already up holds a second quit instead of stacking another", () => {
    expect(step({ needsConfirm: true, asking: true })).toBe("hold")
  })
  it("while draining: hold (no dialog, no second drain); once drained: proceed", () => {
    expect(step({ phase: "draining", needsConfirm: true })).toBe("hold")
    expect(step({ phase: "drained", livePtys: 3 })).toBe("proceed")
  })
  it("an OS logout/restart isn't held (macOS would report it cancelled)", () => {
    expect(step({ osEnding: true })).toBe("killNow")
    expect(step({ osEnding: true, livePtys: 0 })).toBe("proceed")
  })
})

describe("quitNeedsConfirm", () => {
  const o = { live: 2, enabled: true, hasWindow: true, platform: "darwin" }
  it("asks with live sessions and the setting on", () => {
    expect(quitNeedsConfirm(o)).toBe(true)
    expect(quitNeedsConfirm({ ...o, live: 0 })).toBe(false)
    expect(quitNeedsConfirm({ ...o, enabled: false })).toBe(false)
  })
  it("macOS asks with no window (after ⌘W); elsewhere no window means it's closing", () => {
    expect(quitNeedsConfirm({ ...o, hasWindow: false })).toBe(true)
    expect(quitNeedsConfirm({ ...o, hasWindow: false, platform: "win32" })).toBe(false)
  })
})

describe("closeStep", () => {
  const o = { platform: "darwin", quitThrough: false, plain: false }
  it("macOS's red button becomes the guarded quit", () => {
    expect(closeStep(o)).toBe("quit")
  })
  it("closes when the quit let it through, for the menu's ⌘W, and off macOS", () => {
    expect(closeStep({ ...o, quitThrough: true })).toBe("close")
    expect(closeStep({ ...o, plain: true })).toBe("close")
    expect(closeStep({ ...o, platform: "linux" })).toBe("close")
  })
})
