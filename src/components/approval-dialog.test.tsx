import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ApprovalDialog } from "./approval-dialog"
import type { ApprovalRequest } from "../lib/remote-view"

const phone: ApprovalRequest = { id: 3, name: "iphone", code: "K7QM", machine: false, expires: 0 }
const machine: ApprovalRequest = { id: 4, name: "linux", code: "ACDE", machine: true, expires: 0 }

function mount(list: ApprovalRequest[]) {
  let push: (l: ApprovalRequest[]) => void = () => {}
  vi.mocked(window.minmux.remoteApprovals).mockResolvedValueOnce(list)
  vi.mocked(window.minmux.onRemoteApprovals).mockImplementationOnce((cb) => {
    push = cb
    return () => {}
  })
  render(<ApprovalDialog />)
  return { push: (l: ApprovalRequest[]) => act(() => push(l)) }
}

describe("ApprovalDialog", () => {
  it("shows the code, defaults a phone to Send, and allows with the picked permission", async () => {
    mount([phone])
    expect(await screen.findByText("iphone wants to use minmux")).toBeInTheDocument()
    expect(screen.getByLabelText("Code K 7 Q M")).toBeInTheDocument()
    expect(window.minmux.remoteApprovalShown).toHaveBeenCalledWith(3)
    expect(screen.getByRole("radio", { name: "Send" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("Deny")).toHaveFocus() // Enter never lets it in unseen
    fireEvent.click(screen.getByRole("radio", { name: "Type keys" }))
    expect(screen.getByText(/type into terminals/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("Allow"))
    expect(window.minmux.remoteApprove).toHaveBeenCalledWith(3, "keys")
  })

  it("another machine: Watch or Type keys, Type keys first; Escape denies", async () => {
    mount([machine])
    expect(
      await screen.findByText("minmux on linux wants to open your terminals"),
    ).toBeInTheDocument()
    expect(screen.queryByRole("radio", { name: "Send" })).toBeNull()
    expect(screen.getByRole("radio", { name: "Type keys" })).toHaveAttribute("aria-checked", "true")
    fireEvent.keyDown(window, { key: "Tab" })
    expect(screen.getByText("Allow")).toHaveFocus()
    fireEvent.keyDown(window, { key: "Tab" })
    expect(screen.getByRole("radio", { name: "Watch" })).toHaveFocus() // stays in the dialog
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true })
    expect(screen.getByText("Allow")).toHaveFocus()
    fireEvent.keyDown(window, { key: "Escape" })
    expect(window.minmux.remoteApprove).toHaveBeenCalledWith(4, "deny")
  })

  it("follows the list main sends: the next request, then nothing", async () => {
    const { push } = mount([])
    await waitFor(() => expect(window.minmux.remoteApprovals).toHaveBeenCalled())
    expect(screen.queryByRole("alertdialog")).toBeNull()
    push([phone, machine])
    expect(screen.getByText("iphone wants to use minmux")).toBeInTheDocument()
    expect(window.minmux.remoteApprovalShown).toHaveBeenCalledWith(4) // queued: shown next
    push([machine])
    expect(screen.getByText(/minmux on linux/)).toBeInTheDocument()
    push([])
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })
})
