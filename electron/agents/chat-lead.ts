// A pane's lead for the phone's chat view, as main tells the remote-host worker. No reader here
// (they load node:sqlite, which stays out of main).
import { agentOf, type AgentKind } from "../../src/lib/agent-graph"

/** A pane's lead agent session, as main tells the remote-host worker. */
export interface ChatLead {
  agent: AgentKind
  sessionId: string
  files: string[] // the transcript's host paths (candidates for a WSL pane); none for OpenCode
}

// OpenCode keeps its database inside the distro for a WSL pane: no chat view there (yet).
/** A pane's lead as the chat view gets it, or null when its conversation can't be read here. */
export function chatLeadFor(
  lead: { agent?: AgentKind; sessionId: string; transcriptPath?: string },
  o: { wsl: boolean; targets: (p: string) => string[] },
): ChatLead | null {
  const agent = agentOf(lead)
  if (agent === "opencode" && o.wsl) return null
  return {
    agent,
    sessionId: lead.sessionId,
    files: lead.transcriptPath ? o.targets(lead.transcriptPath) : [],
  }
}
