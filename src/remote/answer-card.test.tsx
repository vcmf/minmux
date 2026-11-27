import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { AnswerCard } from "./answer-card"
import type { HostMessage, RemotePane } from "../lib/remote-protocol"

const pane: RemotePane = {
  id: "p",
  tab: "t",
  title: "a",
  kind: "agent",
  agent: "claude",
  status: "waiting",
  asking: true,
  waitId: "w1",
  detail: "Claude needs your permission to use Bash",
  started: true,
}

function setup(canAnswer = true) {
  const sent: Record<string, unknown>[] = []
  const listeners = new Set<(m: HostMessage) => void>()
  const openTerminal = vi.fn()
  render(
    <AnswerCard
      pane={pane}
      agentName="Claude"
      canAnswer={canAnswer}
      send={(m) => (sent.push(m as Record<string, unknown>), true)}
      subscribe={(fn) => (listeners.add(fn), () => void listeners.delete(fn))}
      openTerminal={openTerminal}
    />,
  )
  return { sent, openTerminal, push: (m: HostMessage) => act(() => listeners.forEach((f) => f(m))) }
}

const dialog = {
  question: "Do you want to proceed?",
  options: [
    { n: 1, label: "Yes" },
    { n: 2, label: "No" },
  ],
}

describe("AnswerCard", () => {
  it("reads the dialog, answers with the option's number and label, explains a refusal", () => {
    const { sent, push } = setup()
    expect(sent[0]).toEqual({ t: "dialog", pane: "p" })
    push({ t: "dialog", pane: "p", dialog, answerable: true })
    expect(screen.getByText("Do you want to proceed?")).toBeInTheDocument()
    fireEvent.click(screen.getByText("Yes"))
    expect(sent[sent.length - 1]).toEqual({
      t: "answer",
      pane: "p",
      waitId: "w1",
      n: 1,
      label: "Yes",
    })
    push({ t: "answered", pane: "p", waitId: "w1", ok: false, reason: "changed" })
    expect(screen.getByText(/The screen changed/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("Look again"))
    expect(sent[sent.length - 1]).toEqual({ t: "dialog", pane: "p" })
  })

  it("an agent that isn't answered by number, or a view-only device: options shown, no buttons", () => {
    const { push, openTerminal } = setup()
    push({ t: "dialog", pane: "p", dialog, answerable: false })
    expect(screen.queryByRole("button", { name: /Yes/ })).toBeNull()
    fireEvent.click(screen.getByText("Open the Terminal view"))
    expect(openTerminal).toHaveBeenCalled()
  })

  it("no options on screen: says so", () => {
    const { push } = setup(false)
    push({ t: "dialog", pane: "p", dialog: null, answerable: true })
    expect(screen.getByText(/options aren't on screen/)).toBeInTheDocument()
    expect(screen.getByText(/needs your permission/)).toBeInTheDocument()
  })
})
