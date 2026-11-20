import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, waitFor, fireEvent } from "@testing-library/react"
import { FilePreview } from "./file-preview"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore } from "../test/helpers"

describe("FilePreview", () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
    useStore.setState({ preview: null })
  })

  it("renders nothing when no file is open", () => {
    const { container } = render(<FilePreview />)
    expect(container).toBeEmptyDOMElement()
  })

  it("shows the filename and the file's text", async () => {
    vi.mocked(ipc.readFilePreview).mockResolvedValue({
      kind: "text",
      text: "const x = 1\n",
      truncated: false,
      size: 12,
    })
    useStore.setState({ preview: { abs: "/repo/app.ts", name: "app.ts" } })
    const { container } = render(<FilePreview />)
    expect(screen.getByText("app.ts")).toBeInTheDocument()
    await waitFor(() =>
      expect(container.querySelector(".lp-code")?.textContent).toContain("const x = 1"),
    )
  })

  it("opens the file in the editor or reveals it", () => {
    vi.mocked(ipc.readFilePreview).mockResolvedValue({
      kind: "text",
      text: "",
      truncated: false,
      size: 0,
    })
    useStore.setState({ preview: { abs: "/repo/app.ts", name: "app.ts" } })
    render(<FilePreview />)
    fireEvent.click(screen.getByTitle("Open in editor"))
    fireEvent.click(screen.getByTitle("Reveal in file manager"))
    expect(ipc.openFile).toHaveBeenCalledWith("", "/repo/app.ts")
    expect(ipc.revealPath).toHaveBeenCalledWith("/repo/app.ts")
  })

  it("shows a binary-file state instead of garbage", async () => {
    vi.mocked(ipc.readFilePreview).mockResolvedValue({ kind: "binary", size: 999 })
    useStore.setState({ preview: { abs: "/repo/x.png", name: "x.png" } })
    render(<FilePreview />)
    await waitFor(() => expect(screen.getByText(/Binary file/)).toBeInTheDocument())
  })
})
