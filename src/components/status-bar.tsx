import { useEffect, useRef, useState } from "react"
import { HardDrives, Bell, GitBranch } from "@phosphor-icons/react"
import { useStore } from "../store"
import { ipc } from "../lib/ipc"
import { applyUpdateResult, type UpdateStatus } from "../lib/version"

const clockNow = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })

/** Bottom status bar: platform · session counts · clock. Git branch is Track B. */
export function StatusBar() {
  const sessions = useStore((s) => s.sessions)
  const remotePhase = useStore((s) => s.remotePhase)
  // The pane you're driving never counts as waiting (the attention rule).
  const driving = useStore((s) =>
    s.windowFocused ? s.tabs.find((t) => t.id === s.activeTabId)?.activeSessionId : undefined,
  )
  const git = useStore((s) => s.git)
  const [platform, setPlatform] = useState("")
  const [clock, setClock] = useState(clockNow)
  const [version, setVersion] = useState("")
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const lastCheck = useRef(0)

  useEffect(() => {
    void ipc.platformInfo().then((info) => setPlatform(info.label))
    void ipc.appVersion().then(setVersion)
    // Apply only a SUCCESSFUL check (latest !== null). A failed re-check returns latest:null;
    // ignoring it keeps a real, still-valid update ping from vanishing on a transient offline blip.
    const check = () => {
      lastCheck.current = Date.now()
      void ipc.checkUpdate().then((r) => setUpdate((prev) => applyUpdateResult(prev, r)))
    }
    check()
    // Re-check on a slow interval, and when the window regains focus — the latter covers a
    // laptop that slept through the interval (timers drift across sleep). Throttled so focus
    // churn never hammers the API.
    const REFRESH = 6 * 60 * 60 * 1000
    const onFocus = () => {
      if (Date.now() - lastCheck.current > REFRESH) check()
    }
    const t = setInterval(check, REFRESH)
    window.addEventListener("focus", onFocus)
    return () => {
      clearInterval(t)
      window.removeEventListener("focus", onFocus)
    }
  }, [])

  useEffect(() => {
    const t = setInterval(() => setClock(clockNow()), 15_000)
    return () => clearInterval(t)
  }, [])

  const all = Object.values(sessions)
  const running = all.filter((s) => s.status === "working").length
  // Needs you: attention, or an ssh pane at a password / host-key prompt (same as the bell).
  const waiting = all.filter(
    (s) => s.status === "attention" || (remotePhase[s.id] === "prompt" && s.id !== driving),
  ).length

  return (
    <div className="statusbar">
      <span className="status-item">
        <HardDrives size={13} />
        {platform}
      </span>
      {git?.isRepo && git.branch && (
        <span className="status-item">
          <GitBranch size={13} color="var(--dim)" />
          {git.branch}
          {(git.ahead > 0 || git.behind > 0) && (
            <span className="status-faint">
              ↑{git.ahead} ↓{git.behind}
            </span>
          )}
        </span>
      )}
      <div className="status-spacer" />
      <span className="status-item">
        <span className={`dot accent${running ? " pulse" : ""}`} /> {running} running
      </span>
      <span className="status-item">
        <span className="dot amber" /> {waiting} waiting
      </span>
      <span className="status-item" style={{ color: waiting ? "var(--amber)" : undefined }}>
        <Bell size={13} weight={waiting ? "fill" : "regular"} color="currentColor" />
        {waiting}
      </span>
      <span className="status-faint">UTF-8</span>
      <span className="status-faint">{clock}</span>
      {version &&
        (update?.updateAvailable ? (
          // Update available: an accented, clickable ping → opens the release page.
          <button
            className="sb-version update"
            title={`Update available — v${update.latest} (you have v${version}). Click to view.`}
            onClick={() => ipc.openExternal(update.url)}
          >
            <span className="dot accent pulse" />v{update.latest}
          </button>
        ) : (
          <span className="sb-version status-faint" title={`minmux v${version}`}>
            minmux {version}
          </span>
        ))}
    </div>
  )
}
