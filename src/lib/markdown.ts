// Markdown → HTML for a file tab's Preview (docs/design/MARKDOWN.md): markdown-it with task
// lists, GitHub's math (KaTeX, loaded only when a document looks like it has math), our raw-HTML
// allowlist (lib/markdown-html), links limited to http(s), mailto and relative ones, GitHub's
// heading anchors and each top-level block's source line. Runs in lib/markdown.worker.
import MarkdownIt from "markdown-it"
import type { MarkdownIt as Md, StateCore, StateInline, Token } from "markdown-it"
import { tasklist } from "@mdit/plugin-tasklist"
import { escapeHtml, HIGHLIGHT_MAX } from "./file-preview"
import { syncHighlighter } from "./highlighter"
import { cleanHtml } from "./markdown-html"

/** What a rendered document is: its HTML, and whether that has math (KaTeX's CSS then). */
export interface Rendered {
  html: string
  math: boolean
}

// `$$`, $`…`$, a ```math fence, or a `$…$` pair on one line that could be math. A false hit only
// costs loading KaTeX; a miss shows that formula as text.
const MATH_HINT = /\$\$|\$`|^\s*(?:```|~~~)\s*math\b|\$[^\s$][^$\n]*\$/m

/** Whether `text` may hold math (KaTeX loads for it). */
export const mayHaveMath = (text: string) => MATH_HINT.test(text)

const SCHEME = /^([a-z][a-z0-9+.-]*):/i

/** A link markdown may write: http(s), mailto, or no scheme (relative, or `#heading`). */
export function safeLink(url: string): boolean {
  const scheme = SCHEME.exec(url.trim())
  return !scheme || /^(?:https?|mailto)$/i.test(scheme[1]!)
}

/** A heading's anchor as GitHub makes it: lowercase, punctuation gone, spaces to `-`. */
export function slugOf(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-")
}

// Fenced code is highlighted once highlight.js has loaded (only for a document with a fence).
let highlight: (code: string, lang: string) => string = (code) => escapeHtml(code)
let highlighting: Promise<void> | null = null
const loadHighlight = () =>
  (highlighting ??= syncHighlighter().then((fn) => {
    highlight = fn
  }))

// `data-anchor`, never `id`: a heading can't clobber the page's names. `data-line` is 1-based.
/** Heading anchors and each top-level block's source line. */
function marks(state: StateCore): void {
  const seen = new Map<string, number>()
  state.tokens.forEach((t, i) => {
    if (t.level === 0 && t.block && t.nesting !== -1 && t.map) {
      t.attrSet("data-line", String(t.map[0] + 1))
    }
    if (t.type !== "heading_open") return
    const words = (state.tokens[i + 1]?.children ?? [])
      .filter((c) => c.type === "text" || c.type === "code_inline")
      .map((c) => c.content)
      .join("")
    const base = slugOf(words)
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    t.attrSet("data-anchor", n ? `${base}-${n}` : base)
  })
}

/** GitHub's $`…`$ inline math (ahead of the `$…$` rule, which would keep the backticks). */
function backtickMath(state: StateInline, silent: boolean): boolean {
  const { src, pos } = state
  if (src.charCodeAt(pos) !== 0x24 || src.charCodeAt(pos + 1) !== 0x60) return false
  const end = src.indexOf("`$", pos + 2)
  if (end < 0) return false
  if (!silent) {
    const t = state.push("math_inline", "math", 0)
    t.content = src.slice(pos + 2, end)
    t.markup = "$`"
  }
  state.pos = end + 2
  return true
}

function base(): Md {
  const md = new MarkdownIt({ html: true, linkify: true })
  md.validateLink = safeLink
  md.use(tasklist)
  const raw = (tokens: Token[], i: number) => cleanHtml(tokens[i]!.content)
  md.renderer.rules.html_block = raw
  md.renderer.rules.html_inline = raw
  md.renderer.rules.fence = (tokens, i, _opts, _env, self) => {
    const t = tokens[i]!
    const lang = t.info.trim().split(/\s+/)[0] ?? ""
    const code =
      lang && t.content.length <= HIGHLIGHT_MAX ? highlight(t.content, lang) : escapeHtml(t.content)
    const cls = lang ? ` class="language-${escapeHtml(lang)}"` : ""
    return `<pre${self.renderAttrs(t)}><code${cls}>${code}</code></pre>\n`
  }
  // An image stays a link to it until images load (step 4 of the design): no remote request.
  md.renderer.rules.image = (tokens, i, opts, env, self) => {
    const t = tokens[i]!
    const src = String(t.attrGet("src") ?? "")
    const alt = self.renderInlineAsText(t.children ?? [], opts, env) || src
    return `<a class="md-img" href="${escapeHtml(src)}">${escapeHtml(alt)}</a>`
  }
  md.core.ruler.push("minmux_marks", marks)
  return md
}

let plain: Md | null = null
let withMath: Promise<Md> | null = null

/** The math instance: KaTeX without `\href` and friends (`trust: false`), errors in red. */
function mathMd(): Promise<Md> {
  withMath ??= import("@mdit/plugin-katex").then(({ katex }) => {
    const md = base() // its fence rule first: `mathFence` wraps it
    md.use(katex, {
      mathFence: true,
      trust: false,
      throwOnError: false,
      logger: () => "ignore" as const,
    })
    md.inline.ruler.before("math_inline_dollar", "math_backtick", backtickMath)
    return md
  })
  withMath.catch(() => (withMath = null)) // a failed chunk load is tried again next time
  return withMath
}

/** `text` rendered (KaTeX and highlight.js load the first time a document needs them). */
export async function renderMarkdown(text: string): Promise<Rendered> {
  if (/^\s*(?:```|~~~)/m.test(text)) await loadHighlight()
  let md = (plain ??= base())
  if (mayHaveMath(text)) md = await mathMd().catch(() => md)
  const html = md.render(text)
  return { html, math: html.includes('class="katex') }
}
