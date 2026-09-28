import { describe, expect, it } from "vitest"
import { SSH_ERRORS, canRetry, sshFailureKind } from "./ssh-errors"

describe("sshFailureKind", () => {
  it("classifies main's messages (the shared constants, so they can't drift)", () => {
    expect(sshFailureKind(SSH_ERRORS.hostGone)).toBe("host-gone")
    expect(sshFailureKind(SSH_ERRORS.noSsh)).toBe("no-ssh")
    expect(sshFailureKind(SSH_ERRORS.newerBuild)).toBe("not-here")
    expect(sshFailureKind(SSH_ERRORS.wslOffWindows)).toBe("not-here")
    expect(sshFailureKind(SSH_ERRORS.wslDown("Ubuntu-22.04"))).toBe("wsl-down")
    expect(sshFailureKind(SSH_ERRORS.cantBuild)).toBe("other")
    expect(sshFailureKind("anything else")).toBe("other")
  })

  it("matches inside a longer message too", () => {
    expect(sshFailureKind(`Error: ${SSH_ERRORS.hostGone}`)).toBe("host-gone")
  })
})

describe("canRetry", () => {
  it("only a failure that can't ever work here is final", () => {
    expect(canRetry("not-here")).toBe(false)
    for (const k of ["host-gone", "no-ssh", "wsl-down", "other"] as const)
      expect(canRetry(k)).toBe(true)
  })
})
