import type { RemotePane } from "../lib/remote-protocol"

export const AGENT: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
}

/** The row's second line: why it waits, what runs there, or where. */
export function subline(p: RemotePane): string {
  if (!p.started) return "not started on the desktop"
  const agent = p.agent ? AGENT[p.agent] : ""
  if (p.status === "waiting")
    return p.detail ?? (agent ? `${agent} · waiting for you` : "needs input")
  if (p.status === "working" && agent) return `${agent} · working`
  return [agent, p.cwd].filter(Boolean).join(" · ")
}
