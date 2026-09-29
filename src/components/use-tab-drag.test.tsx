import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent, createEvent, act } from "@testing-library/react"
import { TopBar } from "./top-bar"
import { Sidebar } from "./sidebar"
import { useStore } from "../store"
import { resetStore, testShell } from "../test/helpers"
import { TAB_DRAG_TYPE } from "../lib/tab-order"

vi.mock("../terminal/terminal-manager", () => ({
  TerminalManager: { attach: vi.fn(), fit: vi.fn(), focus: vi.fn(), dispose: vi.fn() },
}))

const st = () => useStore.getState()
const frame = () => new Promise((r) => setTimeout(r, 40)) // let requestAnimationFrame run

/** A dataTransfer carrying a session (tab) drag, or a terminal drag. */
const dt = (payload: Record<string, string>) => ({
  types: Object.keys(payload),
  getData: (t: string) => payload[t] ?? "",
  setData: vi.fn(),
  effectAllowed: "",
  dropEffect: "",
})
// jsdom has no DragEvent: build the event, then set the pointer position on it.
const drag = (
  type: "dragOver" | "drop",
  el: Element,
  pos: { x?: number; y?: number },
  data: object,
) => {
  const ev = createEvent[type](el, { dataTransfer: data })
  Object.defineProperty(ev, "clientX", { value: pos.x ?? 0 })
  Object.defineProperty(ev, "clientY", { value: pos.y ?? 0 })
  fireEvent(el, ev)
}
const order = () => st().tabs.map((t) => t.id)

/** Three sessions; each top-bar tab / sidebar group gets a 100px box along its axis. */
const setup = (view: "top" | "side") => {
  st().newTab(testShell)
  st().newTab(testShell)
  st().newTab(testShell)
  const utils = render(view === "top" ? <TopBar /> : <Sidebar />)
  const list = utils.container.querySelector(view === "top" ? ".tab-list" : ".sidebar-sessions")!
  ;(list as HTMLElement).scrollBy = vi.fn() as never // jsdom has no scrollBy
  list.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 300, height: 300, right: 300, bottom: 300 }) as DOMRect
  const spans = [...list.querySelectorAll<HTMLElement>("[data-tab-drag]")]
  spans.forEach((el, i) => {
    el.getBoundingClientRect = () =>
      (view === "top"
        ? { left: i * 100, width: 100, top: 0, height: 30 }
        : { top: i * 100, height: 100, left: 0, width: 300 }) as DOMRect
  })
  const handles =
    view === "top" ? spans : spans.map((g) => g.querySelector<HTMLElement>(".tree-row")!)
  return { ...utils, list, handles }
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("reordering sessions by drag — top bar", () => {
  it("drops the dragged tab where the insertion line is; both views share the order", async () => {
    const { list, handles } = setup("top")
    const [a, b, c] = order()
    const data = dt({ [TAB_DRAG_TYPE]: a! })
    fireEvent.dragStart(handles[0]!, { dataTransfer: data })
    await act(frame) // dims a frame later
    expect(handles[0]!.className).toContain("dragging")
    drag("dragOver", list, { x: 280 }, data) // past c's midpoint → at the end
    const line = list.querySelector<HTMLElement>(".tab-drop-line")
    expect(line?.style.left).toBe("299px")
    drag("drop", list, { x: 280 }, data)
    expect(order()).toEqual([b, c, a])
    expect(list.querySelector(".tab-drop-line")).toBeNull()
  })

  it("no line where a drop wouldn't move anything (next to the dragged tab itself)", () => {
    const { list, handles } = setup("top")
    const data = dt({ [TAB_DRAG_TYPE]: order()[1]! })
    fireEvent.dragStart(handles[1]!, { dataTransfer: data })
    drag("dragOver", list, { x: 120 }, data) // b's left half → before b: no-op
    expect(list.querySelector(".tab-drop-line")).toBeNull()
    drag("dragOver", list, { x: 20 }, data) // before a: a real move
    expect(list.querySelector(".tab-drop-line")).not.toBeNull()
  })

  it("ignores a terminal (surface) drag passing over the tab list", () => {
    const { list } = setup("top")
    const before = order()
    const data = dt({ "application/x-minmux-surface": "s1" })
    drag("dragOver", list, { x: 280 }, data)
    expect(list.querySelector(".tab-drop-line")).toBeNull()
    drag("drop", list, { x: 280 }, data)
    expect(order()).toEqual(before)
  })

  it("drag end clears the drag and gives keyboard focus back to the terminal", async () => {
    const { TerminalManager } = await import("../terminal/terminal-manager")
    const { list, handles } = setup("top")
    const data = dt({ [TAB_DRAG_TYPE]: order()[0]! })
    fireEvent.dragStart(handles[0]!, { dataTransfer: data })
    drag("dragOver", list, { x: 280 }, data)
    fireEvent.dragEnd(handles[0]!)
    await act(frame)
    expect(list.querySelector(".tab-drop-line")).toBeNull()
    expect(TerminalManager.focus).toHaveBeenCalledWith(
      st().tabs.find((t) => t.id === st().activeTabId)!.activeSessionId,
    )
  })

  it("a lost dragend (the element unmounted) is caught at window level", async () => {
    const { list, handles } = setup("top")
    const data = dt({ [TAB_DRAG_TYPE]: order()[0]! })
    fireEvent.dragStart(handles[0]!, { dataTransfer: data })
    await act(frame)
    drag("dragOver", list, { x: 280 }, data)
    act(() => {
      window.dispatchEvent(new Event("dragend"))
    })
    expect(list.querySelector(".tab-drop-line")).toBeNull()
  })

  it("dragging near an edge scrolls the list", () => {
    const { list, handles } = setup("top")
    const scrollBy = vi.fn()
    ;(list as HTMLElement).scrollBy = scrollBy as never
    const data = dt({ [TAB_DRAG_TYPE]: order()[0]! })
    fireEvent.dragStart(handles[0]!, { dataTransfer: data })
    drag("dragOver", list, { x: 295 }, data) // within the right edge band
    expect(scrollBy).toHaveBeenCalledWith({ left: 14 })
  })
})

