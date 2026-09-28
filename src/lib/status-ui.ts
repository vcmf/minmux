import type { SessionStatus } from "./session-status"

/** Maps a session status to its mux visual treatment (dot color + word). */
export interface StatusUi {
  dot: "accent" | "amber" | "faint" | "red" | "hollow"
  word: string
  pulse: boolean
}

export function statusUi(status: SessionStatus): StatusUi {
  switch (status) {
    case "working":
      return { dot: "accent", word: "running", pulse: true }
    case "attention":
      return { dot: "amber", word: "needs input", pulse: false }
    default:
      return { dot: "faint", word: "idle", pulse: false }
  }
}
