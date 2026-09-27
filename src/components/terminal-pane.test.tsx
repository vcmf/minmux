import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, createEvent } from "@testing-library/react"
import { TerminalPane } from "./terminal-pane"
import { useStore } from "../store"
import { allSessionIds } from "../lib/pane-tree"
import { resetStore, testHost, testShell } from "../test/helpers"
import { hostShellOption } from "../lib/ssh-hosts-ui"
import { TerminalManager } from "../terminal/terminal-manager"
import type { PaneLeaf } from "../types"

vi.mock("../terminal/terminal-manager", () => ({
  TerminalManager: {
    attach: vi.fn(),
    detach: vi.fn(),
    ensureRunning: vi.fn(),
    followSize: vi.fn(),
    fit: vi.fn(),
    focus: vi.fn(),
    dispose: vi.fn(),
    connect: vi.fn(),
  },
}))

const st = () => useStore.getState()

const mountPane = () => {
  st().newTab(testShell)
  const tab = st().tabs[0]!
  const id = allSessionIds(tab.root)[0]!
  return { tabId: tab.id, id }
}

/** The (single) pane of the first tab, as currently stored. */
const leaf = () => st().tabs[0]!.root as PaneLeaf

/** Render the first tab's pane, re-rendering on store changes like PaneLayout would. */
const renderPane = (tabId: string) => {
  const view = render(<TerminalPane pane={leaf()} tabId={tabId} />)
  const rerender = () => view.rerender(<TerminalPane pane={leaf()} tabId={tabId} />)
  return { ...view, rerender }
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("TerminalPane", () => {
  it("renders the pane header (cwd-basename title + shell-type badge)", () => {
    const { tabId, id } = mountPane()
    st().setSessionCwd(id, "/w/proj")
    renderPane(tabId)
    expect(screen.getByText("proj")).toBeInTheDocument() // title = cwd basename
    expect(screen.getByText("sh")).toBeInTheDocument() // badge = shell type
  })

  it("the split-right button splits this pane", () => {
    const { tabId } = mountPane()
    renderPane(tabId)
    fireEvent.mouseDown(screen.getByTitle("Split right"))
    expect(allSessionIds(st().tabs[0]!.root)).toHaveLength(2)
  })

  it("the split-down button splits vertically", () => {
    const { tabId } = mountPane()
    renderPane(tabId)
    fireEvent.mouseDown(screen.getByTitle("Split down"))
    expect(st().tabs[0]!.root.type).toBe("split")
  })

  it("the close button closes a single-terminal pane (last pane → tab removed)", () => {
    const { tabId } = mountPane()
    renderPane(tabId)
    fireEvent.mouseDown(screen.getByTitle("Close pane"))
    expect(st().tabs).toHaveLength(0)
  })

  it("a single terminal shows no per-surface close button", () => {
    const { tabId } = mountPane()
    renderPane(tabId)
    expect(screen.queryByTitle("Close terminal")).not.toBeInTheDocument()
  })
})

describe("TerminalPane — surfaces", () => {
  it("the new-terminal button adds a surface tab to this pane", () => {
    const { tabId } = mountPane()
    const view = renderPane(tabId)
    fireEvent.mouseDown(screen.getByTitle(/New terminal/))
    expect(leaf().sessionIds).toHaveLength(2)
    view.rerender()
    expect(screen.getAllByRole("tab")).toHaveLength(2)
    expect(screen.getAllByTitle("Close terminal")).toHaveLength(2)
  })

  it("clicking a surface tab makes it visible + focused", () => {
    const { tabId, id: first } = mountPane()
    st().newSurface()
    const view = renderPane(tabId)
    fireEvent.mouseDown(screen.getAllByRole("tab")[0]!)
    expect(leaf().activeSessionId).toBe(first)
    expect(st().tabs[0]!.activeSessionId).toBe(first)
    view.rerender()
    expect(screen.getAllByRole("tab")[0]).toHaveAttribute("aria-selected", "true")
  })

  it("closing a surface tab closes just that terminal", () => {
    const { tabId, id: first } = mountPane()
    st().newSurface()
    renderPane(tabId)
    fireEvent.mouseDown(screen.getAllByTitle("Close terminal")[1]!)
    expect(leaf().sessionIds).toEqual([first])
  })

  it("closing a multi-terminal pane asks for confirmation instead of closing", () => {
    const { tabId } = mountPane()
    st().newSurface()
    renderPane(tabId)
    fireEvent.mouseDown(screen.getByTitle("Close pane"))
    expect(st().closePaneConfirm).toMatchObject({ count: 2 })
    expect(leaf().sessionIds).toHaveLength(2)
  })

  it("switching the visible surface re-attaches: detach old, attach new", async () => {
    const { TerminalManager } = await import("../terminal/terminal-manager")
    const { tabId, id: first } = mountPane()
    st().newSurface()
    const second = leaf().activeSessionId
    const view = renderPane(tabId)
    expect(TerminalManager.attach).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: second }),
      expect.any(HTMLElement),
    )
    st().setActivePane(tabId, first)
    view.rerender()
    expect(TerminalManager.detach).toHaveBeenCalledWith(second, expect.any(HTMLElement))
    expect(TerminalManager.attach).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: first }),
      expect.any(HTMLElement),
    )
  })
})

