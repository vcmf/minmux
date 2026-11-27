import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react"
import { FileView } from "./file-view"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore, testShell } from "../test/helpers"
import { wantKey } from "../lib/folder-git"

// Highlighting passes through, unless a test holds it back (to act on the plain lines first).
const gate = vi.hoisted(() => ({ hold: null as Promise<void> | null }))
vi.mock("../lib/highlight-client", async (load) => {
  const real = await load<typeof import("../lib/highlight-client")>()
  return {
    ...real,
    highlightLines: async (code: string, lang: string | null) => {
      if (gate.hold) await gate.hold
      return real.highlightLines(code, lang)
    },
  }
})

const st = () => useStore.getState()
const open = (path: string, line?: number) => {
  st().newTab(testShell)
  st().openFile(path, { line })
  const tab = st().tabs[0]!
  return { tabId: tab.id, entryId: tab.activeEntryId }
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("FileView", () => {
  it("shows the file's lines with their numbers, highlighted", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "const a = 1\nlet b = 2\n",
      truncated: false,
      size: 22,
    })
    const { tabId, entryId } = open("/w/x.ts")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull())
    expect(container.querySelectorAll(".file-view-line").length).toBeGreaterThan(0)
    expect(container.querySelector(".file-view-no")!.textContent).toBe("1")
    expect(ipc.readFile).toHaveBeenCalledWith("/w/x.ts", undefined, undefined) // no stamp: a first read
  })

  it("marks the line it was opened at", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "a\nb\nc\n",
      truncated: false,
      size: 6,
    })
    const { tabId, entryId } = open("/w/notes.txt", 2)
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".file-view-line.target")).not.toBeNull())
    expect(container.querySelector(".file-view-line.target")!.textContent).toBe("2b")
  })

  it("an image shows as a picture; a binary or a huge file offers to open it outside", async () => {
    vi.mocked(ipc.readFile).mockResolvedValueOnce({
      kind: "image",
      dataUrl: "data:image/png;base64,AA==",
      size: 1,
    })
    const a = open("/w/p.png")
    const v = render(<FileView entryId={a.entryId} tabId={a.tabId} />)
    expect(await screen.findByAltText("/w/p.png")).toBeInTheDocument()
    v.unmount()
    resetStore()
    vi.mocked(ipc.readFile).mockResolvedValueOnce({ kind: "too-large", size: 9_000_000 })
    const b = open("/w/big.log")
    render(<FileView entryId={b.entryId} tabId={b.tabId} />)
    fireEvent.click(await screen.findByText("Open it outside minmux"))
    expect(ipc.openFile).toHaveBeenCalledWith("", "/w/big.log", undefined)
  })

  it("re-reads when its folder's watcher says something changed (an agent writing it)", async () => {
    let onChanged: (dirs: string[], content?: string[]) => void = () => {}
    vi.mocked(ipc.onFsChanged).mockImplementation((cb) => {
      onChanged = (d, c = []) => cb(d, c)
      return () => {}
    })
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "v1",
      truncated: false,
      size: 2,
    })
    useStore.setState({ platform: "darwin" })
    const { tabId, entryId } = open("/w/live.txt")
    render(<FileView entryId={entryId} tabId={tabId} />)
    expect(await screen.findByText("v1")).toBeInTheDocument()
    await waitFor(() => expect(ipc.fsWatch).toHaveBeenLastCalledWith(["/w"], expect.any(Array)))
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "v2",
      truncated: false,
      size: 2,
    })
    onChanged(["/w"])
    expect(await screen.findByText("v2")).toBeInTheDocument()
  })

  it("Open its folder adds the file's folder as a tab of its pane", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({ kind: "text", text: "", truncated: false, size: 0 })
    const { tabId, entryId } = open("/w/rts/a.ts")
    render(<FileView entryId={entryId} tabId={tabId} />)
    fireEvent.click(screen.getByTitle("Open its folder"))
    const tab = st().tabs[0]!
    expect(st().objects[tab.activeEntryId]).toEqual({ kind: "folder", path: "/w/rts" })
  })

  it("an HTML file has Open in browser; other files don't", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({ kind: "text", text: "", truncated: false, size: 0 })
    useStore.setState({ platform: "darwin" })
    const page = open("/w/site/index.html")
    const { unmount } = render(<FileView entryId={page.entryId} tabId={page.tabId} />)
    fireEvent.click(screen.getByTitle("Open in browser"))
    expect(ipc.openInBrowser).toHaveBeenCalledWith("/w/site/index.html", undefined)
    expect(ipc.openPath).not.toHaveBeenCalled()
    unmount()
    st().openFile("/w/site/app.ts")
    const tab = st().tabs[0]!
    render(<FileView entryId={tab.activeEntryId} tabId={tab.id} />)
    expect(screen.getByTitle("Open in editor")).toBeInTheDocument()
    expect(screen.queryByTitle("Open in browser")).toBeNull()
  })

  it("a re-read that finds the file unchanged keeps it highlighted", async () => {
    let onChanged: (dirs: string[], content?: string[]) => void = () => {}
    vi.mocked(ipc.onFsChanged).mockImplementation((cb) => {
      onChanged = (d, c = []) => cb(d, c)
      return () => {}
    })
    useStore.setState({ platform: "darwin" })
    vi.mocked(ipc.readFile).mockResolvedValueOnce({
      kind: "text",
      text: "const v = 2",
      truncated: false,
      size: 11,
      stamp: { size: 11, mtimeMs: 1 },
    })
    vi.mocked(ipc.readFile).mockResolvedValue({ kind: "same" })
    const { tabId, entryId } = open("/w/s.ts")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull())
    onChanged(["/w"]) // something else in its folder changed
    await waitFor(() => expect(ipc.readFile).toHaveBeenCalledTimes(2))
    expect(vi.mocked(ipc.readFile).mock.calls[1]![2]).toEqual({ size: 11, mtimeMs: 1 })
    expect(container.querySelector(".hljs-keyword")).not.toBeNull()
  })

  it("a render that changes no line leaves the lines' DOM alone (a selection stays put)", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "const answer = 42\nreturn answer\n",
      truncated: false,
      size: 32,
    })
    const home = st().home
    useStore.setState({ home: "/w" })
    try {
      const { tabId, entryId } = open("/w/same.ts")
      const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
      await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull())
      expect(container.querySelector(".file-view-path")!.textContent).toBe("~/same.ts")
      const text = container.querySelector('[data-row="s1"] .file-view-code')!.lastChild!
      act(() => useStore.setState({ home: "/elsewhere" }))
      // It rendered again (its path shows another way), and its lines' nodes are the same.
      expect(container.querySelector(".file-view-path")!.textContent).toBe("/w/same.ts")
      expect(text.isConnected).toBe(true)
    } finally {
      useStore.setState({ home })
    }
  })

  it("keeps a selection when the highlighted lines replace the plain ones", async () => {
    let release = () => {}
    gate.hold = new Promise((r) => (release = r))
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "const answer = 42\nreturn answer\n",
      truncated: false,
      size: 32,
    })
    const { tabId, entryId } = open("/w/sel.ts")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    const codeOf = (n: number) =>
      container.querySelector(`[data-row="s${n}"] .file-view-code`) as HTMLElement | null
    await waitFor(() => expect(codeOf(2)).not.toBeNull())
    expect(container.querySelector(".hljs-keyword")).toBeNull() // still plain
    window.getSelection()!.setBaseAndExtent(codeOf(1)!.firstChild!, 6, codeOf(2)!.firstChild!, 6)
    const before = window.getSelection()!.toString()
    expect(before).toContain("answer = 42")
    gate.hold = null
    release()
    await waitFor(() => expect(container.querySelector(".hljs-keyword")).not.toBeNull())
    const sel = window.getSelection()!
    expect(codeOf(1)!.contains(sel.anchorNode)).toBe(true)
    expect(codeOf(2)!.contains(sel.focusNode)).toBe(true)
    expect(sel.toString()).toBe(before) // the same text, not widened to the rows' edges
    sel.removeAllRanges()
  })

  // The focused terminal's repo is /gr: its status says which files changed.
  const inRepo = (files: { path: string; status: string; add: number; del: number }[]) => {
    const roots = { [wantKey({ path: "/gr/src" })]: "/gr" }
    vi.mocked(ipc.gitRoots).mockResolvedValue({ "/gr/src": "/gr" }) // the poll's own lookup
    useStore.setState({
      folderRoots: roots,
      git: {
        isRepo: true,
        root: "/gr",
        branch: "main",
        ahead: 0,
        behind: 0,
        files: files.map((f) => ({ ...f, dir: "src" })),
        add: 0,
        del: 0,
      } as never,
    })
  }
  const diff = [
    { type: "hunk" as const, text: "@@ -1,2 +1,2 @@" },
    { type: "context" as const, text: "const a = 1", oldNo: 1, newNo: 1 },
    { type: "del" as const, text: "let b = 2", oldNo: 2 },
    { type: "add" as const, text: "let b = 3", newNo: 2 },
  ]

  it("a modified file shows change bars on Source, and its diff on Diff", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "const a = 1\nlet b = 3\n",
      truncated: false,
      size: 22,
    })
    vi.mocked(ipc.gitDiff).mockResolvedValue(diff)
    inRepo([{ path: "src/m.ts", status: "M", add: 1, del: 1 }])
    const { tabId, entryId } = open("/gr/src/m.ts")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".file-view-bar.mod")).not.toBeNull())
    expect(ipc.gitDiff).toHaveBeenCalledWith("/gr", "src/m.ts", undefined)
    expect(screen.getByText("Source")).toHaveClass("on")
    fireEvent.click(screen.getByText("Diff"))
    expect(st().objects[entryId]).toMatchObject({ view: "diff" })
    await waitFor(() => expect(container.querySelector(".diff-line.del")).not.toBeNull())
    const del = container.querySelector(".diff-line.del")!
    expect(del.querySelector(".diff-sign")!.textContent).toBe("−")
    expect(del.textContent).toContain("2") // its old line number
    expect(container.querySelector(".diff-line.add .diff-sign")!.textContent).toBe("+")
    fireEvent.click(screen.getByText("Source"))
    await waitFor(() => expect(container.querySelector(".diff-line")).toBeNull())
  })

  it("a deleted file shows its diff, with no toggle; a new one has neither", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({ kind: "error", message: "No such file" })
    vi.mocked(ipc.gitDiff).mockResolvedValue([diff[0]!, diff[2]!])
    inRepo([
      { path: "src/gone.ts", status: "D", add: 0, del: 1 },
      { path: "src/new.ts", status: "?", add: 0, del: 0 },
    ])
    const a = open("/gr/src/gone.ts")
    const v = render(<FileView entryId={a.entryId} tabId={a.tabId} />)
    await waitFor(() => expect(v.container.querySelector(".diff-line.del")).not.toBeNull())
    expect(screen.queryByText("Diff")).toBeNull()
    expect(screen.queryByText("No such file")).toBeNull()
    v.unmount()
    vi.mocked(ipc.gitDiff).mockClear()
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "x\n",
      truncated: false,
      size: 2,
    })
    const b = open("/gr/src/new.ts")
    const w = render(<FileView entryId={b.entryId} tabId={b.tabId} />)
    await waitFor(() => expect(w.container.querySelector(".file-view-line")).not.toBeNull())
    expect(ipc.gitDiff).not.toHaveBeenCalled()
    expect(screen.queryByText("Diff")).toBeNull()
  })

  it("a diff deep in a file sizes its gutter for the file's line numbers", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "x\n",
      truncated: false,
      size: 2,
    })
    vi.mocked(ipc.gitDiff).mockResolvedValue([
      { type: "hunk", text: "@@ -4200 +4200 @@" },
      { type: "del", text: "a", oldNo: 4200 },
      { type: "add", text: "b", newNo: 4200 },
    ])
    inRepo([{ path: "src/deep.ts", status: "M", add: 1, del: 1 }])
    st().newTab(testShell)
    st().openFile("/gr/src/deep.ts", { diff: true })
    const t = st().tabs[0]!
    const { container } = render(<FileView entryId={t.activeEntryId} tabId={t.id} />)
    await waitFor(() => expect(container.querySelector(".diff-line.del")).not.toBeNull())
    expect((container.querySelector(".file-view-no") as HTMLElement).style.width).toBe("4ch")
  })

  it("an image's change has no Diff: the picture shows", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "image",
      dataUrl: "data:image/png;base64,AA==",
      size: 1,
    })
    vi.mocked(ipc.gitDiff).mockResolvedValue([
      { type: "hunk", text: "Binary files a/p.png and b/p.png differ" },
    ])
    inRepo([{ path: "src/p.png", status: "M", add: 0, del: 0 }])
    st().newTab(testShell)
    st().openFile("/gr/src/p.png", { diff: true })
    const t = st().tabs[0]!
    const { container } = render(<FileView entryId={t.activeEntryId} tabId={t.id} />)
    expect(await screen.findByAltText("/gr/src/p.png")).toBeInTheDocument()
    await waitFor(() => expect(ipc.gitDiff).toHaveBeenCalled())
    expect(container.querySelector(".diff-line")).toBeNull()
    expect(screen.queryByText("Diff")).toBeNull()
  })

  it("a file git deleted but still on disk (git rm --cached) shows its Source", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "kept\n",
      truncated: false,
      size: 5,
    })
    vi.mocked(ipc.gitDiff).mockResolvedValue([diff[0]!, diff[2]!])
    inRepo([{ path: "src/kept.ts", status: "D", add: 0, del: 1 }])
    const a = open("/gr/src/kept.ts")
    const { container } = render(<FileView entryId={a.entryId} tabId={a.tabId} />)
    await waitFor(() => expect(ipc.gitDiff).toHaveBeenCalled())
    await waitFor(() => expect(container.textContent).toContain("kept"))
    expect(container.querySelector(".diff-line")).toBeNull()
  })

  it("a renamed file reads no diff (it'd be all new)", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "r\n",
      truncated: false,
      size: 2,
    })
    inRepo([{ path: "src/r.ts", status: "R", add: 1, del: 0 }])
    const a = open("/gr/src/r.ts")
    const { container } = render(<FileView entryId={a.entryId} tabId={a.tabId} />)
    await waitFor(() => expect(container.querySelector(".file-view-line")).not.toBeNull())
    expect(ipc.gitDiff).not.toHaveBeenCalled()
    expect(screen.queryByText("Diff")).toBeNull()
  })
})

