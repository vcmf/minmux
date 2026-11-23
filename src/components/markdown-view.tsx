import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { files } from "../lib/file-store"
import { escapeHtml } from "../lib/file-preview"
import {
  loadMathStyle,
  mathStyleReady,
  renderedNow,
  renderMarkdownText,
} from "../lib/markdown-client"
import { linkTarget } from "../lib/markdown-links"
import { samePath } from "../lib/agent-dirs"
import { findPane } from "../lib/pane-tree"
import type { WslContext } from "../lib/wsl"
import { blockAt, blockOf, topBlock } from "../lib/markdown-scroll"

const BIG_HTML = 50 * 1024 // past this, off-screen blocks skip layout (content-visibility)

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
  // Read when HTML lands (maybe renders later): the target asked for most recently.
  const target = useRef({ line, anchor, goKey })
  target.current = { line, anchor, goKey }

  const toAnchor = (name: string): boolean => {
    const el = scrollRef.current
    const want = name.toLowerCase()
    const heading = [
      ...(bodyRef.current?.querySelectorAll<HTMLElement>("[data-anchor]") ?? []),
    ].find((h) => h.dataset.anchor === want)
    if (!el || !heading) return false
    el.scrollTop = heading.offsetTop - 8
    return true
  }

  // Where the view goes: a line or heading it was opened at (once per goKey); else, placing the
  // first HTML, the line it was switched at or where it was scrolled before.
  const place = (first: boolean) => {
    const el = scrollRef.current
    const body = bodyRef.current
    if (!el || !body) return
    const { line, anchor, goKey } = target.current
    if ((line || anchor) && files.wentOf(entryId) !== goKey) {
      files.setWent(entryId, goKey)
      if (anchor && toAnchor(anchor)) return
      const b = line ? blockAt(body, line) : null
      if (b) return void (el.scrollTop = Math.max(0, b.offsetTop - el.clientHeight / 3))
    }
    if (!first) return
    if (startLine !== null) {
      const b = blockAt(body, startLine)
      el.scrollTop = b ? b.offsetTop : 0
    } else el.scrollTop = files.scrollOf(entryId, "preview")
  }

  const write = (html: string) => {
    const el = scrollRef.current
    const body = bodyRef.current
    if (!el || !body) return
    const keep = placed.current && el.scrollTop > 0 ? topBlock(el, body) : null
    body.classList.toggle("big", html.length > BIG_HTML)
    body.innerHTML = html
    if (!placed.current) {
      placed.current = true
      return place(true)
    }
    if (keep) {
      const b = blockOf(body, keep)
      if (!b) return
      // Off-screen blocks have estimated heights (content-visibility) until laid out: the ones
      // near the view get their real ones over the next frames, so the block is pinned again.
      const pin = (n: number) => {
        if (!b.isConnected) return
        el.scrollTop = b.offsetTop + keep.off
        if (n > 0) requestAnimationFrame(() => pin(n - 1))
      }
      pin(2)
    }
  }

  // The text's HTML: at once when it was rendered before (a tab shown again), else when the worker
  // answers, with KaTeX's stylesheet in first (unstyled math has other heights: the view would be
  // placed wrong). A newer text wins over an older one still rendering.
  useLayoutEffect(() => {
    if (shown.current === text) return
    const now = renderedNow(text)
    if (now && (!now.math || mathStyleReady())) {
      shown.current = text
      return write(now.html)
    }
    let live = true
    void (async () => {
      const r = now ?? (await renderMarkdownText(text))
      if (r?.math) await loadMathStyle()
      if (!live) return
      shown.current = text
      // Failed to render: the source as text, so the tab still shows the file.
      write(r ? r.html : `<pre>${escapeHtml(text)}</pre>`)
    })()
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rendered per text
  }, [text])

  // Asked to go again (the same link clicked after scrolling away): its goKey changed.
  useEffect(() => {
    if (placed.current) place(false)
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
  // A middle-click too: Chromium's own handling would open a window (main refuses it anyway).
  const follow = (e: React.MouseEvent) => {
    const a = (e.target as Element).closest("a")
    if (!a || !bodyRef.current?.contains(a)) return
    e.preventDefault()
    if (e.type === "mousedown") return // a middle press: no autoscroll; its auxclick follows
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
  const middle = (e: React.MouseEvent) => e.button === 1 && follow(e)

  return (
    <div className="md-scroll" ref={scrollRef} data-entry={entryId} tabIndex={-1}>
      {/* lib/markdown output: allowlisted HTML, checked links, KaTeX (trust off) */}
      <div
        className="md-view"
        ref={bodyRef}
        onClick={follow}
        onAuxClick={middle}
        onMouseDown={middle}
      />
    </div>
  )
}
