import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ClosePaneDialog } from "./close-pane-dialog"
import { useStore } from "../store"
import { resetStore, testShell } from "../test/helpers"

vi.mock("../terminal/terminal-manager", () => ({
  TerminalManager: { focus: vi.fn(), dispose: vi.fn() },
}))

const st = () => useStore.getState()

/** One tab whose only pane holds two terminals, with the close already requested. */
const setup = () => {
  st().newTab(testShell)
  st().newSurface()
  const root = st().tabs[0]!.root
  if (root.type !== "leaf") throw new Error("expected leaf")
  st().requestClosePane(st().tabs[0]!.id, root.id)
}

beforeEach(() => {
  resetStore()
  useStore.setState({ closeConfirm: null })
})

describe("ClosePaneDialog", () => {
  it("renders nothing when no close is pending", () => {
    const { container } = render(<ClosePaneDialog />)
    expect(container).toBeEmptyDOMElement()
  })

  it("names how many terminals will be closed", () => {
    setup()
    render(<ClosePaneDialog />)
    expect(screen.getByText("Close pane with 2 terminals?")).toBeInTheDocument()
  })

  it("confirm closes the pane (and here, the tab)", () => {
    setup()
    render(<ClosePaneDialog />)
    fireEvent.click(screen.getByRole("button", { name: "Close pane" }))
    expect(st().tabs).toHaveLength(0)
    expect(st().closeConfirm).toBeNull()
  })

  it("the confirm button has focus, so Enter confirms", () => {
    setup()
    render(<ClosePaneDialog />)
    expect(screen.getByRole("button", { name: "Close pane" })).toHaveFocus()
  })

  it("Cancel and Escape keep every terminal", () => {
    setup()
    const { rerender } = render(<ClosePaneDialog />)
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    expect(st().closeConfirm).toBeNull()
    expect(Object.keys(st().sessions)).toHaveLength(2)

    const root = st().tabs[0]!.root
    if (root.type !== "leaf") throw new Error("expected leaf")
    st().requestClosePane(st().tabs[0]!.id, root.id)
    rerender(<ClosePaneDialog />)
    fireEvent.keyDown(window, { key: "Escape" })
    expect(st().closeConfirm).toBeNull()
    expect(Object.keys(st().sessions)).toHaveLength(2)
  })
})

describe("ClosePaneDialog — modal", () => {
  beforeEach(() => {
    resetStore()
    useStore.setState({ closeConfirm: null })
  })

  it("Tab cycles between the dialog's buttons only", () => {
    setup()
    render(<ClosePaneDialog />)
    const confirmBtn = screen.getByRole("button", { name: "Close pane" })
    const cancelBtn = screen.getByRole("button", { name: "Cancel" })
    fireEvent.keyDown(confirmBtn, { key: "Tab" })
    expect(cancelBtn).toHaveFocus()
    fireEvent.keyDown(cancelBtn, { key: "Tab" })
    expect(confirmBtn).toHaveFocus()
  })
})

describe("ClosePaneDialog — sessions and terminals", () => {
  it("names the session, the terminal count and a running Claude", () => {
    useStore.setState({
      closeConfirm: { kind: "tab", tabId: "t", title: "term", count: 3, claude: 1 },
    })
    render(<ClosePaneDialog />)
    expect(screen.getByText('Close "term"?')).toBeInTheDocument()
    expect(screen.getByText(/3 terminals will close.*1 is running Claude/)).toBeInTheDocument()
    expect(screen.getByText("Close session")).toBeInTheDocument()
  })
})
