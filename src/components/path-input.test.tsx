import { describe, it, expect, vi, beforeEach } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { PathInput } from "./path-input"
import { ipc } from "../lib/ipc"
import { useStore } from "../store"
import { listings } from "../lib/listing-store"

const d = (name: string) => ({ name, isDir: true })
const LIST: Record<string, string[]> = {
  "/Users/me": ["workspace", "work-old", ".hidden"],
  "/Users/me/workspace": ["term", "term-phone"],
  "/big": ["alpha", "beta"],
}

beforeEach(() => {
  useStore.setState({ home: "/Users/me", platform: "darwin" })
  vi.mocked(ipc.readdir).mockImplementation(async (dir: string) => ({
    // A truncated read holds only folders (they sort first): more folders may be past the cap
    entries: [
      ...(LIST[dir] ?? []).map(d),
      ...(dir === "/big" ? [] : [{ name: "f.txt", isDir: false }]),
    ],
    truncated: dir === "/big",
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
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.keyDown(input, { key: "Escape" }) // closes the list, not the box
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
  it("a truncated folder says more exist, however few match", async () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: "/big/a" } })
    await waitFor(() => expect(names()).toEqual(["alpha"]))
    expect(screen.getByText(/more/)).toBeInTheDocument()
  })

  it("a press on the list (its scrollbar) keeps the box open", async () => {
    const { input, onClose } = setup()
    fireEvent.change(input, { target: { value: "~/" } })
    await waitFor(() => expect(names()).toHaveLength(2))
    const list = screen.getByRole("listbox")
    expect(fireEvent.mouseDown(list)).toBe(false) // default prevented: no blur
    expect(onClose).not.toHaveBeenCalled()
  })

  it("the selection follows its name, not its row", async () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: "~/wo" } })
    await waitFor(() => expect(names()).toHaveLength(2))
    fireEvent.keyDown(input, { key: "ArrowDown" })
    fireEvent.keyDown(input, { key: "ArrowDown" })
    const selected = () => screen.getByRole("option", { selected: true }).textContent
    expect(selected()).toBe("work-old")
    fireEvent.change(input, { target: { value: "~/wor" } }) // a new edit clears it
    expect(screen.queryByRole("option", { selected: true })).toBeNull()
  })
  it("a too-big folder with no match among what was read says so", async () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: "/big/zeta" } })
    await waitFor(() => expect(screen.getByText(/too many to list/i)).toBeInTheDocument())
    expect(names()).toEqual([])
  })

  it("only rows on screen can be selected", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `d${String(i).padStart(3, "0")}`)
    LIST["/many"] = many
    const { input, onSetRoot } = setup()
    fireEvent.change(input, { target: { value: "/many/" } })
    await waitFor(() => expect(names()).toHaveLength(200))
    fireEvent.keyDown(input, { key: "ArrowUp" }) // wraps to the last row shown
    expect(screen.getByRole("option", { selected: true }).textContent).toBe("d199")
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(onSetRoot).toHaveBeenCalledWith("/many/d199"))
  })

  it("an edit voids a pending check", async () => {
    let answer!: (ok: boolean) => void
    vi.mocked(ipc.pathIsDir).mockImplementationOnce(() => new Promise((r) => (answer = r)))
    const { input, onSetRoot } = setup()
    fireEvent.change(input, { target: { value: "/Users/me/workspace" } })
    fireEvent.keyDown(input, { key: "Enter" })
    fireEvent.change(input, { target: { value: "/Users/me/wo" } })
    answer(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(onSetRoot).not.toHaveBeenCalled()
    expect(input.className).not.toContain("invalid")
  })
  it("keeps its reads out of the folder views' listings", async () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: "/Users/me/nope/" } })
    await waitFor(() => expect(ipc.readdir).toHaveBeenCalledWith("/Users/me/nope", undefined))
    fireEvent.change(input, { target: { value: "~/" } })
    await waitFor(() => expect(names()).toHaveLength(2))
    expect(listings.get("")["/Users/me/nope"]).toBeUndefined()
    expect(listings.get("")["/Users/me"]).toBeUndefined()
  })

  it("a pasted leading space still completes", async () => {
    const { input } = setup()
    fireEvent.change(input, { target: { value: " ~/wo" } })
    await waitFor(() => expect(names()).toEqual(["workspace", "work-old"]))
  })
})
