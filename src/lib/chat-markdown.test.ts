import { describe, expect, it } from "vitest"
import { chatMarkdown } from "./chat-markdown"

describe("chatMarkdown", () => {
  it("renders an agent's markdown: emphasis, code, lists, tables", () => {
    const html = chatMarkdown(
      "**Done.** Ran `make test`:\n\n- 412 passed\n- 0 failed\n\n```ts\nconst a = 1\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    )
    expect(html).toContain("<strong>Done.</strong>")
    expect(html).toContain("<code>make test</code>")
    expect(html).toContain("<li>412 passed</li>")
    expect(html).toContain('<pre><code class="language-ts">const a = 1')
    expect(html).toContain('<div class="md-table"><table>')
  })

  it("never renders raw HTML, images, or links that aren't web or mail", () => {
    const html = chatMarkdown(
      "<img src=x onerror=alert(1)> <script>x()</script>\n\n![pic](https://e.com/a.png) [run](javascript:alert(1)) [file](src/a.ts)",
    )
    expect(html).not.toContain("<img")
    expect(html).not.toContain("<script")
    expect(html).toContain("&lt;script&gt;")
    expect(html).not.toContain('href="javascript')
    expect(html).not.toContain('href="src/a.ts"')
  })

  it("web links (written or bare) open outside the page", () => {
    const html = chatMarkdown("See [the PR](https://github.com/a/b/pull/1) and https://example.com")
    expect(html).toContain(
      '<a href="https://github.com/a/b/pull/1" target="_blank" rel="noopener noreferrer">the PR</a>',
    )
    expect(html).toContain('<a href="https://example.com" target="_blank"')
  })
})
