/** Scripted content for the landing page: chapters (= sidebar sessions) and per-turn demo state. */

import type { AgentKind } from "./icons"

export type Appearance = "light" | "dark"

export type Status = "idle" | "running" | "waiting" | "done"

export const STATUS_LABEL: Record<Status, string> = {
  idle: "idle",
  running: "running",
  waiting: "needs input",
  done: "done",
}

/** Session colours (the app's src/lib/session-color.ts); swatches are `--cc-<name>` tokens. */
export type SessionColor =
  "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "cyan"

const CHAPTER_IDS = ["welcome", "run", "watch", "read", "ship", "faq", "install"] as const
export type ChapterId = (typeof CHAPTER_IDS)[number]

export interface Chapter {
  id: ChapterId
  sub: string
  /** Agent-centred chapters show that agent's mark in a session colour; the rest a terminal icon. */
  agent?: { kind: AgentKind; color: SessionColor }
}

/** The story in four verbs (run → watch → read → ship), framed by the hook and the install. */
const CHAPTER_META: Record<ChapterId, Omit<Chapter, "id">> = {
  welcome: { sub: "~/minmux · main" },
  run: { sub: "claude · codex · opencode", agent: { kind: "claude", color: "orange" } },
  watch: { sub: "status · agents panel", agent: { kind: "codex", color: "purple" } },
  read: { sub: "diff · files · preview" },
  ship: { sub: "pull requests · CI · merge" },
  faq: { sub: "man minmux" },
  install: { sub: "one line · MIT" },
}

/** One chapter per turn, in order; the sidebar lists them as sessions. */
export const CHAPTERS: Chapter[] = CHAPTER_IDS.map((id) => ({ id, ...CHAPTER_META[id] }))
export const TURNS = CHAPTERS.length

/** The turn a chapter plays at — the only way turn numbers are derived. */
export const turnOf = (id: ChapterId): number => CHAPTER_IDS.indexOf(id)
export const RUN_TURN = turnOf("run")
export const WATCH_TURN = turnOf("watch")
export const READ_TURN = turnOf("read")
export const SHIP_TURN = turnOf("ship")

/** Status of chapter `i` while turn `turn` is showing: behind = done, current = running
 *  (the watch turn is the one where an agent needs you). */
export function chapterStatus(i: number, turn: number): Status {
  if (i < turn) return "done"
  if (i > turn) return "idle"
  return turn === WATCH_TURN ? "waiting" : "running"
}

/** What the two demo agents (api, web) are doing on each chapter. Keyed by id, so a new
 *  chapter without an entry is a type error rather than an `undefined` at runtime. */
const DEMO: Record<ChapterId, { api: Status; apiLast: string; web: Status; webLast: string }> = {
  welcome: {
    api: "idle",
    apiLast: "Waiting for a prompt",
    web: "idle",
    webLast: "Waiting for a prompt",
  },
  run: {
    api: "running",
    apiLast: "Wiring the limiter into three routes",
    web: "running",
    webLast: "Writing tests for the login form",
  },
  watch: {
    api: "running",
    apiLast: "Migrating old limiter call sites",
    web: "waiting",
    webLast: "Wants to run a migration",
  },
  read: {
    api: "done",
    apiLast: "Added a limiter to 3 routes",
    web: "running",
    webLast: "Running e2e/login.spec.ts",
  },
  ship: { api: "done", apiLast: "Opened PR #42", web: "done", webLast: "6 login tests pass" },
  faq: { api: "done", apiLast: "Opened PR #42", web: "done", webLast: "6 login tests pass" },
  install: { api: "done", apiLast: "Opened PR #42", web: "done", webLast: "6 login tests pass" },
}
const demoAt = (turn: number) => DEMO[CHAPTER_IDS[turn]]

export interface AgentCard {
  agent: AgentKind
  group: string // the sidebar group (tab) it runs in
  name: string // the session's name (/rename, or the agent's own title)
  color: SessionColor // its session colour: tints the row
  cwd: string
  status: Status
  ago: string // last activity
  tokens: string
  last: string
  kids: { kind: string; what: string }[]
  /** Shown when the row is opened (the agents-board turn opens the first one). */
  detail?: { branch: string; id: string; processes: { cmd: string; cpu: string; mem: string }[] }
}

/** Past sessions found by the panel's conversation search (agents-board turn). */
export const PAST_SESSIONS: {
  agent: AgentKind
  name: string
  cwd: string
  ago: string
  hit: [string, string, string] // snippet: before, match, after
}[] = [
  {
    agent: "codex",
    name: "auth-hardening",
    cwd: "~/api",
    ago: "2 d",
    hit: ["…move the ", "rate limit", " into middleware so…"],
  },
  {
    agent: "claude",
    name: "login-throttle",
    cwd: "~/web",
    ago: "5 d",
    hit: ["…show the ", "rate limit", " error on the form…"],
  },
]

