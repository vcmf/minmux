import { describe, expect, it, vi } from "vitest"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { AnswerCard } from "./answer-card"
import { dialogSignature, type HostMessage, type RemotePane } from "../lib/remote-protocol"

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

function setup(canAnswer = true, keysAllowed = true) {
  const sent: Record<string, unknown>[] = []
  const listeners = new Set<(m: HostMessage) => void>()
  const openTerminal = vi.fn()
  render(
    <AnswerCard
      pane={pane}
      agentName="Claude"
      canAnswer={canAnswer}
      keysAllowed={keysAllowed}
      online
      epoch={1}
      send={(m) => (sent.push(m as Record<string, unknown>), true)}
      subscribe={(fn) => (listeners.add(fn), () => void listeners.delete(fn))}
      openTerminal={openTerminal}
    />,
  )
  return { sent, openTerminal, push: (m: HostMessage) => act(() => listeners.forEach((f) => f(m))) }
}

const dialog = {
  kind: "permission" as const,
  question: "Do you want to proceed?",
  body: ["Bash command", "rm -rf build"],
  options: [
    { n: 1, label: "Yes" },
    { n: 2, label: "No" },
  ],
}

describe("AnswerCard", () => {
  it("reads the dialog, answers with the option's number and label, explains a refusal", () => {
    const { sent, push } = setup()
    expect(sent[0]).toEqual({ t: "dialog", pane: "p", waitId: "w1" })
    push({
      t: "dialog",
      pane: "p",
      waitId: "w0",
      dialog: { ...dialog, question: "Old?" },
      answerable: true,
    })
    expect(screen.queryByText("Old?")).toBeNull() // a reply about an earlier dialog
    push({ t: "dialog", pane: "p", waitId: "w1", dialog, answerable: true })
    expect(screen.getByText("Do you want to proceed?")).toBeInTheDocument()
    expect(screen.getByText(/rm -rf build/)).toBeInTheDocument() // what it asks about
    expect(screen.getByText(/needs your permission/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("Yes"))
    expect(sent[sent.length - 1]).toEqual({
      t: "answer",
      pane: "p",
      waitId: "w1",
      n: 1,
      seen: dialogSignature(dialog),
    })
    push({ t: "answered", pane: "p", waitId: "w1", ok: false, reason: "changed" })
    expect(screen.getByText(/The screen changed/)).toBeInTheDocument()
    fireEvent.click(screen.getByText("Look again"))
    expect(sent[sent.length - 1]).toEqual({ t: "dialog", pane: "p", waitId: "w1" })
  })

  it("an agent that isn't answered by number, or a view-only device: options shown, no buttons", () => {
    const { push, openTerminal } = setup()
    push({ t: "dialog", pane: "p", waitId: "w1", dialog, answerable: false })
    expect(screen.queryByRole("button", { name: /Yes/ })).toBeNull()
    fireEvent.click(screen.getByText("Open the Terminal view"))
    expect(openTerminal).toHaveBeenCalled()
  })

  it("a view-only device, or one without raw keys, is told where to answer", () => {
    const a = setup(false)
    a.push({ t: "dialog", pane: "p", waitId: "w1", dialog, answerable: true })
    expect(screen.getByText(/can only view/)).toBeInTheDocument()
    void a
  })

  it("an error reply frees the buttons", () => {
    const { push } = setup()
    push({ t: "dialog", pane: "p", waitId: "w1", dialog, answerable: true })
    fireEvent.click(screen.getByText("Yes"))
    expect(screen.getByText("No").closest("button")).toBeDisabled()
    push({ t: "error", code: "bad-message", message: "x" })
    expect(screen.getByText("No").closest("button")).not.toBeDisabled()
  })

  it("no options on screen: says so", () => {
    const { push } = setup(false)
    push({ t: "dialog", pane: "p", waitId: "w1", dialog: null, answerable: true })
    expect(screen.getByText(/options aren't on screen/)).toBeInTheDocument()
    expect(screen.getByText(/needs your permission/)).toBeInTheDocument()
  })
})
