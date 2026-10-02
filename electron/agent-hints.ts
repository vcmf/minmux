// The "approve minmux's hooks" hint's own memory (MULTI_AGENT.md F18): "Not now" counts and
// "Don't ask again", per agent, in the config dir. Whether the hooks ARE approved is the
// agent's to say (AgentAdapter.approved: Codex's own trust records), never guessed here.
// Async I/O: it runs on the main process, which also forwards terminal output.

import fs from "node:fs"
import path from "node:path"
import type { AgentKind } from "../src/lib/agent-graph"

interface KindState {
  dismissals: number // "Not now" clicks
  never: boolean // "Don't ask again"
}

/** The hint state per agent; `file` null = in memory (tests). */
export class AgentHints {
  private state: Partial<Record<AgentKind, KindState>> | null = null
  private writes: Promise<void> = Promise.resolve()

  constructor(private readonly file: string | null) {}

  /** The agent's state ("never" and the dismissals so far). */
  async get(kind: AgentKind): Promise<KindState> {
    return (await this.load())[kind] ?? { dismissals: 0, never: false }
  }

  /** "Not now" (or "Don't ask again" with `never`); returns the dismissals so far. */
  async dismiss(kind: AgentKind, never: boolean): Promise<number> {
    const all = await this.load()
    const s = all[kind] ?? { dismissals: 0, never: false }
    all[kind] = { dismissals: s.dismissals + 1, never: s.never || never }
    this.save(all)
    return s.dismissals + 1
  }

  private async load(): Promise<Partial<Record<AgentKind, KindState>>> {
    if (this.state) return this.state
    const out: Partial<Record<AgentKind, KindState>> = {}
    if (this.file) {
      try {
        const raw = JSON.parse(await fs.promises.readFile(this.file, "utf8")) as Record<
          string,
          Partial<KindState>
        >
        for (const [k, v] of Object.entries(raw ?? {}))
          if (v && typeof v === "object")
            out[k as AgentKind] = {
              dismissals: typeof v.dismissals === "number" ? v.dismissals : 0,
              never: v.never === true,
            }
      } catch {
        // none yet / unreadable: the hint may show
      }
    }
    return (this.state ??= out)
  }

  // Serialized temp + rename writes; best-effort (worst case the hint shows once more).
  private save(all: Partial<Record<AgentKind, KindState>>): void {
    const file = this.file
    if (!file) return
    const body = JSON.stringify(all, null, 2)
    this.writes = this.writes
      .then(async () => {
        await fs.promises.mkdir(path.dirname(file), { recursive: true })
        await fs.promises.writeFile(`${file}.tmp`, body)
        await fs.promises.rename(`${file}.tmp`, file)
      })
      .catch(() => {})
  }

  /** Done when every pending write has landed (tests). */
  flushed(): Promise<void> {
    return this.writes
  }
}
