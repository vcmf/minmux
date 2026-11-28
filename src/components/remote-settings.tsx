import { useEffect, useMemo, useState } from "react"
import qrcode from "qrcode-generator"
import { ipc } from "../lib/ipc"
import type { Permission } from "../lib/remote-protocol"
import type { RemoteView } from "../lib/remote-view"
import { useStore } from "../store"

/** Why remote control isn't listening, in words. */
function remoteProblem(view: RemoteView): string | null {
  const s = view.status
  if (s.state !== "error") return null
  switch (s.reason) {
    case "missing":
      return "Tailscale isn't installed. Install it on this computer and on your phone, signed in to the same account."
    case "signed-out":
      return "Tailscale is signed out. Sign in, then this starts by itself."
    case "stopped":
      return "Tailscale isn't connected. Connect it, then this starts by itself."
    case "tagged":
      return "This computer is a tagged device on your tailnet, so its owner can't be told apart from other tagged devices. Remote control stays off here."
    case "port":
      return `Port ${view.port} is already in use. Pick another in settings.json (remote.port).`
    default:
      return `Remote control stopped: ${s.detail ?? "unknown error"}. It retries every 30 seconds.`
  }
}

const ago = (t: number) => {
  const m = Math.round((Date.now() - t) / 60_000)
  if (m < 1) return "now"
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

/** The QR of the address (no secret in it). */
function QrCode({ text }: { text: string }) {
  const src = useMemo(() => {
    const qr = qrcode(0, "M")
    qr.addData(text)
    qr.make()
    return qr.createDataURL(4, 2)
  }, [text])
  return (
    <img className="remote-qr" src={src} alt={`QR code for ${text}`} width={164} height={164} />
  )
}

/** Settings → Remote control (docs/design/REMOTE_CONTROL.md). */
export function RemoteSettings() {
  const settings = useStore((s) => s.settings)
  const [view, setView] = useState<RemoteView | null>(null)
  const [pin, setPin] = useState("")
  const [pinNote, setPinNote] = useState("")
  const [showQr, setShowQr] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    let live = true
    const load = () => void ipc.remoteView().then((v) => live && setView(v))
    load()
    const off = ipc.onRemoteChanged(load)
    return () => {
      live = false
      off()
    }
  }, [settings.remote.enabled, settings.remote.port])

  const toggle = (enabled: boolean) =>
    useStore.getState().updateSettings({ ...settings, remote: { ...settings.remote, enabled } })

  const savePin = async () => {
    const r = await ipc.remoteSetPin(pin)
    setPinNote(
      r === "ok"
        ? "PIN saved."
        : r === "invalid"
          ? "Use 6 to 32 digits."
          : r === "readonly"
            ? "A newer minmux saved the device list: the PIN can't be changed here."
            : "The PIN couldn't be saved.",
    )
    if (r === "ok") setPin("")
  }

  const status = view?.status
  const url = status?.state === "listening" ? status.url : null
  const problem = view ? remoteProblem(view) : null
  const connected = new Set(view?.clients.map((c) => c.deviceId))

  return (
    <>
      <h3 className="settings-section">Remote control</h3>
      <label className="settings-row">
        <span title="Use minmux from your phone's browser or from minmux on another computer, over your Tailscale network. Only your own devices, and only ones you approve here, can connect.">
          Allow my devices to control minmux
        </span>
        <input
          type="checkbox"
          checked={settings.remote.enabled}
          onChange={(e) => toggle(e.target.checked)}
        />
      </label>

      {settings.remote.enabled && (
        <div className="remote-settings">
          {status?.state === "starting" && <p className="remote-note">Starting…</p>}
          {problem && <p className="remote-note warn">{problem}</p>}
          {view?.newerFile && (
            <p className="remote-note warn">
              A newer minmux saved the device list. Devices can't be added or changed here.
            </p>
          )}
          {url && (
            <div className="remote-address">
              <span>Open on your phone:</span>
              <code>{url}</code>
              <button
                className="btn"
                onClick={() => {
                  void navigator.clipboard.writeText(url).then(() => {
                    setCopied(true)
                    setTimeout(() => setCopied(false), 1500)
                  })
                }}
              >
                {copied ? "Copied" : "Copy"}
              </button>
              <button className="btn" onClick={() => setShowQr((v) => !v)}>
                {showQr ? "Hide QR code" : "QR code"}
              </button>
              {showQr && <QrCode text={url} />}
              <p className="remote-note">
                The phone needs Tailscale on, signed in to your account. The first time, this
                computer asks you to approve it.
              </p>
            </div>
          )}

          <label className="settings-row">
            <span title="A device unused for 24 hours is locked. Its owner can unlock it from the device with this PIN, without coming back to this computer. Without a PIN, it has to be approved here again.">
              PIN for locked devices{" "}
              {view && (
                <em className="remote-dim">
                  {view.pinUnlockOff
                    ? "(off after too many wrong PINs: set a new one)"
                    : view.hasPin
                      ? "(set)"
                      : "(not set)"}
                </em>
              )}
            </span>
            <span className="remote-pin">
              <input
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                placeholder="6+ digits"
                value={pin}
                onChange={(e) => {
                  setPin(e.target.value.replace(/\D/g, "").slice(0, 32))
                  setPinNote("")
                }}
                onKeyDown={(e) => e.key === "Enter" && void savePin()}
              />
              <button className="btn" disabled={pin.length < 6} onClick={() => void savePin()}>
                {view?.hasPin ? "Change" : "Set"}
              </button>
            </span>
          </label>
          {pinNote && <p className="remote-note">{pinNote}</p>}

          <div className="remote-devices">
            <div className="remote-devices-head">
              <span>Devices</span>
              {!!view?.clients.length && (
                <button className="btn" onClick={() => void ipc.remoteDisconnectAll()}>
                  Disconnect all
                </button>
              )}
            </div>
            {view && view.devices.length === 0 && (
              <p className="remote-note">No device approved yet.</p>
            )}
            {view?.devices.map((d) => (
              <div className="remote-device" key={d.id}>
                <span className={`dot ${connected.has(d.id) ? "accent" : "faint"}`} />
                <span className="remote-device-name" title={`Approved ${ago(d.addedAt)}`}>
                  {d.name}
                </span>
                <span className="remote-dim">
                  {connected.has(d.id) ? "connected" : d.locked ? "locked" : ago(d.lastSeen)}
                </span>
                <select
                  value={d.permission}
                  onChange={(e) => void ipc.remotePermission(d.id, e.target.value as Permission)}
                >
                  <option value="view">View only</option>
                  <option value="send">View and send</option>
                  <option value="keys">Full (raw keys)</option>
                </select>
                <button className="btn" onClick={() => void ipc.remoteRevoke(d.id)}>
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}
