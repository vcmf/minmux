import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { cspFor, withCsp } from "./csp"

const sha = (s: string) => `'sha256-${createHash("sha256").update(s).digest("base64")}'`

describe("cspFor", () => {
  it("allows index.html's inline script by its hash, and nothing else inline", () => {
    const html = readFileSync("index.html", "utf8")
    const inline = /<script>([\s\S]*?)<\/script>/.exec(html)![1]!
    const csp = cspFor(html)
    expect(csp).toContain(`script-src 'self' ${sha(inline)}`)
    expect(csp).not.toContain("unsafe-eval")
    expect(csp.match(/script-src[^;]*/)![0]).not.toContain("unsafe-inline")
    expect(csp).toContain("object-src 'none'")
  })

  it("hashes each inline script, never one loaded by src", () => {
    const csp = cspFor(
      '<script>a()</script><script type="module" src="/x.js"></script><script>b()</script>',
    )
    expect(csp).toContain(`script-src 'self' ${sha("a()")} ${sha("b()")};`)
  })
})

describe("withCsp", () => {
  it("puts the policy first in <head>", () => {
    const out = withCsp("<html><head><script>a()</script></head></html>")
    expect(out.indexOf("Content-Security-Policy")).toBeLessThan(out.indexOf("<script>"))
  })
})