describe("FileView: markdown", () => {
  const md = (text: string) =>
    vi
      .mocked(ipc.readFile)
      .mockResolvedValue({ kind: "text", text, truncated: false, size: text.length })

  it("opens on its Preview, rendered; Source shows the text", async () => {
    md("# Plan\n\n- [x] step one\n\ninline $x^2$\n")
    const { tabId, entryId } = open("/w/PLAN.md")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".md-view h1")).not.toBeNull())
    expect(container.querySelector(".md-view h1")!.textContent).toBe("Plan")
    expect(container.querySelector('.md-view input[type="checkbox"]')).not.toBeNull()
    expect(container.querySelector(".md-view .katex")).not.toBeNull()
    expect(screen.getByText("Preview").className).toContain("on")
    fireEvent.click(screen.getByText("Source"))
    await waitFor(() => expect(container.querySelector(".file-view-line")).not.toBeNull())
    expect(container.querySelector(".md-view")).toBeNull()
    expect(st().objects[entryId]).toMatchObject({ view: "source" })
  })

  it("opens web links outside and relative ones as a tab in the same pane", async () => {
    md("[site](https://example.com) [gotchas](GOTCHAS.md#fonts) [bad](javascript:alert(1))\n")
    const { tabId, entryId } = open("/w/docs/README.md")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".md-view a")).not.toBeNull())
    fireEvent.click(screen.getByText("site"))
    expect(ipc.openExternal).toHaveBeenCalledWith("https://example.com")
    vi.mocked(ipc.openExternal).mockClear()
    const middle = new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 })
    screen.getByText("site").dispatchEvent(middle)
    expect(middle.defaultPrevented).toBe(true) // never Chromium's new window
    expect(ipc.openExternal).toHaveBeenCalledWith("https://example.com")
    expect(container.querySelector('.md-view a[href^="javascript"]')).toBeNull()
    fireEvent.click(screen.getByText("gotchas"))
    const tab = st().tabs[0]!
    const opened = st().objects[tab.activeEntryId]
    expect(opened).toMatchObject({ kind: "file", path: "/w/docs/GOTCHAS.md", anchor: "fonts" })
  })

  it("shows raw HTML outside the allowlist as text", async () => {
    md('<img src=x onerror="alert(1)">\n\n<kbd>⌘K</kbd>\n')
    const { tabId, entryId } = open("/w/x.md")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".md-view kbd")).not.toBeNull())
    expect(container.querySelector(".md-view img")).toBeNull()
    expect(container.querySelector(".md-view a.md-img")!.getAttribute("onerror")).toBeNull()
  })

  it("a markdown file too big to render shows its source, saying so", async () => {
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text: "# big\n",
      truncated: false,
      size: 2 * 1024 * 1024,
    })
    const { tabId, entryId } = open("/w/huge.md")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    expect(await screen.findByText(/Too large to preview/)).toBeInTheDocument()
    expect(container.querySelector(".md-view")).toBeNull()
    expect(screen.queryByText("Preview")).toBeNull()
  })
})