describe("TerminalPane — hidden surfaces keep running", () => {
  it("starts every hidden surface off-screen, sized like the visible one", async () => {
    const { TerminalManager } = await import("../terminal/terminal-manager")
    const { tabId, id: first } = mountPane()
    st().newSurface()
    const visible = leaf().activeSessionId
    renderPane(tabId)
    expect(TerminalManager.ensureRunning).toHaveBeenCalledWith(
      expect.objectContaining({ id: first }),
      visible,
    )
    expect(TerminalManager.ensureRunning).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: visible }),
      expect.anything(),
    )
  })

  it("right-clicking a surface tab opens no clipboard menu (it'd target another surface)", () => {
    const { tabId } = mountPane()
    st().newSurface()
    renderPane(tabId)
    fireEvent.contextMenu(screen.getAllByRole("tab")[0]!)
    expect(screen.queryByText("Paste")).not.toBeInTheDocument()
  })

  it("only a left-click on a surface's close button closes it", () => {
    const { tabId } = mountPane()
    st().newSurface()
    renderPane(tabId)
    const close = screen.getAllByTitle("Close terminal")[0]!
    fireEvent.mouseDown(close, { button: 2 })
    fireEvent.mouseDown(close, { button: 1 })
    expect(leaf().sessionIds).toHaveLength(2)
    fireEvent.mouseDown(close, { button: 0 })
    expect(leaf().sessionIds).toHaveLength(1)
  })

  it("only a left-click on the new-terminal button adds a surface", () => {
    const { tabId } = mountPane()
    renderPane(tabId)
    fireEvent.mouseDown(screen.getByTitle(/New terminal/), { button: 2 })
    expect(leaf().sessionIds).toHaveLength(1)
    fireEvent.mouseDown(screen.getByTitle(/New terminal/), { button: 0 })
    expect(leaf().sessionIds).toHaveLength(2)
  })
})

describe("TerminalPane — drag & drop", () => {
  const dt = () => ({ setData: vi.fn(), effectAllowed: "", dropEffect: "" })
  const rect = { left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200 }
  // jsdom has no DragEvent, so coordinates passed to fireEvent are dropped — set them.
  const drag = (type: "dragOver" | "drop", el: HTMLElement, x: number, y = 0) => {
    const ev = createEvent[type](el, { dataTransfer: dt() })
    Object.defineProperty(ev, "clientX", { value: x })
    Object.defineProperty(ev, "clientY", { value: y })
    fireEvent(el, ev)
  }

  /** Two surfaces in one pane, the first being dragged; returns the rendered view. */
  const startDrag = () => {
    const { tabId, id: first } = mountPane()
    st().newSurface()
    const view = renderPane(tabId)
    // A real drag starts with a mousedown, which selects the dragged tab.
    fireEvent.mouseDown(screen.getAllByRole("tab")[0]!, { button: 0 })
    fireEvent.dragStart(screen.getAllByRole("tab")[0]!, { dataTransfer: dt() })
    view.rerender()
    return { tabId, first, view }
  }

  it("dragging a surface tab turns the drop overlay on (and dragend turns it off)", () => {
    const { tabId, first, view } = startDrag()
    expect(st().dragging).toEqual({ tabId, sessionId: first })
    expect(view.container.querySelector(".drop-overlay")).toBeInTheDocument()
    fireEvent.dragEnd(screen.getAllByRole("tab")[0]!)
    view.rerender()
    expect(st().dragging).toBeNull()
    expect(view.container.querySelector(".drop-overlay")).not.toBeInTheDocument()
  })

  it("dropping on the pane's right edge splits the surface off into a new pane", () => {
    const { first, view } = startDrag()
    const overlay = view.container.querySelector(".drop-overlay") as HTMLElement
    overlay.getBoundingClientRect = () => rect as DOMRect
    drag("dragOver", overlay, 390, 100)
    expect(view.container.querySelector(".drop-hint.right")).toBeInTheDocument()
    drag("drop", overlay, 390, 100)
    const root = st().tabs[0]!.root
    expect(root.type).toBe("split")
    if (root.type !== "split") return
    expect(root.children[1]).toMatchObject({ sessionIds: [first] })
    expect(st().tabs[0]!.activeSessionId).toBe(first)
    expect(st().dragging).toBeNull()
  })

  it("no hint (and no move) where the drop would change nothing", () => {
    const { tabId } = mountPane() // a single surface
    const view = renderPane(tabId)
    fireEvent.dragStart(screen.getAllByRole("tab")[0]!, { dataTransfer: dt() })
    view.rerender()
    const overlay = view.container.querySelector(".drop-overlay") as HTMLElement
    overlay.getBoundingClientRect = () => rect as DOMRect
    drag("dragOver", overlay, 390, 100) // own edge
    expect(view.container.querySelector(".drop-hint")).not.toBeInTheDocument()
    const before = st().tabs[0]!.root
    drag("drop", overlay, 390, 100)
    expect(st().tabs[0]!.root).toBe(before)
  })

  it("dropping on the tab strip reorders the surfaces", () => {
    const { first, view } = startDrag()
    const strip = view.container.querySelector(".surface-tabs") as HTMLElement
    const tabs = screen.getAllByRole("tab")
    tabs.forEach((t, i) => {
      t.getBoundingClientRect = () => ({ left: i * 100, width: 100 }) as DOMRect
    })
    drag("dragOver", strip, 190) // past the 2nd tab's midpoint → slot 2 (the end)
    view.rerender()
    expect(tabs[1]).toHaveClass("insert-after")
    drag("drop", strip, 190)
    expect(leaf().sessionIds[1]).toBe(first)
    expect(leaf().activeSessionId).toBe(first)
  })

  it("dropping before the first tab of its own slot shows no marker", () => {
    const { view } = startDrag()
    const strip = view.container.querySelector(".surface-tabs") as HTMLElement
    const tabs = screen.getAllByRole("tab")
    tabs.forEach((t, i) => {
      t.getBoundingClientRect = () => ({ left: i * 100, width: 100 }) as DOMRect
    })
    drag("dragOver", strip, 10) // slot 0 = where the dragged (first) tab already is
    view.rerender()
    expect(tabs[0]).not.toHaveClass("insert-before")
  })
})

