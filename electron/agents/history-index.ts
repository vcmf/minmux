// The agents whose past sessions the sessions worker lists and searches: each one's reader and
// what counts as written on a line (agent specifics live in this folder).

import type { AgentKind } from "../../src/lib/agent-graph"
import { claudeHistory, claudeQuick, claudeTexts } from "./claude-history"
import { codexHistory, codexQuick, codexTexts } from "./codex-history"
import { opencodeHistory } from "./opencode-history"
import type { OwnSearch, SessionHistory } from "./types"

export interface AgentHistory {
  history: SessionHistory
  own?: OwnSearch // searched by the agent's reader (a database), not as transcript files
  // Transcript files only: what the user and the agent wrote on a line, and whether a raw line
  // could be one (tool output isn't: not parsed).
  texts?: (line: Record<string, unknown>) => string[]
  quick?: (raw: string) => boolean
}

/** Fresh readers (each with its own cache): one set per sessions worker. */
export const historyAgents = (): Partial<Record<AgentKind, AgentHistory>> => ({
  claude: { history: claudeHistory(), texts: claudeTexts, quick: claudeQuick },
  codex: { history: codexHistory(), texts: codexTexts, quick: codexQuick },
  opencode: ((h) => ({ history: h, own: h }))(opencodeHistory()), // its database, searched in it
})
