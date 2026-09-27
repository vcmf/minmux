import { X } from "@phosphor-icons/react"
import { useStore } from "../store"
import { openSettingsFile, settingsPath } from "../settings/io"
import { mergeSettings } from "../settings/schema"
import type { Settings } from "../settings/schema"
import { useEffect, useState } from "react"
import { ThemePicker } from "./theme-picker"

export function SettingsPanel() {
  const settings = useStore((s) => s.settings)
  const shells = useStore((s) => s.shells)
  const [path, setPath] = useState("")

  useEffect(() => {
    void settingsPath().then(setPath)
  }, [])

  // Validate/clamp edits through the same merge used for the file, then persist.
  const update = (next: Settings) => useStore.getState().updateSettings(next)
  const font = (patch: Partial<Settings["font"]>) =>
    update({ ...settings, font: { ...settings.font, ...patch } })

  const close = () => useStore.getState().setSettingsOpen(false)

  return (
    <div className="settings-overlay" onMouseDown={close}>
      <div className="settings-panel" onMouseDown={(e) => e.stopPropagation()}>
        <div className="settings-header">
          <h2>Settings</h2>
          <button className="iconbtn" title="Close" onClick={close}>
            <X size={16} />
          </button>
        </div>

        <h3 className="settings-section">Appearance</h3>
        <ThemePicker />

        <h3 className="settings-section">Terminal</h3>
        <label className="settings-row">
          <span>Font family</span>
          <input value={settings.font.family} onChange={(e) => font({ family: e.target.value })} />
        </label>

        <label className="settings-row">
          <span>Font size</span>
          <input
            type="number"
            min={6}
            max={72}
            value={settings.font.size}
            onChange={(e) => font({ size: Number(e.target.value) })}
          />
        </label>

        <label className="settings-row">
          <span>Line height</span>
          <input
            type="number"
            step={0.1}
            min={1}
            max={3}
            value={settings.font.lineHeight}
            onChange={(e) => font({ lineHeight: Number(e.target.value) })}
          />
        </label>

        <label className="settings-row">
          <span>Ligatures</span>
          <input
            type="checkbox"
            checked={settings.font.ligatures}
            onChange={(e) => font({ ligatures: e.target.checked })}
          />
        </label>

        <label className="settings-row">
          <span>GPU acceleration</span>
          <select
            value={settings.renderer}
            onChange={(e) =>
              update({
                ...settings,
                renderer: mergeSettings({ renderer: e.target.value }).renderer,
              })
            }
          >
            <option value="webgl">WebGL (GPU-accelerated — recommended)</option>
            <option value="dom">Off (DOM — no GPU, always correct)</option>
          </select>
        </label>

        <label className="settings-row">
          <span>Default shell</span>
          <select
            value={settings.defaultShell}
            onChange={(e) => update({ ...settings, defaultShell: e.target.value })}
          >
            <option value="">System default</option>
            {shells.map((sh) => (
              <option key={sh.id} value={sh.command}>
                {sh.label}
              </option>
            ))}
          </select>
        </label>

        <label className="settings-row">
          <span>Cursor blink</span>
          <input
            type="checkbox"
            checked={settings.cursorBlink}
            onChange={(e) => update({ ...settings, cursorBlink: e.target.checked })}
          />
        </label>

        <label className="settings-row">
          <span>Confirm before quit</span>
          <input
            type="checkbox"
            checked={settings.confirmQuit}
            onChange={(e) => update({ ...settings, confirmQuit: e.target.checked })}
          />
        </label>

        <label className="settings-row">
          <span>Scrollback</span>
          <input
            type="number"
            min={0}
            max={100000}
            value={settings.scrollback}
            onChange={(e) => update({ ...settings, scrollback: Number(e.target.value) })}
          />
        </label>

        <h3 className="settings-section">SSH</h3>
        <label className="settings-row">
          <span>Reconnect on launch</span>
          <select
            value={settings.ssh.restore}
            onChange={(e) =>
              update({
                ...settings,
                ssh: { ...settings.ssh, restore: e.target.value as Settings["ssh"]["restore"] },
              })
            }
          >
            <option value="auto">Right away</option>
            <option value="on-focus">When I press Enter</option>
          </select>
        </label>

        <label className="settings-row">
          <span>Keepalive (seconds, 0 = off)</span>
          <KeepAliveInput
            value={settings.ssh.keepAliveSeconds}
            onCommit={(n) => update({ ...settings, ssh: { ...settings.ssh, keepAliveSeconds: n } })}
          />
        </label>

        <div className="settings-footer">
          <button className="btn" onClick={() => void openSettingsFile(settings)}>
            Open settings.json
          </button>
          {path && <code className="settings-path">{path}</code>}
        </div>
      </div>
    </div>
  )
}

/** Keepalive seconds, saved on blur or Enter — not per keystroke (an emptied field would
 *  save 0 = off, and every key would rewrite settings.json). */
function KeepAliveInput({ value, onCommit }: { value: number; onCommit: (n: number) => void }) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])
  const commit = () => {
    const n = Number(draft)
    if (draft.trim() === "" || !Number.isFinite(n)) return setDraft(String(value)) // keep it
    if (n !== value) onCommit(n)
    else setDraft(String(value))
  }
  return (
    <input
      type="number"
      min={0}
      max={3600}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && commit()}
    />
  )
}
