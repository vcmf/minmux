import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { files } from "../lib/file-store"
import { escapeHtml } from "../lib/file-preview"
import { renderedNow, renderMarkdownText, loadMathStyle } from "../lib/markdown-client"
import { linkTarget } from "../lib/markdown-links"
import { samePath } from "../lib/agent-dirs"
import { findPane } from "../lib/pane-tree"
import type { WslContext } from "../lib/wsl"
import { blockAt, topBlock } from "../lib/markdown-scroll"

const BIG_HTML = 200 * 1024 // past this, off-screen blocks skip layout (content-visibility)

// Rendered in a worker (lib/markdown-client); the HTML goes in with one innerHTML write, out of
// React. A re-render (an agent rewriting the file) keeps the block at the top where it was.
/** A markdown file tab's Preview. */
export function MarkdownView({
  entryId,
  tabId,
  path,
  text,
  dir,
  root,
  wsl,
  line,
  anchor,
  goKey,
  startLine,
  scrollRef,
}: {
  entryId: string
  tabId: string
  path: string
  text: string
  dir: string
  root?: string
  wsl?: WslContext
  line?: number
  anchor?: string
  goKey: string
  startLine: number | null // switched from Source: show the block at this line
  scrollRef: RefObject<HTMLDivElement | null>
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const shown = useRef<string | null>(null) // the text the body shows
  const placed = useRef(false) // the first HTML is in and the view placed

  const toAnchor = (name: string): boolean => {
    const el = scrollRef.current
    const want = name.toLowerCase()
    const target = [
      ...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-anchor]") ?? []),
    ].find((h) => h.dataset.anchor === want)
    if (!el || !target) return false
    el.scrollTop = target.offsetTop - 8
    return true
  }

  // Where the view goes once HTML is in: a line or heading it was opened at (once per goKey), the
  // line it was switched at, or where it was scrolled before.
  const place = () => {
    const el = scrollRef.current
    const body = bodyRef.current
    if (!el || !body) return
    if ((line || anchor) && files.wentOf(entryId) !== goKey) {
      files.setWent(entryId, goKey)
      if (anchor && toAnchor(anchor)) return
      const b = line ? blockAt(body, line) : null
      if (b) return void (el.scrollTop = Math.max(0, b.offsetTop - el.clientHeight / 3))
    }
    if (startLine !== null) {
      const b = blockAt(body, startLine)
      el.scrollTop = b ? b.offsetTop : 0
    } else el.scrollTop = files.scrollOf(entryId, "preview")
  }

  const write = (html: string, math: boolean) => {
    const el = scrollRef.current
    const body = bodyRef.current
    if (!el || !body) return
    const keep = placed.current && el.scrollTop > 0 ? topBlock(el, body) : null
    if (math) void loadMathStyle()
    body.classList.toggle("big", html.length > BIG_HTML)
    body.innerHTML = html
    if (!placed.current) {
      placed.current = true
      return place()
    }
    if (keep) {
      const b = blockAt(body, keep.line)
      if (b) el.scrollTop = b.offsetTop + keep.off
    }
  }

  // The text's HTML: at once when it was rendered before (a tab shown again), else when the worker
  // answers. A newer text wins over an older one still rendering.
  useLayoutEffect(() => {
    if (shown.current === text) return
    const now = renderedNow(text)
    if (now) {
      shown.current = text
      return write(now.html, now.math)
    }
    let live = true
    void renderMarkdownText(text).then((r) => {
      if (!live) return
      shown.current = text
      // Failed to render: the source as text, so the tab still shows the file.
      if (r) write(r.html, r.math)
      else write(`<pre>${escapeHtml(text)}</pre>`, false)
    })
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rendered per text
  }, [text])

  // Asked to go again (the same link clicked after scrolling away): its goKey changed.
  useEffect(() => {
    if (placed.current) place()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per goKey
  }, [goKey])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => placed.current && files.setScroll(entryId, el.scrollTop, "preview")
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [entryId, scrollRef])

  // Links: the web through the OS, a relative path as a tab in this pane, `#x` within the view.
  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest("a")
    if (!a || !bodyRef.current?.contains(a)) return
    e.preventDefault()
    const t = linkTarget(a.getAttribute("href") ?? "", dir, root)
    if (!t) return
    if (t.kind === "external") return ipc.openExternal(t.url)
    if (t.kind === "anchor") return void toAnchor(t.anchor)
    if (t.kind === "file" && samePath(t.path, path)) return void (t.anchor && toAnchor(t.anchor))
    const s = useStore.getState()
    const tab = s.tabs.find((x) => x.id === tabId)
    const pane = tab && findPane(tab.root, entryId)
    const where = { tabId, ...(pane ? { paneId: pane.id } : {}), ...(wsl ? { wsl } : {}) }
    if (t.kind === "folder") s.openFolder(t.path, where)
    else s.openFile(t.path, { ...where, ...(t.anchor ? { anchor: t.anchor } : {}) })
  }

  return (
    <div className="md-scroll" ref={scrollRef} data-entry={entryId} tabIndex={-1}>
      {/* lib/markdown output: allowlisted HTML, checked links, KaTeX (trust off) */}
      <div className="md-view" ref={bodyRef} onClick={onClick} />
    </div>
  )
}
