import { describe, it, expect, vi, beforeEach } from "vitest"
import { ipc } from "./ipc"

const view = (html: string) => {
  const el = document.createElement("div")
  el.innerHTML = html
  return el
}
const img = (src: string, alt = "pic") =>
  `<a class="md-img" href="${src}" data-src="${src}">${alt}</a>`
const settle = () => new Promise((r) => setTimeout(r, 0))

async function fresh() {
  vi.resetModules() // its cache starts empty
  return import("./markdown-images")
}

beforeEach(() => vi.clearAllMocks())

describe("hydrateImages", () => {
  it("reads a relative image from the file's folder, then shows it at once next time", async () => {
    const { hydrateImages } = await fresh()
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "image",
      dataUrl: "data:image/png;base64,AA==",
      size: 1,
      stamp: { size: 1, mtimeMs: 1 },
    })
    const ctx = { dir: "/w/docs", remote: "click" as const }
    const a = view(img("shot.png"))
    hydrateImages(a, ctx)
    await settle()
    await settle()
    expect(ipc.readFile).toHaveBeenCalledWith("/w/docs/shot.png", undefined, undefined)
    expect(a.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,AA==")
    expect(a.querySelector("img")!.alt).toBe("pic")
    // a re-render: shown before any read, then checked by its stamp
    vi.mocked(ipc.readFile).mockResolvedValue({ kind: "same" })
    const b = view(img("shot.png"))
    hydrateImages(b, ctx)
    expect(b.querySelector("img")).not.toBeNull()
    await settle()
    expect(ipc.readFile).toHaveBeenLastCalledWith("/w/docs/shot.png", undefined, {
      size: 1,
      mtimeMs: 1,
    })
  })

  it("waits for a click on a web image by default; loads it as shown when asked to", async () => {
    const { hydrateImages, clickImage } = await fresh()
    vi.mocked(ipc.fetchImage).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,AQ==" })
    const a = view(img("https://img.test/x.png"))
    hydrateImages(a, { remote: "click" })
    const ph = a.querySelector<HTMLElement>(".md-img")!
    expect(ph.dataset.state).toBe("click")
    expect(ipc.fetchImage).not.toHaveBeenCalled()
    expect(clickImage(ph, { remote: "click" })).toBe(true)
    await settle()
    await settle()
    expect(ipc.fetchImage).toHaveBeenCalledWith("https://img.test/x.png")
    expect(a.querySelector("img")).not.toBeNull()
    expect(clickImage(a.querySelector("img")!, { remote: "click" })).toBe(false) // loaded: a link again

    const { hydrateImages: h2 } = await fresh()
    const b = view(img("https://img.test/y.png"))
    h2(b, { remote: "always" })
    await settle()
    await settle()
    expect(ipc.fetchImage).toHaveBeenLastCalledWith("https://img.test/y.png")
  })

  it("says why an image couldn't load", async () => {
    const { hydrateImages } = await fresh()
    vi.mocked(ipc.fetchImage).mockResolvedValue({ ok: false, error: "HTTP 404" })
    const a = view(img("https://img.test/gone.png"))
    hydrateImages(a, { remote: "always" })
    await settle()
    const ph = a.querySelector<HTMLElement>(".md-img")!
    expect(ph.dataset.state).toBe("failed")
    expect(ph.title).toContain("HTTP 404")
  })

  it("leaves a PR body's relative image as a link (its repo's files aren't here)", async () => {
    const { hydrateImages } = await fresh()
    const a = view(img("docs/shot.png"))
    hydrateImages(a, { remote: "always" })
    await settle()
    expect(ipc.readFile).not.toHaveBeenCalled()
    expect(a.querySelector<HTMLElement>(".md-img")!.dataset.state).toBeUndefined()
  })

  it("a re-render keeps the alt text, undimmed; a file gone since puts the text back", async () => {
    const { hydrateImages } = await fresh()
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "image",
      dataUrl: "data:image/png;base64,AA==",
      size: 1,
      stamp: { size: 1, mtimeMs: 1 },
    })
    const ctx = { dir: "/w", remote: "click" as const }
    hydrateImages(view(img("a.png", "Architecture")), ctx)
    await settle()
    await settle()
    vi.mocked(ipc.readFile).mockResolvedValue({ kind: "same" })
    const b = view(img("a.png", "Architecture"))
    hydrateImages(b, ctx)
    const ph = b.querySelector<HTMLElement>(".md-img")!
    expect(ph.dataset.state).toBe("loaded") // not "loading" while it's checked
    await settle()
    expect(b.querySelector("img")!.alt).toBe("Architecture")
    vi.mocked(ipc.readFile).mockResolvedValue({ kind: "error", message: "This file is gone" })
    const c = view(img("a.png", "Architecture"))
    hydrateImages(c, ctx)
    await settle()
    await settle()
    expect(c.querySelector("img")).toBeNull()
    expect(c.textContent).toBe("Architecture")
    expect(c.querySelector<HTMLElement>(".md-img")!.title).toContain("gone")
  })

  it("one fetch per image: a second click while loading, or a re-render, joins it", async () => {
    const { hydrateImages, clickImage } = await fresh()
    let answer: (v: { ok: true; dataUrl: string }) => void = () => {}
    vi.mocked(ipc.fetchImage).mockImplementation(() => new Promise((r) => (answer = r)))
    const ctx = { remote: "click" as const }
    const a = view(img("https://img.test/x.png"))
    hydrateImages(a, ctx)
    const ph = a.querySelector<HTMLElement>(".md-img")!
    expect(clickImage(ph, ctx)).toBe(true)
    expect(clickImage(ph, ctx)).toBe(true) // taken: no browser tab for the second click
    const b = view(img("https://img.test/x.png")) // re-rendered meanwhile
    hydrateImages(b, ctx)
    answer({ ok: true, dataUrl: "data:image/png;base64,AQ==" })
    await settle()
    await settle()
    await settle()
    expect(ipc.fetchImage).toHaveBeenCalledTimes(1)
    expect(b.querySelector("img")).not.toBeNull()
  })

  it("shows a screenshot at the width its <img> asked for", async () => {
    const { hydrateImages } = await fresh()
    const { cleanHtml } = await import("./markdown-html")
    vi.mocked(ipc.fetchImage).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,AQ==" })
    const a = view(cleanHtml('<img width="400" src="https://img.test/s.png">'))
    expect(a.querySelector<HTMLElement>(".md-img")!.dataset.width).toBe("400")
    hydrateImages(a, { remote: "always" })
    await settle()
    await settle()
    expect(a.querySelector("img")).not.toBeNull()
  })

  it("shows a relative SVG; never reads a path that can't be an image", async () => {
    const { hydrateImages } = await fresh()
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "<svg xmlns='http://www.w3.org/2000/svg'/>",
      truncated: false,
      size: 40,
    })
    const a = view(img("logo.svg") + img("notes.md"))
    hydrateImages(a, { dir: "/w", remote: "click" })
    await settle()
    await settle()
    expect(ipc.readFile).toHaveBeenCalledTimes(1)
    expect(a.querySelector("img")!.getAttribute("src")).toMatch(/^data:image\/svg\+xml;base64,/)
  })

  it("a file image gone since isn't shown again on the next re-render", async () => {
    const { hydrateImages } = await fresh()
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "image",
      dataUrl: "data:image/png;base64,AA==",
      size: 1,
      stamp: { size: 1, mtimeMs: 1 },
    })
    const ctx = { dir: "/w", remote: "click" as const }
    hydrateImages(view(img("a.png")), ctx)
    await settle()
    await settle()
    vi.mocked(ipc.readFile).mockResolvedValue({ kind: "error", message: "This file is gone" })
    hydrateImages(view(img("a.png")), ctx)
    await settle()
    await settle()
    const next = view(img("a.png"))
    hydrateImages(next, ctx)
    expect(next.querySelector("img")).toBeNull() // no flash of the old picture
  })

  it("a click on a file image that's loading follows its link", async () => {
    const { hydrateImages, clickImage } = await fresh()
    vi.mocked(ipc.readFile).mockImplementation(() => new Promise(() => {})) // a dead mount
    const a = view(img("a.png"))
    hydrateImages(a, { dir: "/w", remote: "click" })
    const ph = a.querySelector<HTMLElement>(".md-img")!
    expect(ph.dataset.state).toBe("loading")
    expect(clickImage(ph, { dir: "/w", remote: "click" })).toBe(false)
  })

  it("loads images as they come near the view, relative to what scrolls it", async () => {
    const seen: { root: Element | null; observed: Element[] } = { root: null, observed: [] }
    class FakeIO {
      constructor(
        private cb: (e: { isIntersecting: boolean; target: Element }[]) => void,
        opts: { root: Element | null },
      ) {
        seen.root = opts.root
      }
      observe(el: Element) {
        seen.observed.push(el)
        this.cb([{ isIntersecting: false, target: el }]) // not yet
        this.cb([{ isIntersecting: true, target: el }])
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("IntersectionObserver", FakeIO)
    try {
      const { hydrateImages } = await fresh()
      vi.mocked(ipc.fetchImage).mockResolvedValue({
        ok: true,
        dataUrl: "data:image/png;base64,AQ==",
      })
      const scroller = document.createElement("div")
      scroller.style.overflowY = "auto"
      const body = view(img("https://img.test/z.png"))
      scroller.appendChild(body)
      document.body.appendChild(scroller)
      const dispose = hydrateImages(body, { remote: "always" })
      expect(seen.root).toBe(scroller)
      expect(seen.observed).toHaveLength(1)
      await settle()
      await settle()
      expect(body.querySelector("img")).not.toBeNull()
      dispose()
      scroller.remove()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("a loader forgets removed blocks and checks kept file images again, throttled", async () => {
    const { imageLoader, RECHECK_MS } = await fresh()
    const observed = new Set<Element>()
    class FakeIO {
      observe(el: Element) {
        observed.add(el)
      }
      unobserve(el: Element) {
        observed.delete(el)
      }
      disconnect() {
        observed.clear()
      }
    }
    vi.stubGlobal("IntersectionObserver", FakeIO)
    const nowSpy = vi.spyOn(Date, "now")
    try {
      const body = view(img("a.png") + img("b.png"))
      const loader = imageLoader(body, () => ({ dir: "/w", remote: "click" }))
      loader.hydrate()
      expect(observed.size).toBe(2)
      loader.forget([body.children[1]!]) // its block left the view
      expect(observed.size).toBe(1)

      // a kept image, loaded; its file changes: the recheck shows the new one
      vi.mocked(ipc.readFile).mockResolvedValue({
        kind: "image",
        dataUrl: "data:image/png;base64,Ag==",
        size: 1,
        stamp: { size: 1, mtimeMs: 2 },
      })
      const a = body.children[0] as HTMLElement
      a.dataset.state = "failed" // it hadn't loaded (the file didn't exist yet)
      nowSpy.mockReturnValue(10_000)
      loader.recheck()
      await settle()
      await settle()
      expect(a.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,Ag==")
      vi.mocked(ipc.readFile).mockClear()
      nowSpy.mockReturnValue(10_000 + RECHECK_MS - 1)
      loader.recheck() // too soon
      expect(ipc.readFile).not.toHaveBeenCalled()
      nowSpy.mockReturnValue(10_000 + RECHECK_MS)
      loader.recheck()
      expect(ipc.readFile).toHaveBeenCalledTimes(1)
      loader.dispose()
      expect(observed.size).toBe(0)
    } finally {
      nowSpy.mockRestore()
      vi.unstubAllGlobals()
    }
  })
})
