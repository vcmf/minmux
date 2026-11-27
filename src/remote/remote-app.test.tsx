import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { RemoteApp } from "./remote-app"
import type { RemotePanes } from "../lib/remote-protocol"

class FakeWs {
  static all: FakeWs[] = []
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: string) {
    FakeWs.all.push(this)
    setTimeout(() => this.onopen?.(), 0)
  }
  send(d: string) {
    this.sent.push(d)
  }
  close() {}
  recv(m: unknown) {
    act(() => this.onmessage?.({ data: JSON.stringify(m) }))
  }
}

type Route = (init?: RequestInit) => { status?: number; body: unknown }
let routes: Record<string, Route>
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  const key = Object.keys(routes).find((k) => url.startsWith(k))
  if (!key) return new Response("not found", { status: 404 })
  const r = routes[key]!(init)
  return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
})

const panes: RemotePanes = {
  tabs: [
    { id: "t1", title: "minmux" },
    { id: "t2", title: "rts" },
  ],
  panes: [
    {
      id: "a",
      tab: "t1",
      title: "agent-fleet",
      kind: "agent",
      agent: "claude",
      status: "waiting",
      asking: true,
      detail: "Claude needs your permission",
      started: true,
    },
    {
      id: "b",
      tab: "t1",
      title: "zsh",
      kind: "shell",
      status: "idle",
      cwd: "~/term",
      started: true,
    },
    {
      id: "c",
      tab: "t2",
      title: "map-editor",
      kind: "agent",
      agent: "codex",
      status: "working",
      started: false,
    },
  ],
  stale: false,
}

beforeEach(() => {
  FakeWs.all = []
  routes = { "/api/session": () => ({ body: { state: "ok", machine: "mac", device: "iphone" } }) }
  vi.stubGlobal("fetch", fetchMock)
  vi.stubGlobal("WebSocket", FakeWs)
  history.replaceState(null, "", "/")
})
afterEach(() => {
  vi.unstubAllGlobals()
  fetchMock.mockClear()
})

async function connect() {
  render(<RemoteApp />)
  await waitFor(() => expect(FakeWs.all).toHaveLength(1))
  const ws = FakeWs.all[0]!
  await waitFor(() => expect(ws.sent[0]).toContain('"hello"'))
  ws.recv({ t: "welcome", v: 1, machine: "mac", device: "iphone", permission: "send" })
  ws.recv({ t: "panes", panes })
  return ws
}