describe("reordering sessions by drag — sidebar", () => {
  it("dragging a session's header row moves it; the line is horizontal", () => {
    const { list, handles } = setup("side")
    const [a, b, c] = order()
    const data = dt({ [TAB_DRAG_TYPE]: c! })
    fireEvent.dragStart(handles[2]!, { dataTransfer: data })
    drag("dragOver", list, { y: 10 }, data) // above a
    expect(list.querySelector(".tab-drop-line.y")).not.toBeNull()
    drag("drop", list, { y: 10 }, data)
    expect(order()).toEqual([c, a, b])
  })

  it("leaving the list hides the line", () => {
    const { list, handles } = setup("side")
    const data = dt({ [TAB_DRAG_TYPE]: order()[2]! })
    fireEvent.dragStart(handles[2]!, { dataTransfer: data })
    drag("dragOver", list, { y: 10 }, data)
    fireEvent.dragLeave(list, { relatedTarget: document.body })
    expect(list.querySelector(".tab-drop-line")).toBeNull()
  })

  it("the collapse caret can't start a drag", () => {
    setup("side")
    const caret = document.querySelector(".tree-caret")!
    const ev = createEvent.dragStart(caret, { dataTransfer: dt({}) })
    fireEvent(caret, ev)
    expect(ev.defaultPrevented).toBe(true)
  })
})

describe("⌘K — move session left / right", () => {
  it("steps the focused session", async () => {
    const { CommandPalette } = await import("./command-palette")
    st().newTab(testShell)
    st().newTab(testShell) // the second is focused
    const [a, b] = order()
    act(() => st().setPaletteOpen(true))
    render(<CommandPalette />)
    fireEvent.mouseDown(screen.getByText("Move session left"))
    expect(order()).toEqual([b, a])
  })
})
