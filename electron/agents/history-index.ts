// The agents whose past sessions the sessions worker lists and searches: each one's reader and
// what counts as written on a line (agent specifics live in this folder).

import type { AgentKind } from "../../src/lib/agent-graph"
import { claudeHistory, claudeQuick, claudeTexts } from "./claude-history"
import { codexHistory, codexQuick, codexTexts } from "./codex-history"
import type { SessionHistory } from "./types"

export interface AgentHistory {
  history: SessionHistory
  texts: (line: Record<string, unknown>) => string[] // what the user and the agent wrote on it
  quick: (raw: string) => boolean // could this raw line be one? (tool output isn't: not parsed)
}

/** Fresh readers (each with its own cache): one set per sessions worker. */
export const historyAgents = (): Partial<Record<AgentKind, AgentHistory>> => ({
  claude: { history: claudeHistory(), texts: claudeTexts, quick: claudeQuick },
  codex: { history: codexHistory(), texts: codexTexts, quick: codexQuick },
})
