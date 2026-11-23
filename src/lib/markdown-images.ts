// Images in a rendered markdown view (docs/design/MARKDOWN.md, step 4): each `.md-img` the
// renderer wrote (its `data-src`) becomes the image, as a data: URL (the page's policy refuses
// anything else). A relative one, in a file tab, is read through the fs worker as it scrolls into
// view. A web one is fetched by main: on a click by default (it can track whoever opens the
// document), or as it's shown (settings.remoteImages). Loaded ones are kept with their size, so a
// re-render (an agent rewriting the file) shows them at once without the layout moving.
import { ipc } from "./ipc"
import { linkTarget } from "./markdown-links"
import { imageMime } from "./file-tab"
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
const kept = new Map<string, Kept>() // insertion order = least → most recently used
let keptChars = 0

/** A kept image, now the most recently used (evicted last). */
function hit(key: string): Kept | undefined {
  const k = kept.get(key)
  if (k) {
    kept.delete(key)
    kept.set(key, k)
  }
  return k
}

function drop(key: string): void {
  const k = kept.get(key)
  if (!k) return
  kept.delete(key)
  keptChars -= k.dataUrl.length
}

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
  // Only what can be an image is read (a stray `![](notes.md)` isn't read whole for nothing).
  return t?.kind === "file" && (imageMime(t.path) || /\.svg$/i.test(t.path))
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

/** UTF-8 text as base64 (an SVG's). */
function base64(text: string): string {
  let bin = ""
  for (const b of new TextEncoder().encode(text)) bin += String.fromCharCode(b)
  return btoa(bin)
}
const inflight = new Map<string, Promise<Got>>() // one read or fetch per image at a time

/** An image's data: kept, or read / fetched (shared by every placeholder asking meanwhile). */
function get(key: string, path: string | undefined, src: string, ctx: ImageContext): Promise<Got> {
  const running = inflight.get(key)
  if (running) return running
  const had = hit(key)
  const p = (async (): Promise<Got> => {
    if (path) {
      const r = await ipc.readFile(path, ctx.wsl, had?.stamp)
      if (r.kind === "same" && had) return had
      // An SVG reads as text (a file tab shows its source); in an <img> its scripts never run.
      const svg = r.kind === "text" && /\.svg$/i.test(path)
      if (r.kind !== "image" && !svg) {
        drop(key) // gone or changed: a re-render mustn't flash the old picture
        return {
          error:
            r.kind === "error" ? r.message : r.kind === "too-large" ? "too large" : "not an image",
        }
      }
      const dataUrl =
        r.kind === "image"
          ? r.dataUrl
          : `data:image/svg+xml;base64,${base64(r.kind === "text" ? r.text : "")}`
      const k = { dataUrl, ...(await sized(dataUrl)), stamp: r.stamp }
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
  // A loaded or failed one stays as it is while it's checked again (no flicker every recheck).
  if (el.dataset.state !== "loaded" && el.dataset.state !== "failed") el.dataset.state = "loading"
  const got = await get(from.key, from.path, src, ctx)
  if ("error" in got) return failed(el, got.error)
  if (el.querySelector("img")?.getAttribute("src") !== got.dataUrl) show(el, got)
  else el.dataset.state = "loaded"
}

const placeholders = (root: HTMLElement, nodes?: Node[]): HTMLElement[] =>
  nodes
    ? nodes.flatMap((n) =>
        n instanceof HTMLElement
          ? [
              ...(n.matches(".md-img[data-src]") ? [n] : []),
              ...n.querySelectorAll<HTMLElement>(".md-img[data-src]"),
            ]
          : [],
      )
    : [...root.querySelectorAll<HTMLElement>(".md-img[data-src]")]

export const RECHECK_MS = 2000 // a view's file images are checked again (by stamp) this often

/** A view's images over its life: one observer, blocks added and removed as it's patched. */
export interface ImageLoader {
  hydrate(nodes?: Node[]): void // placeholders in these nodes (all of the view's when none)
  forget(nodes: Node[]): void // these left the view: no longer watched
  recheck(): void // file images kept across a re-render: changed or created since? (throttled)
  dispose(): void
}

// A Preview patches only the blocks that changed (lib/markdown-patch): what it adds is hydrated,
// what it removes is forgotten, and the file images it keeps are checked again now and then (an
// agent regenerating a diagram, or writing one that failed to load).
/** The image loader for a view whose content is `root` (`ctx` read when it's needed). */
export function imageLoader(root: HTMLElement, ctx: () => ImageContext): ImageLoader {
  let io: IntersectionObserver | null = null
  let checked = 0
  const watch = (el: HTMLElement) => {
    if (typeof IntersectionObserver === "undefined") return void load(el, ctx())
    if (!io) {
      // Relative to what scrolls the view (the margin must apply inside it, not to the window).
      let scroller: Element | null = root.parentElement
      while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
        scroller = scroller.parentElement
      }
      const obs = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue
            obs.unobserve(e.target)
            void load(e.target as HTMLElement, ctx())
          }
        },
        { root: scroller, rootMargin: "600px 0px" },
      )
      io = obs
    }
    io.observe(el)
  }
  return {
    hydrate(nodes) {
      const c = ctx()
      for (const el of placeholders(root, nodes)) {
        const src = el.dataset.src ?? ""
        const from = sourceOf(src, c)
        if (!from) continue
        altOf(el)
        const had = hit(from.key)
        if (had) {
          show(el, had) // at once: no layout shift on a re-render
          if (from.path) watch(el) // a file may have changed: checked by its stamp
        } else if (inflight.has(from.key)) {
          watch(el) // clicked, or loading, before this re-render: it joins that load
        } else if (isWeb(src) && c.remote === "click") {
          el.dataset.state = "click"
          el.title = `Click to load this image (${hostOf(src)})`
        } else watch(el)
      }
    },
    forget(nodes) {
      if (io) for (const el of placeholders(root, nodes)) io.unobserve(el)
    },
    recheck() {
      if (Date.now() - checked < RECHECK_MS) return
      checked = Date.now()
      const c = ctx()
      for (const el of placeholders(root)) {
        const state = el.dataset.state
        if ((state === "loaded" || state === "failed") && sourceOf(el.dataset.src ?? "", c)?.path) {
          void load(el, c) // by its stamp: "same" costs a stat in the fs worker
        }
      }
    },
    dispose() {
      io?.disconnect()
      io = null
    },
  }
}

/** Turn a view's image placeholders into images, per `ctx` (only within `nodes`, when given). */
export function hydrateImages(root: HTMLElement, ctx: ImageContext, nodes?: Node[]): () => void {
  const loader = imageLoader(root, () => ctx)
  loader.hydrate(nodes)
  return () => loader.dispose()
}

/** A click on a web image waiting for one loads it (true); one loading takes the click too. */
export function clickImage(target: Element, ctx: ImageContext): boolean {
  const el = target.closest<HTMLElement>(
    '.md-img[data-state="click"], .md-img[data-state="loading"]',
  )
  if (!el || !isWeb(el.dataset.src ?? "")) return false // a file image: its link opens it
  if (el.dataset.state === "click") void load(el, ctx) // a second click while loading: nothing
  return true
}
