import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { PaneView, type PaneViewProps } from "./pane-view"
import type { HostMessage, RemotePane } from "../lib/remote-protocol"

const pane = (over: Partial<RemotePane> = {}): RemotePane => ({
  id: "p",
  tab: "t",
  title: "agent-fleet",
  kind: "agent",
  agent: "claude",
  status: "idle",
  started: true,
  ...over,
})

function setup(over: Partial<PaneViewProps> = {}) {
  const sent: Record<string, unknown>[] = []
  let push: (m: HostMessage) => void = () => {}
  const props: PaneViewProps = {
    pane: pane(),
    permission: "send",
    online: true,
    epoch: 1,
    send: (m) => (sent.push(m as Record<string, unknown>), true),
    subscribe: (fn) => ((push = fn), () => {}),
    onBack: vi.fn(),
    ...over,
  }
  const r = render(<PaneView {...props} />)
  return { sent, push: (m: HostMessage) => act(() => push(m)), props, r }
}

describe("PaneView", () => {
  it("watches the pane and shows its conversation", () => {
    const { sent, push } = setup()
    expect(sent[0]).toEqual({ t: "watch", pane: "p" })
    push({
      t: "chat",
      pane: "p",
      reset: true,
      more: true,
      items: [
        { id: "1", kind: "user", text: "fix it" },
        { id: "2", kind: "assistant", text: "On it." },
        { id: "3", kind: "tool", name: "Bash", summary: "make test", result: "ok" },
        {
          id: "4",
          kind: "question",
          questions: [
            {
              header: "Mode",
              question: "Which?",
              multi: true,
              options: [{ label: "A", description: "first" }],
            },
          ],
        },
      ],
    })
    expect(screen.getByText("fix it")).toBeInTheDocument()
    expect(screen.getByText("Which?")).toBeInTheDocument()
    expect(screen.getByText("Several can be picked")).toBeInTheDocument()
    expect(screen.getByText("first")).toBeInTheDocument()
    fireEvent.click(screen.getByText("make test"))
    expect(screen.getByText("ok")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Load earlier"))
    expect(sent[sent.length - 1]).toEqual({ t: "more", pane: "p", before: "1" })
    push({ t: "chat", pane: "other", items: [{ id: "x", kind: "user", text: "elsewhere" }] })
    expect(screen.queryByText("elsewhere")).toBeNull()
  })

  it("sends a message, shows it until acked, explains a refusal", () => {
    const { sent, push } = setup()
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "run the tests" } })
    fireEvent.click(screen.getByText("Send"))
    const msg = sent[sent.length - 1]!
    expect(msg).toMatchObject({ t: "send", pane: "p", text: "run the tests" })
    expect(screen.getByText("Sending…")).toBeInTheDocument()
    push({ t: "ack", id: msg.id as string, ok: false, reason: "held" })
    expect(screen.getByText(/Pasted but not sent/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("Edit and retry"))
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("run the tests")
  })

  it("while the agent asks, says so and doesn't send", () => {
    setup({ pane: pane({ status: "waiting", detail: "Claude needs your permission" }) })
    expect(screen.getByText(/Claude is asking something/)).toBeInTheDocument()
    expect(screen.getByText("Send")).toBeDisabled()
  })

  it("view-only and unavailable panes", () => {
    const { push } = setup({ permission: "view", pane: pane({ kind: "shell", agent: undefined }) })
    expect(screen.getByLabelText("Message")).toBeDisabled()
    push({ t: "chat", pane: "p", items: [], reset: true, unavailable: "no-agent" })
    expect(screen.getByText(/No agent conversation here/)).toBeInTheDocument()
    push({ t: "chat", pane: "p", items: [], reset: true, unavailable: "error" })
    expect(screen.getByText(/couldn't be read/)).toBeInTheDocument()
  })

  it("after a reconnect, re-watches and resends what wasn't answered", () => {
    const { sent, r, props } = setup()
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "hello" } })
    fireEvent.click(screen.getByText("Send"))
    const id = sent[sent.length - 1]!.id
    r.rerender(<PaneView {...props} epoch={2} />)
    expect(sent.filter((m) => m.t === "watch")).toHaveLength(2)
    expect(sent.filter((m) => m.t === "send" && m.id === id)).toHaveLength(2)
    fireEvent.click(screen.getByText("‹ Panes"))
    expect(props.onBack).toHaveBeenCalled()
  })
})
