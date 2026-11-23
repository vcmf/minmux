import { describe, expect, it } from "vitest"
import { mayHaveMath, renderMarkdown, safeLink, slugOf } from "./markdown"
import { cleanHtml } from "./markdown-html"

const html = async (md: string) => (await renderMarkdown(md)).html

describe("renderMarkdown", () => {
  it("renders GitHub's blocks: tables, task lists, strikethrough", async () => {
    const out = await html("| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~")
    expect(out).toContain("<table")
    expect(out).toContain('type="checkbox"')
    expect(out).toContain("checked")
    expect(out).toContain("<s>gone</s>")
  })

  it("marks each top-level block with its source line", async () => {
    const out = await html("# Title\n\npara one\n\n- a\n- b\n\n```\ncode\n```\n")
    expect(out).toContain('<h1 data-line="1"')
    expect(out).toContain('<p data-line="3">')
    expect(out).toContain('<ul data-line="5">')
    expect(out).toContain('<pre data-line="8">')
    expect(out).not.toMatch(/<li[^>]*data-line/) // only top-level blocks
  })

  it("gives headings GitHub's anchors, numbered when repeated", async () => {
    const out = await html("## Hello, `World`!\n\n## Hello, World\n\n## Ça va?")
    expect(out).toContain('data-anchor="hello-world"')
    expect(out).toContain('data-anchor="hello-world-1"')
    expect(out).toContain('data-anchor="ça-va"')
    expect(out).not.toMatch(/\sid=/)
  })

  it("highlights fenced code by its language", async () => {
    const out = await html("```ts\nconst a = 1\n```")
    expect(out).toContain('class="language-ts"')
    expect(out).toContain("hljs-keyword")
  })

  it("shows an image as a link to it, loading nothing", async () => {
    const out = await html("![a shot](docs/shot.png) ![](https://x.test/p.png)")
    expect(out).not.toContain("<img")
    expect(out).toContain(
      '<a class="md-img" href="docs/shot.png" data-src="docs/shot.png">a shot</a>',
    )
    expect(out).toContain('data-src="https://x.test/p.png">https://x.test/p.png</a>')
  })

  it("a linked image (a badge) is its link's text, the link kept", async () => {
    const out = await html("[![build](https://img.test/x.svg)](https://ci.test/run)")
    expect(out).toContain(
      '<a href="https://ci.test/run"><span class="md-img" data-src="https://img.test/x.svg">build</span></a>',
    )
  })

  it("links bare URLs", async () => {
    expect(await html("see https://example.com now")).toContain('<a href="https://example.com">')
  })
})

describe("a PR's body (repo given)", () => {
  const pr = async (md: string) => (await renderMarkdown(md, { repo: "o/r" })).html

  it("links #12 and owner/name#12, never in code, a link, a URL or a word", async () => {
    const out = await pr("Fixes #12 and x/y#3. `#4` [#5](https://a.test) a#6 https://h.test/#7")
    expect(out).toContain('<a href="https://github.com/o/r/issues/12" data-ref="o/r#12">#12</a>')
    expect(out).toContain('<a href="https://github.com/x/y/issues/3" data-ref="x/y#3">x/y#3</a>')
    expect(out.match(/data-ref/g)).toHaveLength(2)
  })

  it("keeps a newline as a line break, as GitHub's comments do", async () => {
    expect(await pr("one\ntwo")).toContain("one<br>")
    expect(await html("one\ntwo")).not.toContain("<br>") // a file: markdown's own rule
  })

  it("no reference inside raw <code> or <kbd>", async () => {
    expect(await pr("<code>#12</code> and <kbd>#3</kbd>, but #4")).toMatch(
      /^(?!.*data-ref="o\/r#(12|3)").*data-ref="o\/r#4"/s,
    )
  })

  it("a heading named #12 isn't a reference", async () => {
    expect(await pr("# Title")).not.toContain("data-ref")
  })
})

describe("math", () => {
  it("renders GitHub's four forms", async () => {
    const out = await html(
      "inline $x^2$ and $`y_1`$\n\n$$\\frac{a}{b}$$\n\n```math\n\\sqrt{2}\n```\n",
    )
    expect(out.match(/class="katex"/g)?.length).toBe(4)
    expect(out).not.toContain("`y_1`")
    expect(out).not.toContain("language-math")
  })

  it("leaves prices and shell variables as text", async () => {
    for (const s of [
      "$5, or $10",
      "export PATH=$PATH:$HOME/bin",
      "set $HOME and $PATH",
      "$MINMUX_PROFILE, then $HOME",
    ]) {
      const r = await renderMarkdown(s)
      expect(r.math, s).toBe(false)
      expect(r.html, s).toContain(s.replace(/</g, "&lt;"))
    }
  })

  it("shows a bad formula as an error, and never \\href", async () => {
    const r = await renderMarkdown("$\\frac{$ and $\\href{javascript:alert(1)}{x}$")
    expect(r.html).toContain("katex-error")
    expect(r.html).not.toMatch(/href=/) // the TeX stays only as text (KaTeX's annotation)
    expect(r.html).not.toContain("<a ")
  })

  it("only loads KaTeX for text that may have math", () => {
    expect(mayHaveMath("cost $5 and $10")).toBe(true) // a pair on a line: tried, renders as text
    expect(mayHaveMath("cost $5")).toBe(false)
    expect(mayHaveMath("```math\nx\n```")).toBe(true)
    expect(mayHaveMath("$`x`$")).toBe(true)
    expect(mayHaveMath("plain text")).toBe(false)
  })
})

