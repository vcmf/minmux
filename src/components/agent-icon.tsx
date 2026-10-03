import type { ComponentType } from "react"
import type { AgentKind } from "../lib/agent-graph"
import { CodexIcon, OpenCodeIcon } from "./agent-marks"
import { ClaudeIcon } from "./claude-icon"

/** Props every agent icon takes (a phosphor icon's, as far as we use them). */
type IconProps = { size?: number; color?: string; weight?: "fill" | "regular" }

/** The icon that stands in for the terminal icon while an agent runs there. */
export function agentIcon(kind: AgentKind): ComponentType<IconProps> {
  return ICONS[kind]
}

const ICONS: Record<AgentKind, ComponentType<IconProps>> = {
  claude: ClaudeIcon,
  codex: CodexIcon,
  opencode: OpenCodeIcon,
}
