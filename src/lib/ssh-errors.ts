// Why an ssh pane couldn't start: main's spawn-plan errors, shared with the renderer so the
// pane can offer the action that fits (retry, fix the config, nothing) without parsing prose
// that could drift. Dependency-free: main imports it too.

export type SshFailure = "host-gone" | "no-ssh" | "wsl-down" | "not-here" | "other"

const WSL_DOWN_TAIL = ") didn't answer — try again once it's running"

export const SSH_ERRORS = {
  hostGone: "this host is no longer in your ssh config",
  noSsh: "ssh isn't installed (or isn't on PATH)",
  newerBuild: "this pane's host was saved by a newer smterm and can't be opened here",
  wslOffWindows: "WSL hosts can only be opened on Windows",
  cantBuild: "can't build the ssh command",
  /** A WSL distro that didn't answer in time. */
  wslDown: (distro: string) => `WSL (${distro}${WSL_DOWN_TAIL}`,
} as const

/** The failure kind for a spawn error message (as main wrote it). */
export function sshFailureKind(error: string): SshFailure {
  if (error.includes(SSH_ERRORS.hostGone)) return "host-gone"
  if (error.includes(SSH_ERRORS.noSsh)) return "no-ssh"
  if (error.includes(SSH_ERRORS.newerBuild) || error.includes(SSH_ERRORS.wslOffWindows)) {
    return "not-here"
  }
  if (error.startsWith("WSL (") && error.includes(WSL_DOWN_TAIL)) return "wsl-down"
  return "other"
}

/** Whether pressing Enter / Retry can ever succeed for this failure. */
export const canRetry = (kind: SshFailure): boolean => kind !== "not-here"
