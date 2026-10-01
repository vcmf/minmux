// How often to re-poll `git status` for the focused terminal. A fast repo polls every 2.5 s; a
// slow one waits several times its own cost, so a huge repo can't keep the main process busy.

export const GIT_POLL_MS = 2500
const MAX_POLL_MS = 30_000

/** Delay before the next poll, from how long the last `git status` took (ms). */
export function nextGitPollDelay(lastMs: number): number {
  return Math.min(MAX_POLL_MS, Math.max(GIT_POLL_MS, Math.round(lastMs * 4)))
}
