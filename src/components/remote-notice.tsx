import type { RemoteRef } from "../types"

/** The panels' notice for a focused ssh session (its folders are on the host). */
export function RemoteNotice({ remote, what }: { remote: RemoteRef; what: string }) {
  return (
    <div className="diff-empty status-faint remote-notice">
      Remote session on <strong>{remote.label}</strong> — {what} for remote folders aren't available
      yet.
    </div>
  )
}
