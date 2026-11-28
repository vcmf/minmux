import { agentIcon } from "../components/agent-icon"
import type { RemotePane } from "../lib/remote-protocol"

/** What runs in a pane, as the desktop's sidebar shows it: the agent's mark in its session's
 *  colour, else a terminal (or, for ssh, a globe). */
export function PaneIcon({ pane, size = 18 }: { pane: RemotePane; size?: number }) {
  if (pane.agent) {
    const Icon = agentIcon(pane.agent)
    return (
      <span className="pane-icon" aria-hidden>
        <Icon size={size} color={pane.color ?? "var(--dim)"} />
      </span>
    )
  }
  return (
    <span className="pane-icon" aria-hidden>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="var(--dim)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {pane.kind === "ssh" ? (
          <path d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18" />
        ) : (
          <path d="M4 17l6-5-6-5M12 19h8" />
        )}
      </svg>
    </span>
  )
}
