// The renderer's Content-Security-Policy (docs/design/MARKDOWN.md, step 2): a second lock behind
// every place that puts HTML in the page (markdown's allowlist first). Only our own bundled scripts
// run, plus index.html's inline pre-paint script by its hash. Build-time: electron.vite.config adds
// it to the built index.html (the dev server injects inline scripts of its own). Node only.
import { createHash } from "node:crypto"
import type { Plugin } from "vite"

const INLINE_SCRIPT = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/gi

/** The policy for a page: its inline scripts allowed by their sha256, nothing else inline. */
export function cspFor(html: string): string {
  // Hashed as Chromium sees it: its parser turns CRLF (a Windows checkout) into LF first.
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map((m) => {
    const text = m[1]!.replace(/\r\n?/g, "\n")
    return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`
  })
  return [
    "default-src 'self'",
    ["script-src 'self'", ...hashes].join(" "),
    "style-src 'self' 'unsafe-inline'", // React's and KaTeX's style attributes, xterm's <style>
    "img-src 'self' data: blob:", // remote images come through main, as blob: (MARKDOWN.md step 4)
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ")
}

// After the charset meta (it must stay in the first 1024 bytes), before any script. A page
// without a place for it fails the build: shipping without the policy must never be silent.
/** `html` with its policy in <head>, ahead of every script. */
export function withCsp(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${cspFor(html)}" />`
  const at = /<meta\s+charset=[^>]*>/i.exec(html) ?? /<head\b[^>]*>/i.exec(html)
  if (!at) throw new Error("csp: index.html has no <head> to put the policy in")
  const end = at.index + at[0].length
  return `${html.slice(0, end)}\n    ${meta}${html.slice(end)}`
}

// remote.html (the phone's page) gets its policy as a header from the remote-host worker, which
// knows the host it's served from.
/** The vite plugin: the built index.html gets its policy. */
export const cspPlugin = (): Plugin => ({
  name: "minmux-csp",
  apply: "build",
  transformIndexHtml: {
    order: "post",
    handler: (html, ctx) => (ctx.path.endsWith("/remote.html") ? html : withCsp(html)),
  },
})
