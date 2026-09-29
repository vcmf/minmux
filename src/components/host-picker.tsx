import { useEffect, useMemo, useRef, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { Globe, MagnifyingGlass, PushPin, X } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { connectedHostIds, envTitle, hostColor, hostColorCss } from "../lib/ssh-hosts-ui"
import {
  filterHosts,
  hiddenHosts,
  hostMenuItems,
  hostSections,
  visibleHosts,
  type HostActionId,
} from "../lib/ssh-host-list"
import type { SshHost } from "../types"
import { ContextMenu } from "./context-menu"
import { integrationOn } from "../lib/ssh-integration"
import { runHostAction } from "../lib/ssh-host-actions"

/** "Connect to host": the saved hosts, host first. ⏎ new tab · ⌥⏎ split right · ⇧⏎ down. */
export function HostPicker() {
  const hosts = useStore((s) => s.sshHosts)
  const loaded = useStore((s) => s.sshHostsLoaded)
  const pinned = useStore((s) => s.settings.ssh.pinned)
  const integration = useStore((s) => s.settings.ssh.integration)
  const mode = useStore((s) => s.settings.ssh.integrationMode)
  const colors = useStore((s) => s.settings.ssh.colors)
  const recent = useStore((s) => s.sshRecent)
  const connected = useStore(useShallow((s) => connectedHostIds(s.sessions, s.remotePhase)))
  const [query, setQuery] = useState("")
  const [selId, setSelId] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; host: SshHost } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const sections = useMemo(
    () =>
      query.trim()
        ? [{ title: "Matches" as const, hosts: filterHosts(visibleHosts(hosts), query) }]
        : hostSections(hosts, { pinned, recent }),
    [hosts, pinned, recent, query],
  )
  const flat = useMemo(() => sections.flatMap((s) => s.hosts), [sections])
  const hidden = useMemo(() => hiddenHosts(hosts), [hosts])
  // Selection by host id, not index: the list can change under an open picker.
  const found = selId === null ? -1 : flat.findIndex((h) => h.hostId === selId)
  const sel = found === -1 ? 0 : found

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setSelId(null), [query])

  const close = () => useStore.getState().setHostPickerOpen(false)
  const open = (h: SshHost | undefined, how: "tab" | "row" | "column") => {
    if (!h) return
    close()
    useStore.getState().openHost(h, how)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      const next = Math.max(0, Math.min(flat.length - 1, sel + (e.key === "ArrowDown" ? 1 : -1)))
      if (flat[next]) setSelId(flat[next].hostId)
    } else if (e.key === "Enter") {
      e.preventDefault()
      open(flat[sel], e.altKey ? "row" : e.shiftKey ? "column" : "tab")
    } else if (e.key === "Escape") {
      e.preventDefault()
      close()
    }
  }

  let i = -1
  return (
    <div className="palette-overlay" onMouseDown={close}>
      <div className="palette host-picker" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input-row">
          <MagnifyingGlass size={16} />
          <input
            ref={inputRef}
            className="palette-input"
            placeholder="Connect to host…"
            aria-label="Connect to host"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <span className="kbd">esc</span>
        </div>
        <div className="palette-results">
          {loaded && visibleHosts(hosts).length === 0 && hidden.length > 0 && (
            <div className="host-picker-empty">
              <p>All your hosts are hidden. Show one from “Hidden ({hidden.length})” below.</p>
            </div>
          )}
          {loaded && hosts.length === 0 && (
            <div className="host-picker-empty">
              <p>
                No hosts yet. minmux lists the <code>Host</code> entries in ~/.ssh/config (and in
                each running WSL distro&apos;s); add one there and it appears as you save.
              </p>
              <button className="remote-empty-btn" onClick={() => ipc.openSshConfig()}>
                Open ssh config
              </button>
            </div>
          )}
          {query.trim() && flat.length === 0 && visibleHosts(hosts).length > 0 && (
            <div className="palette-item" style={{ color: "var(--faint)" }}>
              <X size={16} /> No matching hosts
            </div>
          )}
          {sections.map((sec) => (
            <div key={sec.title}>
              {sec.hosts.length > 0 && <div className="palette-group">{sec.title}</div>}
              {sec.hosts.map((h) => {
                i += 1
                const idx = i
                const c = hostColor(h.target, colors)
                return (
                  <div
                    key={h.hostId}
                    role="option"
                    aria-selected={idx === sel}
                    className={`palette-item host-picker-row${idx === sel ? " selected" : ""}`}
                    onMouseEnter={() => setSelId(h.hostId)}
                    onMouseDown={(e) => {
                      if (e.button !== 0) return
                      open(h, e.altKey ? "row" : e.shiftKey ? "column" : "tab")
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setMenu({ x: e.clientX, y: e.clientY, host: h })
                    }}
                  >
                    <Globe size={16} color={c ? hostColorCss(c) : undefined} />
                    <span className="host-picker-name">{h.label}</span>
                    {h.detail && <span className="sub">{h.detail}</span>}
                    {h.env !== "native" && (
                      <span className="host-picker-env">{envTitle(h.env)}</span>
                    )}
                    <span className="host-picker-marks">
                      {pinned.includes(h.hostId) && <PushPin size={12} aria-label="Pinned" />}
                      {connected.includes(h.hostId) && (
                        <span className="dot accent" title="Connected" />
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
          {showHidden &&
            hidden.map((h) => (
              <div key={h.hostId} className="palette-item host-picker-hidden">
                <Globe size={16} />
                <span className="host-picker-name">{h.label}</span>
                {h.detail && <span className="sub">{h.detail}</span>}
                <button
                  className="remote-empty-btn"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={() => useStore.getState().setHostHidden(h.label, false)}
                >
                  Show
                </button>
              </div>
            ))}
        </div>
        <div className="host-picker-footer">
          <span>⏎ new tab · ⌥⏎ split right · ⇧⏎ split down · right-click for more</span>
          {hidden.length > 0 && (
            <button className="host-picker-link" onClick={() => setShowHidden((v) => !v)}>
              {showHidden ? "Hide hidden" : `Hidden (${hidden.length})`}
            </button>
          )}
          <button className="host-picker-link" onClick={() => ipc.openSshConfig()}>
            Open ssh config
          </button>
        </div>
        {menu && (
          <ContextMenu<HostActionId>
            x={menu.x}
            y={menu.y}
            items={hostMenuItems({
              pinned: pinned.includes(menu.host.hostId),
              native: menu.host.env === "native",
              integration:
                mode === "off" ? null : integrationOn(menu.host.label, integration, mode),
            })}
            onSelect={(id) => {
              if (id === "open" || id === "splitRight" || id === "splitDown") close()
              runHostAction(menu.host, id)
            }}
            onClose={() => {
              setMenu(null)
              inputRef.current?.focus() // keep typing into the filter after a menu action
            }}
          />
        )}
      </div>
    </div>
  )
}