describe("FileView: markdown places", () => {
  // jsdom has no layout: a block sits at 100px per source line, 100px tall.
  const line = (el: HTMLElement) =>
    Number(el.dataset?.line ?? el.closest?.("[data-line]")?.getAttribute("data-line") ?? 0)
  const saved = ["offsetTop", "offsetHeight"].map(
    (k) => [k, Object.getOwnPropertyDescriptor(HTMLElement.prototype, k)] as const,
  )
  beforeEach(() => {
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true,
      get(this: HTMLElement) {
        return line(this) * 100
      },
    })
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get: () => 100,
    })
  })
  afterEach(() => {
    for (const [k, d] of saved) if (d) Object.defineProperty(HTMLElement.prototype, k, d)
  })
  const doc = Array.from({ length: 20 }, (_, i) => `## Part ${i}\n`).join("\n") // part i on line 2i+1
  const md = (text: string) =>
    vi
      .mocked(ipc.readFile)
      .mockResolvedValue({ kind: "text", text, truncated: false, size: text.length })
  const scroller = (c: HTMLElement) => c.querySelector<HTMLElement>(".md-scroll")!

  it("goes to a heading in the view, and to one in this same file by its name", async () => {
    md(`[go](#part-5) [same](PLAN.md#part-9) [sub](sub/)\n\n${doc}`)
    const { tabId, entryId } = open("/w/PLAN.md")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector('[data-anchor="part-5"]')).not.toBeNull())
    fireEvent.click(screen.getByText("go"))
    expect(scroller(container).scrollTop).toBe(
      line(container.querySelector('[data-anchor="part-5"]')!) * 100 - 8,
    )
    fireEvent.click(screen.getByText("same"))
    expect(scroller(container).scrollTop).toBe(
      line(container.querySelector('[data-anchor="part-9"]')!) * 100 - 8,
    )
    fireEvent.click(screen.getByText("sub")) // a folder link: a folder tab in this pane
    expect(st().objects[st().tabs[0]!.activeEntryId]).toEqual({ kind: "folder", path: "/w/sub" })
  })

  it("opens at a line on the block holding it", async () => {
    md(doc)
    const { tabId, entryId } = open("/w/PLAN.md", 12)
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(scroller(container).scrollTop).toBeGreaterThan(0))
    expect(scroller(container).scrollTop).toBe(11 * 100) // part 5, on line 11 (clientHeight 0)
  })

  it("keeps the block in view by its text when lines are added above", async () => {
    let onChanged: (dirs: string[]) => void = () => {}
    vi.mocked(ipc.onFsChanged).mockImplementation((cb) => {
      onChanged = (d) => cb(d, [])
      return () => {}
    })
    useStore.setState({ platform: "darwin" })
    md(doc)
    const { tabId, entryId } = open("/w/PLAN.md")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector('[data-anchor="part-7"]')).not.toBeNull())
    scroller(container).scrollTop = 15 * 100 + 30 // into part 7 (line 15)
    md(`# New\n\nadded\n\n${doc}`) // four lines above
    onChanged(["/w"])
    await waitFor(() => expect(container.querySelector('[data-anchor="new"]')).not.toBeNull())
    await waitFor(() => expect(scroller(container).scrollTop).toBe(19 * 100 + 30)) // part 7, now line 19
  })

  it("switching from Source shows the block at Source's top line", async () => {
    md(doc)
    const { tabId, entryId } = open("/w/PLAN.md")
    st().setFileView(entryId, "source")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".file-view-line")).not.toBeNull())
    container.querySelector<HTMLElement>(".file-view-lines")!.scrollTop = 20 * 18 // line 21
    fireEvent.click(screen.getByText("Preview"))
    await waitFor(() => expect(scroller(container).scrollTop).toBe(21 * 100)) // part 10, line 21
    fireEvent.click(screen.getByText("Source")) // and back: the Preview's top block's line
    await waitFor(() => expect(container.querySelector(".file-view-lines")).not.toBeNull())
    expect(container.querySelector<HTMLElement>(".file-view-lines")!.scrollTop).toBe(20 * 18)
  })

  it("a web image loads on a click, through main", async () => {
    md("![shot](https://img.test/a.png)\n")
    vi.mocked(ipc.fetchImage).mockResolvedValue({ ok: true, dataUrl: "data:image/png;base64,AQ==" })
    const { tabId, entryId } = open("/w/IMG.md")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() =>
      expect(container.querySelector('.md-img[data-state="click"]')).not.toBeNull(),
    )
    fireEvent.click(container.querySelector(".md-img")!)
    expect(ipc.openExternal).not.toHaveBeenCalled()
    await waitFor(() => expect(container.querySelector(".md-img img")).not.toBeNull())
    expect(ipc.fetchImage).toHaveBeenCalledWith("https://img.test/a.png")
  })
})

