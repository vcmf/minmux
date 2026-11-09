"use client"

import { useEffect, useState } from "react"
import type { AgentKind } from "./icons"

/** The agents the hero cycles through, as the commands you'd type to start them; each word is
 *  drawn in its agent's identity colour (`--agent-<kind>`). */
const AGENTS: { kind: AgentKind; cmd: string }[] = [
  { kind: "claude", cmd: "claude" },
  { kind: "codex", cmd: "codex" },
  { kind: "opencode", cmd: "opencode" },
]
const TYPE_MS = 85
const ERASE_MS = 45
const HOLD_MS = 1900

/** `claude` → backspace → `codex` → `opencode`, typed like a prompt. Static (all three, synopsis
 *  style) under reduced motion; paused while `active` is false. Purely visual: the heading
 *  carries the sentence for assistive tech. */
export function AgentRotator({ active }: { active: boolean }) {
  const [i, setI] = useState(0)
  const [n, setN] = useState(AGENTS[0].cmd.length) // server render: "claude", fully typed
  const [erasing, setErasing] = useState(false)
  const [still, setStill] = useState(false)

  useEffect(() => {
    setStill(window.matchMedia("(prefers-reduced-motion: reduce)").matches)
  }, [])

  useEffect(() => {
    if (!active || still) return
    const len = AGENTS[i].cmd.length
    const t = setTimeout(
      () => {
        if (!erasing && n < len) setN(n + 1)
        else if (!erasing) setErasing(true)
        else if (n > 0) setN(n - 1)
        else {
          setErasing(false)
          setI((i + 1) % AGENTS.length)
        }
      },
      !erasing && n === len ? HOLD_MS : erasing ? ERASE_MS : TYPE_MS,
    )
    return () => clearTimeout(t)
  }, [active, still, i, n, erasing])

  if (still) {
    return (
      <span className="mm-agent-cmd mm-agent-cmd-still">
        &lt;
        {AGENTS.map((a, k) => (
          <span key={a.kind}>
            {k > 0 && " | "}
            <span data-agent={a.kind}>{a.cmd}</span>
          </span>
        ))}
        &gt;
      </span>
    )
  }
  const a = AGENTS[i]
  return (
    <span className="mm-agent-cmd">
      <span data-agent={a.kind}>{a.cmd.slice(0, n)}</span>
      <span className="mm-agent-cmd-caret a-caret" />
    </span>
  )
}