describe("TerminalPane — Claude session colour", () => {
  it("a /color paints the pane's top border and the tab icon", () => {
    const { tabId, id } = mountPane()
    st().setAgentMeta(id, { color: "orange" })
    const { container } = renderPane(tabId)
    const pane = container.querySelector(".terminal-pane") as HTMLElement
    expect(pane).toHaveClass("tinted")
    expect(pane.style.getPropertyValue("--pane-accent")).toMatch(/^#/)
    expect(container.querySelector(".surface-tab svg")).toHaveAttribute(
      "fill",
      pane.style.getPropertyValue("--pane-accent"),
    )
  })

  it("no Claude colour → no tint", () => {
    const { tabId } = mountPane()
    const { container } = renderPane(tabId)
    expect(container.querySelector(".terminal-pane")).not.toHaveClass("tinted")
  })

  it("in a split, an unfocused coloured pane that needs input shows the amber rail", () => {
    const { tabId, id } = mountPane()
    st().setAgentMeta(id, { color: "blue" })
    st().splitActive("row", testShell) // focus moves to the new pane
    st().signalSession(id, { type: "attention", detail: "approve?" })
    const root = st().tabs[0]!.root
    if (root.type !== "split") throw new Error("expected split")
    const left = root.children[0] as PaneLeaf
    const { container } = render(<TerminalPane pane={left} tabId={tabId} />)
    const pane = container.querySelector(".terminal-pane")!
    expect(pane).toHaveClass("waiting")
    expect(pane).not.toHaveClass("tinted")
  })
})

describe("TerminalPane — ssh Connect button", () => {
  const mountRemote = () => {
    st().newTab(hostShellOption(testHost("web")))
    const tab = st().tabs[0]!
    return { tabId: tab.id, id: tab.activeSessionId }
  }

  it("hidden while connected", () => {
    const { tabId } = mountRemote()
    renderPane(tabId)
    expect(screen.queryByText("Connect")).not.toBeInTheDocument()
    expect(screen.queryByText("Reconnect")).not.toBeInTheDocument()
  })

  it("names what it does per phase, and connects + focuses the pane", () => {
    const { tabId, id } = mountRemote()
    st().setRemotePhase(id, "waiting")
    const view = renderPane(tabId)
    fireEvent.click(screen.getByText("Connect"))
    expect(TerminalManager.connect).toHaveBeenCalledWith(id)
    expect(TerminalManager.focus).toHaveBeenCalledWith(id)
    st().setRemotePhase(id, "closed")
    view.rerender()
    expect(screen.getByText("Reconnect")).toBeInTheDocument()
    st().setRemotePhase(id, "failed")
    view.rerender()
    expect(screen.getByText("Retry")).toBeInTheDocument()
  })

  it("never shows for a local pane", () => {
    const { tabId } = mountPane()
    renderPane(tabId)
    expect(screen.queryByTitle(/Connect|Reconnect/)).not.toBeInTheDocument()
  })
})
