import { describe, it, expect } from "vitest"
import { resolveDefaultShell, inheritShell } from "./shells"
import type { ShellOption } from "../types"

const zsh: ShellOption = { id: "z", label: "zsh", command: "/bin/zsh", args: [] }
const bash: ShellOption = { id: "b", label: "bash", command: "/bin/bash", args: [] }
const pwsh: ShellOption = {
  id: "powershell",
  label: "PowerShell",
  command: "powershell.exe",
  args: [],
}
const wsl: ShellOption = {
  id: "wsl:Ubuntu",
  label: "WSL: Ubuntu",
  command: "wsl.exe",
  args: ["-d", "Ubuntu"],
}

describe("resolveDefaultShell", () => {
  it("returns undefined when there are no shells", () => {
    expect(resolveDefaultShell([], "")).toBeUndefined()
  })
  it("falls back to the first (system) shell when no preference", () => {
    expect(resolveDefaultShell([zsh, bash], "")).toBe(zsh)
  })
  it("matches the preference by command path", () => {
    expect(resolveDefaultShell([zsh, bash], "/bin/bash")).toBe(bash)
  })
  it("matches the preference by id", () => {
    expect(resolveDefaultShell([zsh, bash], "b")).toBe(bash)
  })
  it("falls back to first when the preference is unavailable", () => {
    expect(resolveDefaultShell([zsh, bash], "/usr/bin/fish")).toBe(zsh)
  })
})

describe("inheritShell", () => {
  it("inherits the source pane's shell (WSL → WSL, not the list's first)", () => {
    // Windows ordering puts PowerShell first; splitting a WSL pane must stay WSL.
    expect(inheritShell([pwsh, wsl], { command: "wsl.exe", args: ["-d", "Ubuntu"] })).toBe(wsl)
  })

  it("matches on args too (different distro is a different shell)", () => {
    const wslDebian: ShellOption = { ...wsl, id: "wsl:Debian", args: ["-d", "Debian"] }
    expect(
      inheritShell([pwsh, wsl, wslDebian], { command: "wsl.exe", args: ["-d", "Debian"] }),
    ).toBe(wslDebian)
  })

  it("synthesizes an option when the source shell isn't in the list", () => {
    const r = inheritShell([pwsh], { command: "/opt/bin/fish", args: [] })
    expect(r).toMatchObject({ command: "/opt/bin/fish", label: "fish", args: [] })
  })

  it("returns undefined when there is no source pane", () => {
    expect(inheritShell([pwsh, wsl], undefined)).toBeUndefined()
  })
})

describe("inheritShell — ssh sessions", () => {
  const remote = { hostId: "native:gpu", label: "gpu", target: "gpu", env: "native" as const }

  it("keeps a remote source on its host, whatever the list holds", () => {
    const got = inheritShell([zsh], { command: "ssh", args: ["gpu"], remote })!
    expect(got).toEqual({ id: "native:gpu", label: "gpu", command: "ssh", args: ["gpu"], remote })
    expect(got.remote).not.toBe(remote)
  })

  it("leaves a local source local", () => {
    expect(inheritShell([zsh], { command: "/bin/zsh", args: [] })).toBe(zsh)
  })
})

describe("inheritShell — an unreadable saved host", () => {
  it("carries the saved original onto the split, so it isn't lost on the next save", () => {
    const remote = {
      hostId: "unavailable",
      label: "ssh",
      target: "unavailable",
      env: "native" as const,
    }
    const saved = { hostId: "wsl2:x:y", env: "new-kind" }
    expect(
      inheritShell([zsh], { command: "ssh", args: [], remote, remoteSaved: saved }),
    ).toMatchObject({
      remote,
      remoteSaved: saved,
    })
  })
})

describe("inheritShell — the remote folder", () => {
  it("a split of an ssh pane opens in the same remote folder", () => {
    const remote = { hostId: "native:web", label: "web", target: "web", env: "native" as const }
    expect(
      inheritShell([], { command: "ssh", args: [], remote, remoteCwd: "~/proj" }),
    ).toMatchObject({
      remote,
      remoteCwd: "~/proj",
    })
  })
})
