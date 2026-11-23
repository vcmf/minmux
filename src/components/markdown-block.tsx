import { useLayoutEffect, useRef } from "react"
import { escapeHtml } from "../lib/file-preview"
import {
  loadMathStyle,
  mathStyleReady,
  renderedNow,
  renderMarkdownText,
} from "../lib/markdown-client"

// Shown as plain text until the worker answers (a comment already rendered shows at once), then
// as lib/markdown's HTML: one innerHTML write, out of React. Links go to `onLink`, never followed
// by Chromium (a middle-click included).
/** A short markdown text (a PR's body or comment) rendered in place. */
export function MarkdownBlock({
  text,
  repo,
  className,
  onLink,
  onRendered,
}: {
  text: string
  repo?: string
  className?: string
  onLink: (href: string, a: HTMLAnchorElement) => void
  onRendered?: (el: HTMLElement) => void // after each write (decorate links, say)
}) {
  const ref = useRef<HTMLDivElement>(null)
  const after = useRef(onRendered)
  after.current = onRendered

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const put = (html: string) => {
      el.innerHTML = html
      after.current?.(el)
    }
    const now = renderedNow(text, repo)
    if (now && (!now.math || mathStyleReady())) return put(now.html)
    put(`<p class="md-pending">${escapeHtml(text)}</p>`)
    let live = true
    void (async () => {
      const r = now ?? (await renderMarkdownText(text, repo))
      if (r?.math) await loadMathStyle()
      if (live && r) put(r.html)
    })()
    return () => {
      live = false
    }
  }, [text, repo])

  const follow = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest("a")
    if (!a || !ref.current?.contains(a)) return
    e.preventDefault()
    if (e.type !== "mousedown") onLink(a.getAttribute("href") ?? "", a)
  }
  const middle = (e: React.MouseEvent) => e.button === 1 && follow(e)
  return (
    // lib/markdown output: allowlisted HTML, checked links, KaTeX (trust off)
    <div
      ref={ref}
      className={className}
      onClick={follow}
      onAuxClick={middle}
      onMouseDown={middle}
    />
  )
}
