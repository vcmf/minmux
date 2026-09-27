import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  MagnifyingGlass,
  Plus,
  Columns,
  Rows,
  SquaresFour,
  Palette,
  GearSix,
  FileText,
  Terminal,
  Sun,
  Moon,
  CircleHalf,
  Globe,
  X,
} from "@phosphor-icons/react"
import { useStore } from "../store"
import { THEME_FAMILIES } from "../settings/themes"
import { openSettingsFile } from "../settings/io"
import { resolveDefaultShell } from "../lib/shells"
import { newSurfaceKey } from "../lib/platform"
import { ipc } from "../lib/ipc"
import { envTitle, hostShellOption } from "../lib/ssh-hosts-ui"

interface Command {
  group: string
  label: string
  sub?: string
  icon: ReactNode
  run: () => void
}

/** ⌘K command palette — spawn/split/switch/theme/settings over real state. */
export function CommandPalette() {
  const shells = useStore((s) => s.shells)
  const sshHosts = useStore((s) => s.sshHosts)
  const tabs = useStore((s) => s.tabs)
  const activeTabId = useStore((s) => s.activeTabId)
  const settings = useStore((s) => s.settings)
  const [query, setQuery] = useState("")
  const [sel, setSel] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const close = () => useStore.getState().setPaletteOpen(false)

  const commands = useMemo<Command[]>(() => {
    const store = useStore.getState()
    const shell = resolveDefaultShell(shells, settings.defaultShell)
    const list: Command[] = []

    if (shell) {
      list.push({
        group: "Session",
        label: "New session",
        sub: `${shell.label} (default)`,
        icon: <Plus size={16} />,
        run: () => store.newTab(shell),
      })
      for (const sh of shells) {
        if (sh.id === shell.id) continue
        list.push({
          group: "Session",
          label: "New session",
          sub: sh.label,
          icon: <Plus size={16} />,
          run: () => store.newTab(sh),
        })
      }
      list.push(
        {
          group: "Session",
          label: "New terminal in pane",
          sub: newSurfaceKey,
          icon: <Terminal size={16} />,
          run: () => store.newSurface(shell),
        },
        {
          group: "Session",
          label: "Split pane right",
          icon: <Columns size={16} />,
          run: () => store.splitActive("row", shell),
        },
        {
          group: "Session",
          label: "Split pane down",
          icon: <Rows size={16} />,
          run: () => store.splitActive("column", shell),
        },
      )
    }

    for (const h of sshHosts) {
      const where =
        h.env === "native" ? h.detail : [envTitle(h.env), h.detail].filter(Boolean).join(" · ")
      const sub = where ? `${h.label} · ${where}` : h.label
      list.push(
        {
          group: "SSH",
          label: "Connect to host",
          sub,
          icon: <Globe size={16} />,
          run: () => store.newTab(hostShellOption(h)),
        },
        {
          group: "SSH",
          label: "Split right on host",
          sub,
          icon: <Columns size={16} />,
          run: () => store.splitWith("row", hostShellOption(h)),
        },
      )
    }
    list.push({
      group: "SSH",
      label: "Open ssh config",
      sub: "~/.ssh/config",
      icon: <FileText size={16} />,
      run: () => ipc.openSshConfig(),
    })

    for (const tab of tabs) {
      if (tab.id === activeTabId) continue
      list.push({
        group: "Navigate",
        label: "Switch session",
        sub: tab.title,
        icon: <SquaresFour size={16} />,
        run: () => store.setActiveTab(tab.id),
      })
    }

    for (const family of Object.values(THEME_FAMILIES)) {
      if (family.name === settings.theme) continue
      list.push({
        group: "Appearance",
        label: "Theme",
        sub: family.label,
        icon: <Palette size={16} />,
        run: () => store.updateSettings({ ...settings, theme: family.name }),
      })
    }
    for (const a of ["dark", "light", "system"] as const) {
      if (a === settings.appearance) continue
      list.push({
        group: "Appearance",
        label: "Appearance",
        sub: a === "system" ? "System (follow the OS)" : a === "dark" ? "Dark" : "Light",
        icon:
          a === "light" ? (
            <Sun size={16} />
          ) : a === "dark" ? (
            <Moon size={16} />
          ) : (
            <CircleHalf size={16} />
          ),
        run: () => store.updateSettings({ ...settings, appearance: a }),
      })
    }

    list.push(
      {
        group: "App",
        label: "Open settings",
        icon: <GearSix size={16} />,
        run: () => store.setSettingsOpen(true),
      },
      {
        group: "App",
        label: "Edit settings.json",
        icon: <FileText size={16} />,
        run: () => void openSettingsFile(settings),
      },
    )
    return list
  }, [shells, sshHosts, tabs, activeTabId, settings])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => `${c.group} ${c.label} ${c.sub ?? ""}`.toLowerCase().includes(q))
  }, [commands, query])

  useEffect(() => setSel(0), [query])
  useEffect(() => inputRef.current?.focus(), [])

  const runAt = (i: number) => {
    const cmd = filtered[i]
    if (!cmd) return
    close()
    cmd.run()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault()
      setSel((s) => Math.min(s + 1, filtered.length - 1))
    } else if (e.key === "ArrowUp") {
      e.preventDefault()
      setSel((s) => Math.max(s - 1, 0))
    } else if (e.key === "Enter") {
      e.preventDefault()
      runAt(sel)
    } else if (e.key === "Escape") {
      e.preventDefault()
      close()
    }
  }

  // Render items with group headers, tracking a flat index for selection.
  let idx = -1
  let lastGroup = ""

  return (
    <div className="palette-overlay" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input-row">
          <MagnifyingGlass size={16} />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Run a command, spawn a session, switch tab…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-results">
          {filtered.length === 0 && (
            <div className="palette-item" style={{ color: "var(--faint)" }}>
              <X size={16} /> No matching commands
            </div>
          )}
          {filtered.map((cmd) => {
            idx += 1
            const i = idx
            const header = cmd.group !== lastGroup ? cmd.group : null
            lastGroup = cmd.group
            return (
              <div key={i}>
                {header && <div className="palette-group">{header}</div>}
                <div
                  className={`palette-item${i === sel ? " selected" : ""}`}
                  onMouseEnter={() => setSel(i)}
                  onMouseDown={() => runAt(i)}
                >
                  {cmd.icon}
                  <span>{cmd.label}</span>
                  {cmd.sub && <span className="sub">· {cmd.sub}</span>}
                  {i === sel && <span className="palette-enter">⏎</span>}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
