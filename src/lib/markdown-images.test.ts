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
})
