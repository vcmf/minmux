import type { RemoteRef, ShellOption } from "../types"

/** The shell a new tab/split should use: the configured default (matched by
 *  command path or id) if available, else the system default (first listed). */
export function resolveDefaultShell(shells: ShellOption[], pref: string): ShellOption | undefined {
  if (pref) {
    const match = shells.find((s) => s.command === pref || s.id === pref)
    if (match) return match
  }
  return shells[0]
}

/** The shell a split should use: inherit the SOURCE pane's shell, so splitting stays
 *  the same shell you split from (WSL → WSL) rather than the list's first entry
 *  (which on Windows is PowerShell). Matched against the available list for a proper
 *  label; synthesized from the source if not listed. Undefined when there's no source. */
export function inheritShell(
  shells: ShellOption[],
  src:
    | {
        command: string
        args: string[]
        remote?: RemoteRef
        remoteSaved?: unknown
        remoteCwd?: string
      }
    | undefined,
): ShellOption | undefined {
  if (!src) return undefined
  // An ssh session's splits/surfaces stay on its host.
  if (src.remote) {
    const r = src.remote
    return {
      id: r.hostId,
      label: r.label,
      command: src.command,
      args: [...src.args],
      remote: { ...r },
      // A saved host this build can't read stays exactly as saved on the split too.
      ...(src.remoteSaved !== undefined ? { remoteSaved: src.remoteSaved } : {}),
      // …and in the same remote folder, as a local split keeps its cwd.
      ...(src.remoteCwd ? { remoteCwd: src.remoteCwd } : {}),
    }
  }
  const argsKey = (a: string[]) => a.join("\0")
  const match = shells.find(
    (s) => s.command === src.command && argsKey(s.args) === argsKey(src.args),
  )
  if (match) return match
  const label = src.command.split(/[\\/]/).pop() || src.command
  return { id: src.command, label, command: src.command, args: [...src.args] }
}
