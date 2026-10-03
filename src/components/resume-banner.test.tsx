import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { ResumeBanner } from "./resume-banner"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore, testShell } from "../test/helpers"
import { TerminalManager } from "../terminal/terminal-manager"
import type { ResumePlan, ResumeState } from "../lib/resume"

vi.mock("../terminal/terminal-manager", () => ({
  TerminalManager: {
    resumeNow: vi.fn(() => true),
    resumeSettled: vi.fn(),
    runCommand: vi.fn(() => true),
    focus: vi.fn(),
    dispose: vi.fn(),
  },
}))

const st = () => useStore.getState()
const plan: ResumePlan = {
  status: "resume",
  sessionId: "7fe87f63-8ccf-437e-b991-94aa4ee44a0e",
  cwd: "/repo",
  name: "fix-login",
  command: "claude --resume 7fe87f63-8ccf-437e-b991-94aa4ee44a0e",
}
let id = ""
const show = (state: ResumeState) => {
  st().setResume(id, state)
  return render(<ResumeBanner sessionId={id} />)
}

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
  st().newTab(testShell)
  id = st().tabs[0]!.activeSessionId
})

describe("ResumeBanner", () => {
  it("nothing when there's no resume for the pane", () => {
    const { container } = render(<ResumeBanner sessionId={id} />)
    expect(container).toBeEmptyDOMElement()
  })

  it("resuming → names the session (its /rename)", () => {
    show({ phase: "resuming", plan })
    expect(screen.getByRole("status")).toHaveTextContent("Resuming Claude session fix-login")
  })

  it("failed: shows the exit code; Retry re-types it, Pick opens claude's picker", () => {
    show({ phase: "failed", plan, exitCode: 1 })
    expect(screen.getByRole("alert")).toHaveTextContent("claude exited 1")
    fireEvent.click(screen.getByText("Retry"))
    expect(TerminalManager.resumeNow).toHaveBeenCalledWith(id)
    fireEvent.click(screen.getByText("Pick a session…"))
    // the picker is keyed by project dir → cd into the session's cwd first (POSIX shell)
    expect(TerminalManager.runCommand).toHaveBeenCalledWith(id, "cd -- '/repo' && claude --resume")
    expect(st().resume[id]).toBeUndefined()
  })

  it("skipped (transcript gone): explains why; Start Claude here runs a fresh claude", () => {
    show({ phase: "skipped", plan: { ...plan, status: "skip", reason: "its transcript is gone" } })
    expect(screen.getByRole("alert")).toHaveTextContent("its transcript is gone")
    fireEvent.click(screen.getByText("Start Claude here"))
    expect(TerminalManager.runCommand).toHaveBeenCalledWith(id, "claude")
  })

  it("ask mode: Resume types it; Dismiss forgets it for good", () => {
    show({ phase: "offer", plan })
    fireEvent.click(screen.getByText("Resume"))
    expect(TerminalManager.resumeNow).toHaveBeenCalledWith(id)
    fireEvent.click(screen.getByText("Dismiss"))
    expect(ipc.resumeConsume).toHaveBeenCalledWith(id, plan.sessionId)
    expect(st().resume[id]).toBeUndefined()
  })

  it("an unnamed session is labelled by its id's first block", () => {
    show({ phase: "resuming", plan: { ...plan, name: undefined } })
    expect(screen.getByRole("status")).toHaveTextContent("7fe87f63")
  })

  it("while a program runs in the pane, the typing buttons are disabled (Dismiss isn't)", () => {
    st().signalSession(id, { type: "command-start" }) // e.g. the user already started claude
    show({ phase: "failed", plan, exitCode: 1 })
    expect(screen.getByText("Retry")).toBeDisabled()
    expect(screen.getByText("Pick a session…")).toBeDisabled()
    expect(screen.getByText("Dismiss")).not.toBeDisabled()
  })

  it("Resume before the shell's first prompt says it's waiting instead of doing nothing", () => {
    vi.mocked(TerminalManager.resumeNow).mockReturnValueOnce(false)
    show({ phase: "offer", plan })
    fireEvent.click(screen.getByText("Resume"))
    expect(screen.getByText("Waiting for the prompt…")).toBeInTheDocument()
  })

  it("'sent' (a shell that can't confirm): just says so — no buttons that would type", () => {
    show({ phase: "sent", plan })
    expect(screen.getByRole("status")).toHaveTextContent("can't confirm")
    expect(screen.queryByText("Retry")).not.toBeInTheDocument()
    expect(screen.getByText("Dismiss")).toBeInTheDocument()
  })

  it("'Start Claude here' before the first prompt says it's waiting", () => {
    vi.mocked(TerminalManager.runCommand).mockReturnValueOnce(false)
    show({ phase: "skipped", plan: { ...plan, status: "skip", reason: "its transcript is gone" } })
    fireEvent.click(screen.getByText("Start Claude here"))
    expect(screen.getByText("Waiting for the prompt…")).toBeInTheDocument()
  })
})

describe("ResumeBanner — waiting (still running, unconfirmed)", () => {
  it("Codex: says it confirms with the first message; Dismiss only closes", () => {
    show({ phase: "waiting", plan: { ...plan, agent: "codex", command: "codex resume x" } })
    expect(screen.getByRole("status")).toHaveTextContent(
      "Resuming Codex session fix-login… Codex confirms when you send a message",
    )
    fireEvent.click(screen.getByText("Dismiss"))
    expect(st().resume[id]).toBeUndefined()
    expect(ipc.resumeConsume).not.toHaveBeenCalled() // the entry stays for next time
  })

  it("an agent that confirms on its own: it may be on a screen of its own", () => {
    show({ phase: "waiting", plan })
    expect(screen.getByRole("status")).toHaveTextContent(
      "Claude hasn't confirmed yet: it may be showing a screen of its own",
    )
  })
})

describe("ResumeBanner — OpenCode", () => {
  it("waiting: confirms with a message — no hooks to approve (that's Codex's)", () => {
    show({
      phase: "waiting",
      plan: { ...plan, agent: "opencode", command: "opencode --session x" },
    })
    const text = screen.getByRole("status").textContent
    expect(text).toContain("OpenCode confirms when you send a message.")
    expect(text).not.toContain("hooks")
  })

  const oc: ResumePlan = {
    agent: "opencode",
    status: "resume",
    sessionId: "ses_f02cfead3ffecevT8eQkttqOR5",
    cwd: "/repo",
    command: "opencode --session ses_f02cfead3ffecevT8eQkttqOR5",
  }
  it("an unnamed session is labelled by its id's start; its picker is the TUI's /sessions", () => {
    show({ phase: "failed", plan: oc, exitCode: 1 })
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn't resume ses_f02cfead (opencode exited 1)",
    )
    fireEvent.click(screen.getByText("Open OpenCode (/sessions)"))
    expect(TerminalManager.runCommand).toHaveBeenCalledWith(id, "cd -- '/repo' && opencode")
  })
})
