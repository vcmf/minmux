// Which chat reader a pane's lead session gets (agent specifics stay in electron/agents). The
// remote-host worker's only: the readers pull in node:sqlite, never loaded in main.
import type { ChatLead } from "./chat-lead"
import type { ChatReader } from "./chat-log"
import { claudeChat } from "./claude-chat"
import { codexChat } from "./codex-chat"
import { opencodeChat } from "./opencode-chat"

export type { ChatLead }

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