/** The agents panel for a given turn. */
export function agentsAt(turn: number): AgentCard[] {
  const d = demoAt(turn)
  return [
    {
      agent: "claude",
      group: "api",
      name: "rate-limits",
      color: "orange",
      cwd: "~/api",
      status: d.api,
      ago: d.api === "running" ? "now" : "2m",
      tokens: turn ? "↑42k ↓18k" : "",
      last: d.apiLast,
      detail:
        turn === WATCH_TURN
          ? {
              branch: "feat/rate-limits",
              id: "5e84ac20",
              processes: [{ cmd: "npm run dev", cpu: "0.4%", mem: "88 MB" }],
            }
          : undefined,
      kids:
        turn === WATCH_TURN
          ? [
              { kind: "Explore", what: "rateLimit( call sites" },
              { kind: "Bash", what: "npm test" },
            ]
          : [],
    },
    {
      agent: "codex",
      group: "web",
      name: "login-e2e",
      color: "purple",
      cwd: "~/web",
      status: d.web,
      ago: d.web === "running" || d.web === "waiting" ? "now" : "4m",
      tokens: turn >= RUN_TURN ? "↑31k ↓9k" : "",
      last: d.webLast,
      kids: [],
    },
    {
      agent: "opencode",
      group: "docs",
      name: "install-docs",
      color: "blue",
      cwd: "~/docs",
      status: "done",
      ago: "12m",
      tokens: "↑12k ↓4k",
      last: "Rewrote the install section",
      kids: [],
    },
  ]
}

export interface DemoTab {
  name: string
  status: Status
  active: boolean
  /** A tab that opens another page (the docs, the changelog). */
  href?: string
}

/** Top-bar tabs: this page, then the docs and the changelog as links. */
export const TABS: DemoTab[] = [
  { name: "minmux", status: "running", active: true },
  {
    name: "docs",
    status: "idle",
    active: false,
    href: "https://github.com/vcmf/minmux/tree/main/docs",
  },
  { name: "changelog", status: "idle", active: false, href: "/changelog" },
]

export function countsAt(turn: number): { running: number; waiting: number } {
  const d = demoAt(turn)
  const s = [d.api, d.web]
  return {
    running: s.filter((x) => x === "running").length,
    waiting: s.filter((x) => x === "waiting").length,
  }
}

/** The FAQ: rendered on the faq turn and emitted as FAQPage structured data (one source). */
export const FAQ: { q: string; a: string }[] = [
  {
    q: "How is minmux different from tmux or a normal terminal?",
    a: "minmux is a normal terminal first: tabs, resizable splits, your own shell, your own directory. What it adds is a small set of panels that answer what happened while an agent was working: Changes, Files, and the Agents board. Nothing replaces the shell you already use.",
  },
  {
    q: "Which coding agents does minmux support?",
    a: "Claude Code, Codex and OpenCode. Run claude, codex or opencode in any pane and the Agents board shows the session, its sub-agents, what each is doing and its token use, and the session comes back in the same pane when you reopen minmux. Any other agent CLI still runs fine in a pane; it just will not show up on the board.",
  },
  {
    q: "Does minmux work on Windows?",
    a: "Yes, on Windows and inside WSL, alongside macOS and Linux. Windows and WSL are the newest of the three targets, so they have seen less real-world use so far, and Codex and OpenCode are not wired there yet (Claude Code is).",
  },
  {
    q: "Do I have to configure hooks or edit a global config?",
    a: "No global config to edit: minmux wires only the panes it launches, so agents started outside minmux do not show up. Claude Code and OpenCode need no setup at all. Codex asks you to approve minmux's hooks once: type /hooks in Codex and press t. Each integration can be switched off in Settings.",
  },
  {
    q: "Why was minmux built?",
    a: "I love the terminal, and the easiest way to put an agent like Claude Code to work is to launch it from a CLI. But I also like reading the code an agent writes and making the edits myself, and a plain terminal makes that hard: you lose track of which session needs you, and you never really see what changed. minmux keeps the shell I already like and adds just enough to stay in the loop: the Changes, Files, and Agents panels show what happened, not just that something did. It also behaves the same on macOS, Linux and WSL, which helps since my work moves between all three.",
  },
  {
    q: "Can I get an agent session back after closing minmux?",
    a: "Yes. Quit minmux with an agent running, reopen it, and that session comes back in the same pane, in the same folder. Past sessions are listed in the Agents panel too: search their conversations, filter by agent or by the current folder, and resume one in a split.",
  },
  {
    q: "Does minmux send telemetry or need an account?",
    a: "No telemetry and no account. The one request minmux makes on its own is a check for a newer release on GitHub. Everything about pull requests goes through your own gh.",
  },
  {
    q: "Where do minmux settings live?",
    a: "In one JSON file that is the source of truth: ~/.config/minmux/settings.json on macOS and Linux, %APPDATA%\\minmux\\settings.json on Windows. Edit it by hand or through the in-app panel; a watcher re-applies changes as you save.",
  },
  {
    q: "Is minmux free and open source?",
    a: "Yes. It is MIT licensed and open source: clone it, read it, fork it, ship your own version. If it turns out useful to you, a star helps other people find it.",
  },
]

export const SITE_URL = "https://minmux.dev"
/** Who made minmux (credited in the status bar, the why turn, the footer and the metadata). */
export const MAKER = { name: "quanglee.dev", url: "https://quanglee.dev" }
export const TEAM = { name: "dim0 team", url: "https://dim0.net" }
export const INSTALL_SH =
  "curl -fsSL https://raw.githubusercontent.com/vcmf/minmux/main/install.sh | sh"
export const INSTALL_PS = "irm https://raw.githubusercontent.com/vcmf/minmux/main/install.ps1 | iex"
export const GITHUB = "https://github.com/vcmf/minmux"
