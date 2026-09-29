import { describe, expect, it } from "vitest"
import { declineIntegration, integrationOn, setIntegration, undecided } from "./ssh-integration"

describe("integrationOn", () => {
  it("is off unless something matches", () => {
    expect(integrationOn("gpu", [])).toBe(false)
    expect(integrationOn("gpu", ["web"])).toBe(false)
    expect(integrationOn("GPU", ["gpu"])).toBe(true) // case-insensitive, like ssh's Host
  })

  it("patterns, with negated ones winning over other patterns", () => {
    expect(integrationOn("gpu-1", ["gpu-*"])).toBe(true)
    expect(integrationOn("gpu-old", ["gpu-*", "!gpu-old"])).toBe(false)
    expect(integrationOn("gpu-old", ["!gpu-o*", "gpu-*"])).toBe(false)
  })

  it("a host's own entry beats any pattern", () => {
    expect(integrationOn("gpu-old", ["!gpu-*", "gpu-old"])).toBe(true)
    expect(integrationOn("gpu-1", ["gpu-*", "!gpu-1"])).toBe(false)
  })
})

describe("setIntegration", () => {
  it("adds and removes a host's own entry", () => {
    expect(setIntegration([], "gpu", true)).toEqual(["gpu"])
    expect(setIntegration(["gpu", "web"], "GPU", false)).toEqual(["web"])
  })

  it("adds an exception when a pattern still decides otherwise", () => {
    expect(setIntegration(["gpu-*"], "gpu-1", false)).toEqual(["gpu-*", "!gpu-1"])
    expect(setIntegration(["!gpu-*"], "gpu-1", true)).toEqual(["!gpu-*", "gpu-1"])
    expect(setIntegration(["gpu-*", "!gpu-1"], "gpu-1", true)).toEqual(["gpu-*"])
  })

  it("the result always says what was asked", () => {
    for (const list of [[], ["*"], ["!*"], ["g*", "!gpu"], ["gpu"], ["!gpu"]]) {
      for (const on of [true, false]) {
        expect(integrationOn("gpu", setIntegration(list, "gpu", on))).toBe(on)
      }
    }
  })
})

describe("integration modes", () => {
  it("all: every host but its exceptions; off: none", () => {
    expect(integrationOn("gpu", [], "all")).toBe(true)
    expect(integrationOn("prod-1", ["!prod-*"], "all")).toBe(false)
    expect(integrationOn("prod-1", ["!prod-*", "prod-1"], "all")).toBe(true) // its own entry wins
    expect(integrationOn("gpu", ["gpu"], "off")).toBe(false)
  })

  it("toggling a host says what was asked, in every mode", () => {
    for (const mode of ["ask", "all"] as const) {
      for (const list of [[], ["*"], ["!*"], ["!prod-*"], ["gpu"], ["!gpu"]]) {
        for (const on of [true, false]) {
          expect(integrationOn("gpu", setIntegration(list, "gpu", on, mode), mode)).toBe(on)
        }
      }
    }
  })

  it("undecided: no entry mentions the host (a hint may ask)", () => {
    expect(undecided("gpu", [])).toBe(true)
    expect(undecided("gpu", ["web"])).toBe(true)
    expect(undecided("gpu", ["!gpu"])).toBe(false)
    expect(undecided("gpu", ["g*"])).toBe(false)
    expect(undecided("gpu", ["!g*"])).toBe(false)
  })

  it("declining writes an explicit !alias", () => {
    expect(declineIntegration(["gpu", "web"], "GPU")).toEqual(["web", "!GPU"])
    expect(integrationOn("gpu", declineIntegration(["*"], "gpu"), "all")).toBe(false)
  })
})
