import { beforeEach, describe, expect, it } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import { IntegrationHint } from "./integration-hint"
import { useStore } from "../store"
import { resetStore, testHost, testShell } from "../test/helpers"
import { hostShellOption } from "../lib/ssh-hosts-ui"

const st = () => useStore.getState()

describe("IntegrationHint", () => {
  beforeEach(() => {
    resetStore()
    st().setShells([testShell])
    st().newTab(hostShellOption(testHost("dim0")))
    st().splitActive("row")
  })

  it("shows on the split it was raised for, and nowhere else", () => {
    const split = st().integrationHint!.sessionId
    const { container } = render(<IntegrationHint sessionId="someone-else" />)
    expect(container).toBeEmptyDOMElement()
    render(<IntegrationHint sessionId={split} />)
    expect(screen.getByRole("status").textContent).toContain(
      "Open splits of dim0 in the same folder?",
    )
  })

  it("Turn on → says when it takes effect; OK closes it", () => {
    render(<IntegrationHint sessionId={st().integrationHint!.sessionId} />)
    fireEvent.click(screen.getByText("Turn on"))
    expect(st().settings.ssh.integration).toEqual(["dim0"])
    expect(screen.getByRole("status").textContent).toContain("On for dim0 from its next connection")
    fireEvent.click(screen.getByText("OK"))
    expect(st().integrationHint).toBeNull()
  })

  it("Never writes !alias; Not now just closes it", () => {
    const { unmount } = render(<IntegrationHint sessionId={st().integrationHint!.sessionId} />)
    fireEvent.click(screen.getByText("Never"))
    expect(st().settings.ssh.integration).toEqual(["!dim0"])
    unmount()
    resetStore()
    st().setShells([testShell])
    st().newTab(hostShellOption(testHost("dim0")))
    st().splitActive("row")
    render(<IntegrationHint sessionId={st().integrationHint!.sessionId} />)
    fireEvent.click(screen.getByLabelText("Not now"))
    expect(st().integrationHint).toBeNull()
    expect(st().settings.ssh.integration).toEqual([])
  })
})
