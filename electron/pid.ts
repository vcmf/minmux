// Process liveness, for the agent ledger (leads that end with their process) and the legacy
// migration (an old instance still running).

/** Is `pid` a live process? (signal 0: EPERM = someone else's; never ≤ 0, a process group) */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}
