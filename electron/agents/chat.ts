// Which chat reader a pane's lead session gets (agent specifics stay in electron/agents).
import { agentOf, type AgentKind } from "../../src/lib/agent-graph"
import type { ChatReader } from "./chat-log"
import { claudeChat } from "./claude-chat"
import { codexChat } from "./codex-chat"
import { opencodeChat } from "./opencode-chat"

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

/** A reader for the lead's conversation, or null when the agent keeps none we can read. */
export function chatReaderFor(lead: ChatLead): ChatReader | null {
  switch (lead.agent) {
    case "claude":
      return lead.files.length ? claudeChat(lead.files) : null
    case "codex":
      return lead.files.length ? codexChat(lead.files) : null
    case "opencode":
      return opencodeChat(lead.sessionId)
    default:
      return null
  }
}
