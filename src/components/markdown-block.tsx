import { useLayoutEffect, useRef } from "react"
import { escapeHtml } from "../lib/file-preview"
import { clickImage, hydrateImages, type ImageContext } from "../lib/markdown-images"
import {
  htmlOf,
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
  images,
  onLink,
  onRendered,
}: {
  text: string
  repo?: string
  className?: string
  images?: ImageContext // none: images stay links
  onLink: (href: string, a: HTMLAnchorElement) => void
  onRendered?: (el: HTMLElement) => void // after each write (decorate links, say)
}) {
  const ref = useRef<HTMLDivElement>(null)
  const after = useRef(onRendered)
  after.current = onRendered
  const imageCtx = useRef(images)
  imageCtx.current = images
  // A new decorator (the titles it adds changed) runs on what's shown now.
  useLayoutEffect(() => {
    if (ref.current) onRendered?.(ref.current)
  }, [onRendered])

  const unhydrate = useRef(() => {})
  // The Web images setting changed: what's shown now follows it.
  const remote = images?.remote
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !imageCtx.current) return
    unhydrate.current()
    unhydrate.current = hydrateImages(el, imageCtx.current)
  }, [remote])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const put = (html: string) => {
      unhydrate.current()
      el.innerHTML = html
      if (imageCtx.current) unhydrate.current = hydrateImages(el, imageCtx.current)
      after.current?.(el)
    }
    const now = renderedNow(text, repo)
    if (now && (!now.math || mathStyleReady())) {
      put(htmlOf(now))
      return () => unhydrate.current()
    }
    put(`<p class="md-pending">${escapeHtml(text)}</p>`)
    let live = true
    void (async () => {
      const r = now ?? (await renderMarkdownText(text, repo))
      if (r?.math) await loadMathStyle()
      // Couldn't render (the worker failed): the text, plainly, as a final state.
      if (live) put(r ? htmlOf(r) : `<p class="md-plain">${escapeHtml(text)}</p>`)
    })()
    return () => {
      live = false
      unhydrate.current()
    }
  }, [text, repo])

  const follow = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest("a")
    if (!a || !ref.current?.contains(a)) return
    e.preventDefault()
    if (e.type === "mousedown") return
    if (
      e.type === "click" &&
      imageCtx.current &&
      clickImage(e.target as Element, imageCtx.current)
    ) {
      return
    }
    onLink(a.getAttribute("href") ?? "", a)
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
