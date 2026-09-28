import { describe, expect, it } from "vitest"
import { integrationOn, setIntegration } from "./ssh-integration"

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
