// Images in a rendered markdown view (docs/design/MARKDOWN.md, step 4): each `.md-img` the
// renderer wrote (its `data-src`) becomes the image, as a data: URL (the page's policy refuses
// anything else). A relative one, in a file tab, is read through the fs worker as it scrolls into
// view. A web one is fetched by main: on a click by default (it can track whoever opens the
// document), or as it's shown (settings.remoteImages). Loaded ones are kept with their size, so a
// re-render (an agent rewriting the file) shows them at once without the layout moving.
import { ipc } from "./ipc"
import { linkTarget } from "./markdown-links"
import type { FileStamp } from "./file-tab"
import type { WslContext } from "./wsl"

/** Where a view's images come from: a file's folder (none in a PR body) and the web rule. */
export interface ImageContext {
  dir?: string
  root?: string
  wsl?: WslContext
  remote: "click" | "always"
}

interface Kept {
  dataUrl: string
  w: number
  h: number
  stamp?: FileStamp
}
const KEPT_CHARS = 32 * 1024 * 1024
const kept = new Map<string, Kept>() // insertion order = least → most recent
let keptChars = 0

function keep(key: string, k: Kept): void {
  const old = kept.get(key)
  if (old) keptChars -= old.dataUrl.length
  kept.delete(key)
  kept.set(key, k)
  keptChars += k.dataUrl.length
  while (kept.size > 1 && keptChars > KEPT_CHARS) {
    const [first, v] = kept.entries().next().value!
    kept.delete(first)
    keptChars -= v.dataUrl.length
  }
}

const isWeb = (src: string) => /^https?:\/\//i.test(src)
const hostOf = (src: string) => {
  try {
    return new URL(src).host
  } catch {
    return src
  }
}

/** What an image's source is: a web URL, a file (from a file tab), or nothing we load. */
function sourceOf(src: string, ctx: ImageContext): { key: string; path?: string } | null {
  if (isWeb(src)) return { key: `web:${src}` }
  if (ctx.dir === undefined) return null // a PR body: its repo's files aren't here
  const t = linkTarget(src, ctx.dir, ctx.root)
  return t?.kind === "file"
    ? { key: `file:${ctx.wsl?.distro ?? ""}:${t.path}`, path: t.path }
    : null
}

// The placeholder's alt text is kept on it (`data-alt`): a re-render shows the image at once,
// and a failure later puts the text back.
const altOf = (el: HTMLElement) => (el.dataset.alt ??= el.textContent ?? "")

function show(el: HTMLElement, k: Kept): void {
  const img = document.createElement("img")
  img.alt = altOf(el)
  // A width the document asked for (GitHub's <img width>: a retina screenshot at half size);
  // else its own. Either way the height follows, so the space is reserved before it decodes.
  const w = Number(el.dataset.width) || k.w
  if (w && k.w && k.h) {
    img.width = w
    img.height = Math.round((w * k.h) / k.w)
  }
  img.src = k.dataUrl
  el.replaceChildren(img)
  el.dataset.state = "loaded"
  el.removeAttribute("title")
}

function failed(el: HTMLElement, why: string): void {
  el.replaceChildren(altOf(el)) // its text again, if an image was shown
  el.dataset.state = "failed"
  el.title = `Couldn't load this image: ${why}`
}

/** Its size, once decoded (kept, so it's reserved next time). */
async function sized(dataUrl: string): Promise<{ w: number; h: number }> {
  const img = new Image()
  img.src = dataUrl
  try {
    await img.decode()
  } catch {
    /* sizes stay 0: shown without reserving */
  }
  return { w: img.naturalWidth, h: img.naturalHeight }
}

type Got = Kept | { error: string }
const inflight = new Map<string, Promise<Got>>() // one read or fetch per image at a time

/** An image's data: kept, or read / fetched (shared by every placeholder asking meanwhile). */
function get(key: string, path: string | undefined, src: string, ctx: ImageContext): Promise<Got> {
  const running = inflight.get(key)
  if (running) return running
  const had = kept.get(key)
  const p = (async (): Promise<Got> => {
    if (path) {
      const r = await ipc.readFile(path, ctx.wsl, had?.stamp)
      if (r.kind === "same" && had) return had
      if (r.kind !== "image") {
        return {
          error:
            r.kind === "error" ? r.message : r.kind === "too-large" ? "too large" : "not an image",
        }
      }
      const k = { dataUrl: r.dataUrl, ...(await sized(r.dataUrl)), stamp: r.stamp }
      keep(key, k)
      return k
    }
    if (had) return had // a web image: once loaded, kept
    const r = await ipc.fetchImage(src)
    if (!r.ok) return { error: r.error }
    const k = { dataUrl: r.dataUrl, ...(await sized(r.dataUrl)) }
    keep(key, k)
    return k
  })()
  inflight.set(key, p)
  void p.finally(() => inflight.delete(key))
  return p
}

/** Load one image into its placeholder (or say why not). */
async function load(el: HTMLElement, ctx: ImageContext): Promise<void> {
  const src = el.dataset.src ?? ""
  const from = sourceOf(src, ctx)
  if (!from) return
  altOf(el)
  if (el.dataset.state !== "loaded") el.dataset.state = "loading" // a loaded one stays as it is
  const got = await get(from.key, from.path, src, ctx)
  if ("error" in got) return failed(el, got.error)
  if (el.querySelector("img")?.getAttribute("src") !== got.dataUrl) show(el, got)
  else el.dataset.state = "loaded"
}

// One observer per write: images load as they come near the view. Returns its disposer (the
// next write replaces every placeholder).
/** Turn a view's image placeholders into images, per `ctx`. */
export function hydrateImages(root: HTMLElement, ctx: ImageContext): () => void {
  const lazy: HTMLElement[] = []
  for (const el of root.querySelectorAll<HTMLElement>(".md-img[data-src]")) {
    const src = el.dataset.src ?? ""
    const from = sourceOf(src, ctx)
    if (!from) continue
    altOf(el)
    const had = kept.get(from.key)
    if (had) {
      show(el, had) // at once: no layout shift on a re-render
      if (from.path) lazy.push(el) // a file may have changed: checked by its stamp
    } else if (inflight.has(from.key)) {
      lazy.push(el) // clicked, or loading, before this re-render: it joins that load
    } else if (isWeb(src) && ctx.remote === "click") {
      el.dataset.state = "click"
      el.title = `Click to load this image (${hostOf(src)})`
    } else lazy.push(el)
  }
  if (!lazy.length) return () => {}
  if (typeof IntersectionObserver === "undefined") {
    for (const el of lazy) void load(el, ctx)
    return () => {}
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        io.unobserve(e.target)
        void load(e.target as HTMLElement, ctx)
      }
    },
    { rootMargin: "600px 0px" },
  )
  for (const el of lazy) io.observe(el)
  return () => io.disconnect()
}

/** A click on a web image waiting for one loads it (true); one loading takes the click too. */
export function clickImage(target: Element, ctx: ImageContext): boolean {
  const el = target.closest<HTMLElement>(
    '.md-img[data-state="click"], .md-img[data-state="loading"]',
  )
  if (!el) return false
  if (el.dataset.state === "click") void load(el, ctx) // a second click while loading: nothing
  return true
}
