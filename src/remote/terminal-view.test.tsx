import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { HostMessage, RemotePane } from "../lib/remote-protocol"
import { fitFontSize } from "./terminal-keys"

const writes: string[] = []
const sizes: [number, number][] = []
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    open() {}
    reset() {}
    resize(c: number, r: number) {
      sizes.push([c, r])
    }
    write(d: string, cb?: () => void) {
      if (d === "\x1bc") writes.length = 0
      else if (d) writes.push(d)
      cb?.()
    }
    dispose() {}
  },
}))
vi.mock("@xterm/xterm/css/xterm.css", () => ({}))

const { TerminalView } = await import("./terminal-view")

const pane: RemotePane = {
  id: "p",
  tab: "t",
  title: "zsh",
  kind: "shell",
  status: "idle",
  started: true,
}

function setup(permission: "send" | "keys" = "send") {
  const sent: Record<string, unknown>[] = []
  const listeners = new Set<(m: HostMessage) => void>()
  render(
    <TerminalView
      pane={pane}
      permission={permission}
      online
      epoch={1}
      send={(m) => (sent.push(m as Record<string, unknown>), true)}
      subscribe={(fn) => (listeners.add(fn), () => void listeners.delete(fn))}
    />,
  )
  return { sent, push: (m: HostMessage) => act(() => listeners.forEach((f) => f(m))) }
}

describe("TerminalView", () => {
  it("follows the pane: a clean start, then live output and resizes", async () => {
    const { sent, push } = setup()
    expect(sent[0]).toEqual({ t: "term", pane: "p", on: true })
    push({ t: "tsnap", pane: "p", cols: 100, rows: 30, data: "screen" }) // before xterm loaded
    await waitFor(() => expect(writes).toEqual(["screen"]))
    push({ t: "tout", pane: "p", data: "more" })
    push({ t: "tout", pane: "other", data: "not mine" })
    expect(writes).toEqual(["screen", "more"])
    push({ t: "tsize", pane: "p", cols: 120, rows: 40 })
    expect(sizes[sizes.length - 1]).toEqual([120, 40])
    expect(screen.queryByText(/Loading the terminal/)).toBeNull()
    push({ t: "tsnap", pane: "p", cols: 0, rows: 0, data: "", gone: true })
    expect(screen.getByText(/gone on the computer/)).toBeInTheDocument()
  })

  it("the keys bar shows only for devices allowed raw keys", () => {
    const a = setup("send")
    expect(screen.queryByText("Ctrl-C")).toBeNull()
    void a
    const b = setup("keys")
    fireEvent.click(screen.getByText("Ctrl-C"))
    expect(b.sent[b.sent.length - 1]).toEqual({ t: "keys", pane: "p", data: "\x03" })
  })

  it("text is sized so the pane's columns fit the screen", () => {
    expect(fitFontSize(390, 80)).toBe(8.1)
    expect(fitFontSize(390, 300)).toBe(5)
    expect(fitFontSize(2000, 40)).toBe(14)
  })
})
