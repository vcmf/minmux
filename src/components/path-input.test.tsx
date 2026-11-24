import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { PathInput } from "./path-input"
import { ipc } from "../lib/ipc"
import { useStore } from "../store"

const d = (name: string) => ({ name, isDir: true })
const LIST: Record<string, string[]> = {
  "/Users/me": ["workspace", "work-old", ".hidden"],
  "/Users/me/workspace": ["term", "term-phone"],
}

beforeEach(() => {
  useStore.setState({ home: "/Users/me", platform: "darwin" })
  vi.mocked(ipc.readdir).mockImplementation(async (dir: string) => ({
    entries: [...(LIST[dir] ?? []).map(d), { name: "file.txt", isDir: false }],
    truncated: false,
  }))
})

const setup = (onSetRoot = vi.fn(), onClose = vi.fn()) => {
  render(<PathInput root="/x" onSetRoot={onSetRoot} onClose={onClose} />)
  return { input: screen.getByRole("combobox") as HTMLInputElement, onSetRoot, onClose }
}
const names = () => screen.queryAllByRole("option").map((o) => o.textContent)

describe("PathInput", () => {
  it("lists the folders of a typed ~/ prefix, folders only, no hidden ones", async () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: "~/wo" } })
    await waitFor(() => expect(names()).toEqual(["workspace", "work-old"]))
    expect(ipc.readdir).toHaveBeenCalledWith("/Users/me", undefined)
  })

  it("Tab completes the common prefix, then the only match plus a separator", async () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: "~/workspace/t" } })
    await waitFor(() => expect(names()).toEqual(["term", "term-phone"]))
    fireEvent.keyDown(input, { key: "Tab" })
    expect(input.value).toBe("~/workspace/term")
    fireEvent.change(input, { target: { value: "~/workspace/term-" } })
    fireEvent.keyDown(input, { key: "Tab" })
    expect(input.value).toBe("~/workspace/term-phone/")
  })

  it("typing within a name reads nothing new", async () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: "/Users/me/" } })
    await waitFor(() => expect(names()).toHaveLength(2))
    const reads = vi.mocked(ipc.readdir).mock.calls.length
    fireEvent.change(input, { target: { value: "/Users/me/w" } })
    fireEvent.change(input, { target: { value: "/Users/me/wor" } })
    expect(vi.mocked(ipc.readdir).mock.calls.length).toBe(reads)
  })

  it("↓ then Enter goes to the selected folder, ~ expanded", async () => {
    const { input, onSetRoot } = setup()
    fireEvent.change(input, { target: { value: "~/wo" } })
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(onSetRoot).toHaveBeenCalledWith("/Users/me/work-old"))
  })

  it("Enter on a typed path drops a trailing separator", async () => {
    const { input, onSetRoot } = setup()
    fireEvent.change(input, { target: { value: "~/workspace/" } })
    fireEvent.keyDown(input, { key: "Escape" }) // closes the list (if shown), not the box
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(onSetRoot).toHaveBeenCalledWith("/Users/me/workspace"))
  })

  it("Esc closes the list first, then the box", async () => {
    const { input, onClose } = setup()
    fireEvent.change(input, { target: { value: "~/" } })
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.keyDown(input, { key: "Escape" })
    expect(names()).toHaveLength(0)
    expect(onClose).not.toHaveBeenCalled()
    fireEvent.keyDown(input, { key: "Escape" })
    expect(onClose).toHaveBeenCalled()
  })

  it("clicking a suggestion completes it and lists its folders", async () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: "~/workspace/" } })
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.mouseDown(screen.getAllByRole("option")[0]!)
    expect(input.value).toBe("~/workspace/term/")
  })
})
