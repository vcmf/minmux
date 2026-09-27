import { describe, it, expect, beforeEach, vi } from "vitest"
import { render, screen, fireEvent } from "@testing-library/react"
import { SettingsPanel } from "./settings-panel"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { resetStore } from "../test/helpers"

const st = () => useStore.getState()

beforeEach(() => {
  resetStore()
  vi.clearAllMocks()
})

describe("SettingsPanel", () => {
  it("renders a card per theme family, the current one checked", () => {
    render(<SettingsPanel />)
    expect(screen.getByText("Settings")).toBeInTheDocument()
    for (const name of ["Minimal", "Tokyo Night", "Catppuccin", "Gruvbox"]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument()
    }
    expect(screen.getByRole("radio", { name: "Minimal" })).toHaveAttribute("aria-checked", "true")
  })

  it("cards preview the variant for the current appearance", () => {
    render(<SettingsPanel />)
    expect(screen.getByText("Mocha")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("radio", { name: /Light/ }))
    expect(st().settings.appearance).toBe("light")
    expect(screen.getByText("Latte")).toBeInTheDocument()
    expect(ipc.writeSettings).toHaveBeenCalled()
  })

  it("System follows the OS preference", () => {
    st().setSystemDark(false)
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole("radio", { name: /System/ }))
    expect(st().settings.appearance).toBe("system")
    expect(screen.getByText("Day")).toBeInTheDocument()
  })

  it("editing the font size updates the store and persists", () => {
    render(<SettingsPanel />)
    fireEvent.change(screen.getByLabelText("Font size"), { target: { value: "18" } })
    expect(st().settings.font.size).toBe(18)
    expect(ipc.writeSettings).toHaveBeenCalled()
  })

  it("clicking a theme card selects that family (appearance kept)", () => {
    st().setSettings({ ...st().settings, appearance: "light" })
    render(<SettingsPanel />)
    fireEvent.click(screen.getByRole("radio", { name: "Gruvbox" }))
    expect(st().settings.theme).toBe("gruvbox")
    expect(st().settings.appearance).toBe("light")
  })

  it("choosing a default shell persists it", () => {
    render(<SettingsPanel />)
    fireEvent.change(screen.getByLabelText("Default shell"), { target: { value: "/bin/sh" } })
    expect(st().settings.defaultShell).toBe("/bin/sh")
  })

  it("the close button dismisses the panel", () => {
    st().setSettingsOpen(true)
    render(<SettingsPanel />)
    fireEvent.click(screen.getByTitle("Close"))
    expect(st().settingsOpen).toBe(false)
  })
})

describe("SettingsPanel — SSH", () => {
  it("edits the restore mode and keepalive through the validated settings", () => {
    render(<SettingsPanel />)
    fireEvent.change(screen.getByLabelText("Reconnect on launch"), {
      target: { value: "on-focus" },
    })
    expect(st().settings.ssh.restore).toBe("on-focus")
    const keepAlive = screen.getByLabelText("Keepalive (seconds, 0 = off)")
    fireEvent.change(keepAlive, { target: { value: "99999" } })
    expect(st().settings.ssh.keepAliveSeconds).toBe(30) // not saved per keystroke
    fireEvent.blur(keepAlive)
    expect(st().settings.ssh.keepAliveSeconds).toBe(3600) // clamped by the schema
    expect(ipc.writeSettings).toHaveBeenCalled()
  })

  it("an emptied keepalive field isn't saved as 0 (off)", () => {
    render(<SettingsPanel />)
    const keepAlive = screen.getByLabelText("Keepalive (seconds, 0 = off)") as HTMLInputElement
    fireEvent.change(keepAlive, { target: { value: "" } })
    fireEvent.blur(keepAlive)
    expect(st().settings.ssh.keepAliveSeconds).toBe(30)
    expect(keepAlive.value).toBe("30")
    fireEvent.change(keepAlive, { target: { value: "60" } })
    fireEvent.keyDown(keepAlive, { key: "Enter" })
    expect(st().settings.ssh.keepAliveSeconds).toBe(60)
  })
})