describe("RemoteApp", () => {
  it("lists panes by tab, with status, and opens one", async () => {
    await connect()
    expect(screen.getByText("connected")).toBeInTheDocument()
    expect(screen.getByText("agent-fleet")).toBeInTheDocument()
    expect(screen.getByText("Claude needs your permission")).toBeInTheDocument()
    expect(screen.getByText("not started on the desktop")).toBeInTheDocument()
    expect(screen.getByText("map-editor").closest("button")).toBeDisabled()
    fireEvent.click(screen.getByRole("checkbox"))
    expect(screen.getByText("Needs input")).toBeInTheDocument()
    fireEvent.click(screen.getAllByText("agent-fleet")[0]!)
    expect(screen.getByText(/Claude is asking something/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("‹ Panes"))
    expect(screen.getByText("zsh")).toBeInTheDocument()
  })

  it("an unanswered message is sent again after a reconnect, even from the pane list", async () => {
    const ws = await connect()
    fireEvent.click(screen.getByText("zsh"))
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "ls" } })
    fireEvent.click(screen.getByText("Send"))
    const first = ws.sent.map((d) => JSON.parse(d)).find((m) => m.t === "send")
    expect(first).toMatchObject({ pane: "b", text: "ls" })
    fireEvent.click(screen.getByText("‹ Panes"))
    act(() => ws.onclose?.())
    await waitFor(() => expect(FakeWs.all).toHaveLength(2), { timeout: 3000 })
    const ws2 = FakeWs.all[1]!
    await waitFor(() => expect(ws2.sent[0]).toContain('"hello"'))
    ws2.recv({ t: "welcome", v: 1, machine: "mac", device: "iphone", permission: "send" })
    await waitFor(() =>
      expect(ws2.sent.map((d) => JSON.parse(d)).find((m) => m.t === "send")).toMatchObject({
        id: first.id,
        text: "ls",
      }),
    )
  })

  it("says when the desktop window is closed, and when the link drops", async () => {
    const ws = await connect()
    ws.recv({ t: "panes", panes: { ...panes, stale: true } })
    expect(screen.getByText(/desktop window is closed/)).toBeInTheDocument()
    act(() => ws.onclose?.())
    expect(screen.getByText(/Connection lost/)).toBeInTheDocument()
  })

  it("asks for access when the device isn't approved", async () => {
    routes["/api/session"] = () => ({ body: { state: "none", machine: "mac" } })
    routes["/api/approve"] = () => ({ body: { pending: "f".repeat(32) } })
    render(<RemoteApp />)
    fireEvent.click(await screen.findByText("Ask for access"))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/approve",
        expect.objectContaining({ method: "POST" }),
      ),
    )
  })

  it("shows the code while pending, then connects", async () => {
    const id = "a".repeat(32)
    history.replaceState(null, "", `/?pending=${id}`)
    let n = 0
    routes[`/api/pending/${id}`] = () =>
      n++ === 0
        ? { body: { state: "pending", code: "K7QM", machine: "mac" } }
        : { body: { state: "approved" } }
    render(<RemoteApp />)
    expect(await screen.findByText("K7QM")).toBeInTheDocument()
    await waitFor(() => expect(FakeWs.all).toHaveLength(1), { timeout: 3000 })
    expect(location.search).toBe("")
  })

  it.each([
    ["limited", "Too many requests"],
    ["readonly", "Can't add devices"],
    ["nonsense", "The request expired"],
  ])("pending=%s says so", async (id, title) => {
    history.replaceState(null, "", `/?pending=${id}`)
    render(<RemoteApp />)
    expect(await screen.findByText(title)).toBeInTheDocument()
  })

  it("a denied or gone request says so", async () => {
    const id = "b".repeat(32)
    history.replaceState(null, "", `/?pending=${id}`)
    routes[`/api/pending/${id}`] = () => ({ body: { state: "denied" } })
    render(<RemoteApp />)
    expect(await screen.findByText("Not allowed")).toBeInTheDocument()
  })

  it("unlocks with the PIN", async () => {
    let locked = true
    routes["/api/session"] = () =>
      locked
        ? { body: { state: "locked", machine: "mac", device: "iphone", pin: true } }
        : { body: { state: "ok", machine: "mac", device: "iphone" } }
    let result = "wrong"
    routes["/api/unlock"] = () => ({ body: { result } })
    render(<RemoteApp />)
    const input = await screen.findByLabelText("PIN")
    fireEvent.change(input, { target: { value: "111111" } })
    fireEvent.click(screen.getByText("Unlock"))
    expect(await screen.findByText("Wrong PIN.")).toBeInTheDocument()
    result = "ok"
    locked = false
    fireEvent.change(input, { target: { value: "123456" } })
    fireEvent.click(screen.getByText("Unlock"))
    await waitFor(() => expect(FakeWs.all).toHaveLength(1))
  })

  it("locked without a PIN asks for approval again", async () => {
    routes["/api/session"] = () => ({
      body: { state: "locked", machine: "mac", device: "iphone", pin: false },
    })
    render(<RemoteApp />)
    expect(await screen.findByText(/wasn't used for 24 hours/)).toBeInTheDocument()
    expect(screen.getByText("Ask for access")).toBeInTheDocument()
  })

  it.each([
    ["disconnected", "Disconnected"],
    ["revoked", "This device was removed"],
    ["version", "minmux was updated"],
  ])("bye %s", async (reason, title) => {
    const ws = await connect()
    ws.recv({ t: "bye", reason })
    expect(await screen.findByText(title)).toBeInTheDocument()
  })
})