describe("safety", () => {
  const corpus = [
    "<script>alert(1)</script>",
    '<img src=x onerror="alert(1)">',
    "<iframe src=https://evil.test></iframe>",
    "<style>body{display:none}</style>",
    '<svg onload="alert(1)"><circle/></svg>',
    "<details open onclick=alert(1)><summary>x</summary></details>",
    '<a href="javascript:alert(1)">x</a>',
    "<b onmouseover=alert(1)>x</b>",
    "<div><b>x</b></div>",
    "[x](javascript:alert(1))",
    "[x](JaVaScRiPt:alert(1))",
    "[x](&#106;avascript:alert(1))",
    "[x](vbscript:msgbox)",
    "[x](file:///etc/passwd)",
    "[x](data:text/html,<script>alert(1)</script>)",
    "![x](data:image/png;base64,AAAA)",
    "<javascript:alert(1)>",
    "<p\nonclick=alert(1)>x</p>",
    "<<script>script>alert(1)<</script>/script>",
    "<math><mi xlink:href=javascript:alert(1)>x</mi></math>",
  ]
  it.each(corpus)("%s carries no live markup", async (src) => {
    const out = await html(src)
    expect(out).not.toMatch(/<(script|img|iframe|style|svg|div|math)\b/i)
    // the only links: ones we wrote (an image's), with a checked href and nothing else on them
    for (const a of out.match(/<a\b[^>]*>/gi) ?? [])
      expect(a).toMatch(/^<a class="md-img" href="([^"]*)" data-src="\1">$/)
    expect(out).not.toMatch(/<[a-z][^>]*\son[a-z]+\s*=/i) // no event handler on any tag
    expect(out).not.toMatch(/href="(javascript|vbscript|file|data):/i)
  })

  it("keeps the allowed tags, written by us", async () => {
    const out = await html(
      "<details open>\n<summary>More</summary>\n\nbody\n\n</details>\n\n<kbd>⌘</kbd>",
    )
    expect(out).toContain("<details open>")
    expect(out).toContain("<summary>More</summary>")
    expect(out).toContain("<kbd>⌘</kbd>")
  })

  it("turns a raw <img> (GitHub's drag-and-drop) into a link to the image", () => {
    expect(cleanHtml('<img width="800" alt="Shot" src="https://a.test/i.png?x=1&amp;y=2">')).toBe(
      '<a class="md-img" href="https://a.test/i.png?x=1&amp;y=2" data-src="https://a.test/i.png?x=1&amp;y=2" data-width="800">Shot</a>',
    )
    expect(cleanHtml("<img src='javascript:alert(1)'>")).toBe(
      "&lt;img src=&#39;javascript:alert(1)&#39;&gt;",
    )
    expect(cleanHtml("<img alt=x>")).toBe("&lt;img alt=x&gt;")
  })

  it("drops comments and keeps character references", () => {
    expect(cleanHtml("<!-- hidden -->a&nbsp;b &#169; <x>")).toBe("a&nbsp;b &#169; &lt;x&gt;")
    expect(cleanHtml("<!-- never closed <script>")).toBe("")
    expect(cleanHtml("<br/><BR >")).toBe("<br><br>")
    expect(cleanHtml('<b title="x">y</b>')).toBe("&lt;b title=&quot;x&quot;&gt;y</b>")
  })

  it("allows only http(s), mailto and relative links", () => {
    for (const ok of [
      "https://a.test",
      "http://a.test",
      "mailto:a@b.test",
      "docs/x.md",
      "#top",
      "../a.md#b",
    ])
      expect(safeLink(ok), ok).toBe(true)
    for (const bad of ["javascript:x", "file:///x", "data:x", "vbscript:x", "C:\\x", "ftp://x"])
      expect(safeLink(bad), bad).toBe(false)
  })

  it("slugs headings like GitHub", () => {
    expect(slugOf("Session survival")).toBe("session-survival")
    expect(slugOf("A.B (c)")).toBe("ab-c")
    expect(slugOf("snake_case-ok")).toBe("snake_case-ok")
  })
})
