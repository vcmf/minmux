import { describe, it, expect, vi } from "vitest"
import { render, screen, fireEvent, waitFor } from "@testing-library/react"
import { RootBreadcrumb } from "./root-breadcrumb"
import { ipc } from "../lib/ipc"

describe("RootBreadcrumb", () => {
  it("renders the trailing path segments as crumbs", () => {
    render(<RootBreadcrumb root="/a/b/c" onSetRoot={() => {}} />)
    expect(screen.getByText("c")).toBeInTheDocument()
    expect(screen.getByText("b")).toBeInTheDocument()
  })

  it("clicking a crumb sets that ancestor as the root", () => {
    const spy = vi.fn()
    render(<RootBreadcrumb root="/a/b/c" onSetRoot={spy} />)
    fireEvent.click(screen.getByText("b"))
    expect(spy).toHaveBeenCalledWith("/a/b")
  })

  it("a typed path is applied only when it's a folder", async () => {
    const spy = vi.fn()
    render(<RootBreadcrumb root="/a/b" onSetRoot={spy} />)
    fireEvent.click(screen.getByTitle("Enter a path"))
    const input = screen.getByPlaceholderText(/folder path/i)
    vi.mocked(ipc.pathIsDir).mockResolvedValueOnce(false)
    fireEvent.change(input, { target: { value: "/nope" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(input.className).toContain("invalid"))
    vi.mocked(ipc.pathIsDir).mockResolvedValueOnce(true)
    fireEvent.change(input, { target: { value: "/w/rts" } })
    fireEvent.keyDown(input, { key: "Enter" })
    await waitFor(() => expect(spy).toHaveBeenCalledWith("/w/rts"))
  })

  it("the owner's own buttons sit after its actions", () => {
    render(<RootBreadcrumb root="/a" onSetRoot={() => {}} actions={<button title="Mine" />} />)
    expect(screen.getByTitle("Mine")).toBeInTheDocument()
  })
})