describe("FileView: Edit", () => {
  const read = (text: string, extra: object = {}) =>
    vi.mocked(ipc.readFile).mockResolvedValue({
      kind: "text",
      text,
      truncated: false,
      size: text.length,
      stamp: { size: text.length, mtimeMs: 1 },
      hash: "h0",
      editable: true,
      ...extra,
    })
  // jsdom has no layout: CodeMirror measures text ranges, which it lacks.
  const proto = Range.prototype as unknown as Record<string, unknown>
  proto.getClientRects ??= () => []
  proto.getBoundingClientRect ??= () => new DOMRect()
  afterEach(async () => {
    const { edits } = await import("../lib/edit-store")
    for (const id of edits.unsaved()) edits.stop(id)
  })

  it("Edit opens the editor on the file (a peek becomes kept); Done goes back", async () => {
    read("const a = 1\n")
    st().newTab(testShell)
    st().openFile("/w/e.ts", { peek: true })
    const tab = st().tabs[0]!
    const entryId = tab.activeEntryId
    render(<FileView entryId={entryId} tabId={tab.id} />)
    fireEvent.click(await screen.findByTitle("Edit"))
    expect((st().objects[entryId] as { peek?: boolean }).peek).toBeUndefined()
    await screen.findByText("Done", {}, { timeout: 5000 })
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.textContent).toContain("const a"),
    )
    expect(document.querySelector(".cm-content")?.getAttribute("data-entry")).toBe(entryId)
    fireEvent.click(screen.getByText("Done"))
    await waitFor(() => expect(screen.queryByText("Done")).toBeNull())
    expect(screen.getByTitle("Edit")).toBeTruthy()
  })

  it("no Edit for text that isn't valid UTF-8", async () => {
    read("caf�\n", { editable: false })
    const { tabId, entryId } = open("/w/latin1.txt")
    const { container } = render(<FileView entryId={entryId} tabId={tabId} />)
    await waitFor(() => expect(container.querySelector(".file-view-line")).not.toBeNull())
    expect(screen.queryByTitle("Edit")).toBeNull()
  })
})
