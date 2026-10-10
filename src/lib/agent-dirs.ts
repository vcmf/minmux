// Where a pane's agent session works vs where it started. The shell's folder (`from`) is
// where the agent was started (Claude saves the session there); the agent's own cwd (`in`)
// moves with worktrees and `cd`s.
// Pure — the sidebar, the branch/PR poll and the changes panel share these rules.
import type { AgentGraph, AgentKind, Worktree } from "./agent-graph"
import { agentInfo } from "./agent-kinds"
import type { PaneGitInfo, PaneGitRequest } from "./pane-git"
import type { Session } from "../types"
import { wslContext } from "./wsl"
import { shortCwd } from "./session-label"
import { normalizeRootPath } from "./breadcrumb"

/** A live agent session's working folder + the session's other worktrees. */
export interface WorkDir {
  agent: AgentKind
  cwd: string
  others: Worktree[]
}

/** Same folder, ignoring a trailing separator. */
export const samePath = (a: string, b: string): boolean => norm(a) === norm(b)

// normalizeRootPath + one separator ("C:/x" from git ≡ "C:\\x" from a Windows shell) + a
// lower-case drive letter ("c:\\x" from one shell ≡ "C:\\x" from another).
const norm = (p: string) =>
  normalizeRootPath(p)
    .replace(/\\/g, "/")
    .replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`)

/** `child` is strictly inside `parent` (a root like "/" or "C:\\" included). */
export function isInside(child: string, parent: string): boolean {
  const p = norm(parent)
  const c = norm(child)
  const prefix = p.endsWith("/") ? p : p + "/"
  return c !== p && c.startsWith(prefix)
}

const memo = new WeakMap<AgentGraph, Record<string, WorkDir>>()

/** Per pane: its newest live agent session's cwd + other worktrees; memoized per graph. */
export function agentWorkDirs(graph: AgentGraph): Record<string, WorkDir> {
  const hit = memo.get(graph)
  if (hit) return hit
  const out: Record<string, WorkDir> = {}
  const best: Record<string, number> = {}
  for (const rid of graph.rootIds) {
    const n = graph.nodes[rid]
    // Never a nested session (a background agent), even alone: it isn't the pane's agent.
    if (!n?.paneId || n.nested) continue
    const rank = n.started ?? 0 // the newest-started lead wins
    if (rank < (best[n.paneId] ?? -1)) continue
    best[n.paneId] = rank
    const cwd = n.cwd
    if (!cwd) {
      delete out[n.paneId] // the pane's newest session hasn't said where it is yet
      continue
    }
    const others = (n.worktrees ?? []).filter((w) => !samePath(w.path, cwd))
    out[n.paneId] = { agent: n.agent, cwd, others }
  }
  memo.set(graph, out)
  return out
}

const flatMemo = new WeakMap<AgentGraph, string[]>()

/** agentWorkDirs flattened to primitives [paneId, agent, cwd, others…] for useShallow. */
export function agentWorkFlat(graph: AgentGraph): string[] {
  const hit = flatMemo.get(graph)
  if (hit) return hit
  const out = Object.entries(agentWorkDirs(graph)).flatMap(([id, d]) => [
    id,
    d.agent,
    d.cwd,
    d.others.map((w) => w.path).join("\n"),
  ])
  flatMemo.set(graph, out)
  return out
}

/** The agent's `in` lookup if it still applies: asked for this folder, or it's inside its repo. */
export function inGitFor(
  inGit: PaneGitInfo | undefined,
  work: string | undefined,
  agent: AgentKind | undefined, // its worktree layouts (undefined: no agent works there)
) {
  if (!inGit || !work) return undefined
  if (inGit.forCwd === work) return inGit
  if (!inGit.root) return undefined
  if (samePath(work, inGit.root)) return inGit
  // Inside the repo — but a nested worktree (the agent's own layout) is a new checkout.
  const rest = norm(work).slice(norm(inGit.root).length)
  const nested = agentInfo(agent).worktreeMarkers.some((m) => rest.includes(m))
  return isInside(work, inGit.root) && !nested ? inGit : undefined
}

/** Claude works in another checkout: other repo root, or by real path outside git; unknown → no. */
export function worksElsewhere(
  shellCwd: string | undefined,
  work: string | undefined,
  shellGit: PaneGitInfo | undefined,
  inGit: PaneGitInfo | undefined,
  agent: AgentKind | undefined,
): boolean {
  const known = inGitFor(inGit, work, agent)
  if (!shellCwd || !work || !known || samePath(shellCwd, work)) return false
  if (known.root) return !(shellGit?.root && samePath(shellGit.root, known.root))
  // Outside git: symlinked spellings and subfolders of the shell's folder are the same place —
  // by real paths when both sides have one (a resolved path against an unresolved one would
  // never match: /tmp → /private/tmp).
  const both = known.real !== undefined && shellGit?.real !== undefined
  const from = both ? shellGit!.real! : shellCwd
  const to = both ? known.real! : work
  return !samePath(from, to) && !isInside(to, from)
}

/** The sidebar's `in` line: shown for another checkout (`elsewhere`: its own branch / PR), or
 *  another folder of the same one / below the shell's (`label`: where, relative). */
export function inLine(
  shellCwd: string | undefined,
  work: string | undefined,
  shellGit: PaneGitInfo | undefined,
  inGit: PaneGitInfo | undefined,
  agent: AgentKind | undefined,
): { elsewhere: boolean; known: PaneGitInfo; label?: string } | null {
  const known = inGitFor(inGit, work, agent)
  if (!shellCwd || !work || !known || samePath(shellCwd, work)) return null
  if (worksElsewhere(shellCwd, work, shellGit, inGit, agent)) return { elsewhere: true, known }
  if (known.root) {
    // Moved inside the same checkout, its own answer still on the way: keep the line (no
    // flicker on each `cd`); the next poll places it.
    if (known.forCwd !== work) return { elsewhere: false, known }
    // The same checkout: git's own place of each folder in it — symlinked and WSL spellings
    // can't fool it. Not known for either (or the shell's answer is for its old folder): no
    // line — never a guess.
    const at = known.prefix
    const from = shellGit?.forCwd === shellCwd ? shellGit.prefix : undefined
    if (at === undefined || from === undefined || at === from) return null
    const below = from === "" ? at : at.startsWith(from + "/") ? at.slice(from.length + 1) : ""
    return { elsewhere: false, known, ...(below ? { label: below } : {}) }
  }
  // Outside git (inGitFor only returns a rootless answer for this very folder): a folder below
  // the shell's — by real paths when both sides have one (a resolved path against an
  // unresolved one would never match).
  const both = known.real !== undefined && shellGit?.real !== undefined
  const to = both ? known.real! : work
  const base = both ? shellGit!.real! : shellCwd
  return isInside(to, base) ? { elsewhere: false, known } : null
}

/** The folder a pane's git views follow: the agent's checkout root while it works elsewhere. */
export function workCwd(
  graph: AgentGraph,
  paneGit: Record<string, PaneGitInfo>,
  paneId: string,
  shellCwd?: string,
): string | undefined {
  const dir = agentWorkDirs(graph)[paneId]
  const work = dir?.cwd
  const inGit = paneGit[inGitKey(paneId)]
  if (!worksElsewhere(shellCwd, work, paneGit[paneId], inGit, dir?.agent)) return shellCwd
  return inGit?.root ?? work // the checkout, not Claude's current subfolder (stable views)
}

/** The `in` path: relative to `from` (or its real path) when inside it, else `~`-shortened. */
export function inLabel(shellCwd: string, work: string, home: string, fromReal?: string): string {
  const to = normalizeRootPath(work)
  for (const base of fromReal ? [shellCwd, fromReal] : [shellCwd]) {
    const from = normalizeRootPath(base)
    if (isInside(to, from)) return to.slice(from.length).replace(/^[\\/]/, "")
  }
  return shortCwd(to, home)
}

/** Mark each shell answer with the folder it's for (as `in` answers are), so a stale one —
 *  from before a `cd` — isn't taken for the current folder. */
export function tagShellAnswers(res: Record<string, PaneGitInfo>, reqs: PaneGitRequest[]): void {
  for (const r of reqs)
    if (!r.paneId.endsWith("@in") && res[r.paneId]) res[r.paneId]!.forCwd = r.cwd
}

/** paneGit key for a pane's `in` folder (the shell's folder uses the bare pane id). */
export const inGitKey = (paneId: string) => `${paneId}@in`

/** The pane a paneGit key belongs to. */
export const paneOfGitKey = (key: string) => (key.endsWith("@in") ? key.slice(0, -3) : key)

/** One poll's requests: shell folder + Claude's when it moved, paired under the 64 cap. */
export function planGitPoll(
  sessions: Pick<Session, "id" | "cwd" | "command" | "args">[],
  work: Record<string, WorkDir>,
  onlyIn: boolean,
): { reqs: PaneGitRequest[]; polled: string[]; inCwd: Record<string, string> } {
  const reqs: PaneGitRequest[] = []
  const polled: string[] = []
  const inCwd: Record<string, string> = {}
  for (const x of sessions) {
    if (!x.cwd) continue
    const w = work[x.id]?.cwd
    const moved = !!w && !samePath(w, x.cwd)
    if (!moved) polled.push(inGitKey(x.id)) // Claude left (or never moved): clear its `in`
    // Sidebar collapsed: only moved terminals (the status bar / panels follow Claude's
    // checkout) and no PR lookups — nothing on screen shows a PR.
    if ((onlyIn && !moved) || reqs.length + (moved ? 2 : 1) > 64) continue // main answers ≤ 64
    const wsl = wslContext(x.command, x.args)
    const noPr = onlyIn || undefined
    reqs.push({ paneId: x.id, cwd: x.cwd, wsl, noPr })
    polled.push(x.id)
    if (moved) {
      reqs.push({ paneId: inGitKey(x.id), cwd: w, wsl, noPr })
      inCwd[inGitKey(x.id)] = w
    }
  }
  return { reqs, polled, inCwd }
}

/** Tag `in` answers with their folder; a failed lookup keeps the last one (once, not forever). */
export function settleInAnswers(
  res: Record<string, PaneGitInfo>,
  inCwd: Record<string, string>,
  known: Record<string, PaneGitInfo>,
): void {
  for (const [key, cwd] of Object.entries(inCwd)) {
    const r = res[key]
    const prev = known[key]
    if (!r) delete res[key]
    // Lost its repo for the same folder: a git hiccup (timeout), or it really left git — keep
    // the last answer for one poll only (then accept; no flip-flop: prev then has no root).
    else if (!r.root && prev?.root && prev.forCwd === cwd && !prev.kept)
      res[key] = { ...prev, kept: true }
    else r.forCwd = cwd
  }
}

/** noPr answers carry no PR: keep the known one so expanding the sidebar shows it at once. */
export function keepPrs(res: Record<string, PaneGitInfo>, known: Record<string, PaneGitInfo>) {
  for (const [key, r] of Object.entries(res)) {
    const pr = known[key]?.pr
    if (pr && !r.pr && r.branch === known[key]?.branch) r.pr = pr
  }
}
