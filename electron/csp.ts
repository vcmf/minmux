// The renderer's Content-Security-Policy (docs/design/MARKDOWN.md, step 2): a second lock behind
// every place that puts HTML in the page (markdown's allowlist first). Only our own bundled scripts
// run, plus index.html's inline pre-paint script by its hash. Build-time: electron.vite.config adds
// it to the built index.html (the dev server injects inline scripts of its own). Node only.
import { createHash } from "node:crypto"
import type { Plugin } from "vite"

const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi

/** The policy for a page: its inline scripts allowed by their sha256, nothing else inline. */
export function cspFor(html: string): string {
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map(
    (m) => `'sha256-${createHash("sha256").update(m[1]!, "utf8").digest("base64")}'`,
  )
  return [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(" "),
    "style-src 'self' 'unsafe-inline'", // React's and KaTeX's style attributes, xterm's <style>
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ")
}

/** `html` with its policy as the first thing in <head> (before any script it governs). */
export function withCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFor(html)}" />`
  return html.replace(/<head>/i, (h) => `${h}\n    ${meta}`)
}

/** The vite plugin: the built index.html gets its policy. */
export const cspPlugin = (): Plugin => ({
  name: "minmux-csp",
  apply: "build",
  transformIndexHtml: { order: "post", handler: withCsp },
})
