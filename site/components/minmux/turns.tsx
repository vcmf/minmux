import type { CSSProperties, ReactNode } from "react"
import {
  WATCH_TURN,
  INSTALL_PS,
  INSTALL_SH,
  GITHUB,
  FAQ,
  MAKER,
  TEAM,
  agentsAt,
  turnOf,
  type ChapterId,
  type Status,
} from "./data"
import { CopyButton } from "./copy-button"
import { AgentRotator } from "./agent-rotator"
import { AgentsPanel } from "./agents-panel"
import { PullRequests } from "./pull-requests"
import { AgentMark, Ph, type AgentKind } from "./icons"

const d = (s: number): CSSProperties => ({ animationDelay: `${s}s` })
/** When the run turn's second beat (the split) starts, in seconds. */
const SPLIT_AT = 3

/** One chapter of the page. On desktop only the active one shows; on phones they stack. */
function Turn({ id, turn, children }: { id: ChapterId; turn: number; children: ReactNode }) {
  return (
    <section
      id={id}
      className="mm-turn"
      data-active={turn === turnOf(id)}
      aria-labelledby={`${id}-h`}
    >
      {children}
    </section>
  )
}

/** The narration: a shell-comment headline + one paragraph. Real h2/p for SEO. */
function Band({ id, title, children }: { id: ChapterId; title: string; children: ReactNode }) {
  return (
    <header className="mm-band a-in">
      <span className="mm-band-n">
        {String(turnOf(id)).padStart(2, "0")} · {id}
      </span>
      <h2 id={`${id}-h`}>{title}</h2>
      <p>{children}</p>
    </header>
  )
}

function PaneHead({
  name,
  status,
  right,
  shell = "ZSH",
  agent,
}: {
  name: string
  status: Status
  right?: ReactNode
  shell?: string | null
  agent?: AgentKind
}) {
  return (
    <div className="mm-pane-head">
      <span className="mm-dot" data-s={status} />
      {agent && <AgentMark kind={agent} size={13} className="mm-pane-mark" />}
      <span className="mm-pane-name">{name}</span>
      {shell && <span className="mm-badge">{shell}</span>}
      <span className="mm-grow" />
      {right}
    </div>
  )
}

const Prompt = ({ cwd, cmd }: { cwd: string; cmd: string }) => (
  <>
    <span className="tok-cwd">{cwd}</span> <span className="tok-branch">main</span> ❯ {cmd}
  </>
)
const Tool = ({ name, arg }: { name: string; arg: string }) => (
  <>
    <span className="c-brand">●</span> {name} <span className="c-muted">{arg}</span>
  </>
)
const Working = ({ text, time }: { text: string; time?: string }) => (
  <>
    <span className="a-spin">✻</span> {text}
    {time && <span className="c-subtle"> ({time})</span>}
  </>
)

const LOGO_MIN = [
  "███╗   ███╗██╗███╗   ██╗",
  "████╗ ████║██║████╗  ██║",
  "██╔████╔██║██║██╔██╗ ██║",
  "██║╚██╔╝██║██║██║╚██╗██║",
  "██║ ╚═╝ ██║██║██║ ╚████║",
  "╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝",
]
const LOGO_MUX = [
  "███╗   ███╗██╗   ██╗██╗  ██╗",
  "████╗ ████║██║   ██║╚██╗██╔╝",
  "██╔████╔██║██║   ██║ ╚███╔╝ ",
  "██║╚██╔╝██║██║   ██║ ██╔██╗ ",
  "██║ ╚═╝ ██║╚██████╔╝██╔╝ ██╗",
  "╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝",
]

/** Runs of full blocks per row, as [x, width]; the box-drawing shadow is redrawn as an offset copy. */
function blockRuns(row: string): [number, number][] {
  const runs: [number, number][] = []
  ;[...row].forEach((ch, x) => {
    if (ch !== "█") return
    const last = runs[runs.length - 1]
    if (last && last[0] + last[1] === x) last[1]++
    else runs.push([x, 1])
  })
  return runs
}
const SPLIT = LOGO_MIN[0].length
const LOGO = LOGO_MIN.map((row, r) => blockRuns(row + LOGO_MUX[r]))
const CELL_H = 2 // a terminal cell is ~2x taller than wide

/** The ANSI-shadow wordmark, drawn as SVG so it never depends on font glyph coverage. */
export function Wordmark() {
  const cols = SPLIT + LOGO_MUX[0].length
  return (
    <svg
      className="mm-logo"
      viewBox={`0 0 ${cols + 0.5} ${LOGO.length * CELL_H + 0.6}`}
      aria-hidden="true"
    >
      {LOGO.map((runs, r) => (
        <g key={r} className="mm-logo-row" style={d(0.35 + r * 0.06)}>
          {runs.map(([x, w]) => (
            <rect
              key={`s${x}`}
              className="mm-logo-shadow"
              x={x + 0.4}
              y={r * CELL_H + 0.6}
              width={w}
              height={CELL_H}
            />
          ))}
          {runs.map(([x, w]) => (
            <rect
              key={x}
              className={x >= SPLIT ? "mm-logo-mux" : "mm-logo-min"}
              x={x}
              y={r * CELL_H}
              width={w}
              height={CELL_H}
            />
          ))}
        </g>
      ))}
    </svg>
  )
}

export function Turns({ turn, onNext }: { turn: number; onNext: () => void }) {
  return (
    <>
      {/* welcome */}
      <Turn id="welcome" turn={turn}>
        <PaneHead
          name="welcome"
          status="running"
          right={<span className="c-subtle mm-small">~/minmux · main</span>}
        />
        <div className="mm-hero">
          <div className="mm-term-line a-type" aria-hidden="true">
            <Prompt cwd="~/minmux" cmd="minmux --hello" />
          </div>
          <Wordmark />
          <div className="mm-hero-copy a-in" style={d(0.8)}>
            <span className="mm-eyebrow">a terminal for agentic coding</span>
            <h1
              id="welcome-h"
              aria-label="You run Claude Code, Codex or OpenCode. You still read the code."
            >
              {/* one fixed line per phrase: only the typed word changes, nothing reflows */}
              <span className="mm-h1-line">
                You run <AgentRotator active={turn === 0} />.
              </span>
              <span className="mm-h1-line">You still read the code.</span>
            </h1>
            <p>
              A fast, cross-platform terminal with tabs, split panes and real shells, for people who
              run Claude Code, Codex or OpenCode all day. It stays out of your way like any
              terminal, then adds the panels that show what your agents actually did.
            </p>
            <p className="mm-hero-alt">
              An open-source alternative if you have been looking for Warp without the lock-in, or
              tmux that understands agents.
            </p>
          </div>
          <div className="mm-hero-install a-in" style={d(1.05)}>
            <div className="mm-cmd">
              <span className="c-brand">$</span>
              <code>{INSTALL_SH}</code>
              <CopyButton text={INSTALL_SH} />
            </div>
            <div className="mm-platforms">
              <span>macOS</span>
              <span className="c-subtle">·</span>
              <span>Linux</span>
              <span className="c-subtle">·</span>
              <span>Windows and WSL</span>
              <span className="c-subtle">|</span>
              <span>MIT, open source</span>
              <span className="c-subtle">|</span>
              <a href="#install" className="c-brand">
                PowerShell one-liner
              </a>
            </div>
          </div>
          <span className="mm-grow" />
          <button type="button" className="mm-cue a-in" style={d(1.4)} onClick={onNext}>
            <span className="mm-key">↓</span>
            <span>scroll to watch it run, or pick a session on the left</span>
          </button>
        </div>
      </Turn>

      {/* run: claude types in one pane, then the pane splits and codex starts beside it */}
      <Turn id="run" turn={turn}>
        <Band id="run" title="Run Claude Code, Codex and OpenCode, side by side.">
          Each agent gets a real shell in its own tab or pane: your shell, your prompt, your
          directory. Split, and the next one starts where you are. minmux is a normal terminal
          first.
        </Band>
        <div className="mm-panes">
          <div className="mm-pane">
            <PaneHead name="api" agent="claude" status="running" />
            <div className="mm-term" aria-hidden="true">
              <div className="a-type">
                <Prompt cwd="~/api" cmd="claude" />
              </div>
              <div className="mm-cc a-in" style={d(0.9)}>
                <b>✻ Claude Code</b>
                <span className="c-muted">~/api</span>
              </div>
              <div className="a-in mm-ask" style={d(1.3)}>
                <span className="c-subtle">&gt;</span> add rate limiting to the auth routes
              </div>
              <div className="a-in" style={d(1.7)}>
                <Tool name="Read" arg="src/auth/routes.ts" />
              </div>
              <div className="a-in" style={d(2.1)}>
                <Tool name="Write" arg="src/auth/limits.ts" />
              </div>
              <div className="a-in c-warn" style={d(2.5)}>
                <Working text="Wiring the limiter into three routes…" time="14s" />
              </div>
            </div>
          </div>
          {/* beat 2: the split grows from the divider */}
          <div className="mm-pane a-grow" style={d(SPLIT_AT)}>
            <PaneHead name="web" agent="codex" status="running" />
            <div className="mm-term" aria-hidden="true">
              <div className="a-type" style={d(SPLIT_AT + 0.45)}>
                <Prompt cwd="~/web" cmd="codex" />
              </div>
              <div className="a-in" style={d(SPLIT_AT + 1.2)}>
                <span className="c-subtle">&gt;</span> write e2e tests for the login form
              </div>
              <div className="a-in" style={d(SPLIT_AT + 1.6)}>
                <Tool name="Read" arg="app/login/page.tsx" />
              </div>
              <div className="a-in c-warn" style={d(SPLIT_AT + 2)}>
                <Working text="Writing tests…" time="6s" />
              </div>
            </div>
          </div>
        </div>
      </Turn>

      {/* watch: codex asks for input (notification); then the Agents panel opens up */}
      <Turn id="watch" turn={turn}>
        <Band id="watch" title="It tells you which one needs you.">
          Working, waiting or done: a dot on the tab, a line in the sidebar, a native notification
          when a background pane asks. The Agents panel shows every session, its sub-agents and the
          processes it runs, and finds the sessions you closed so you can resume them.
        </Band>
        <div className="mm-panes">
          <div className="mm-pane mm-pane-dim">
            <PaneHead name="api" agent="claude" status="running" />
            <div className="mm-term" aria-hidden="true">
              <div>
                <Tool name="Bash" arg="npm test -- auth" />
              </div>
              <div className="mm-out">⎿ 24 passed</div>
              <div className="c-warn">
                <Working text="Migrating old limiter call sites…" />
              </div>
            </div>
          </div>
          <div className="mm-pane mm-pane-wait">
            <PaneHead
              name="web"
              agent="codex"
              status="waiting"
              right={<span className="c-warn mm-small">needs input</span>}
            />
            <div className="mm-term" aria-hidden="true">
              <div>
                <Tool name="Write" arg="e2e/login.spec.ts" />
              </div>
              <div className="mm-permission a-in" style={d(0.3)}>
                <b>Allow command?</b>
                <span className="c-muted">npx prisma migrate dev --name add_sessions</span>
                <span className="c-brand mm-gap">❯ 1. Yes</span>
                <span className="c-muted"> 2. Yes, and don't ask again for this command</span>
                <span className="c-muted"> 3. No, and tell Codex what to do differently</span>
              </div>
            </div>
            <div className="mm-panel-inline">
              <AgentsPanel agents={agentsAt(WATCH_TURN)} searching inline />
            </div>
          </div>
        </div>
        <div className="mm-toast a-toast" style={d(0.6)} aria-hidden="true">
          <img src="/media/icon.png" alt="" width={30} height={30} />
          <div>
            <b>web needs input</b>
            <span className="c-muted">
              Codex wants to run a migration. Click to jump to the pane.
            </span>
          </div>
          <span className="c-subtle mm-small">now</span>
        </div>
      </Turn>

      {/* read: the brand promise. The diff first (right panel), then the files and a preview */}
      <Turn id="read" turn={turn}>
        <Band id="read" title="You still read the code.">
          The Changes panel shows the git diff of the focused pane's folder, per file. The Files
          panel browses its tree: click a file and read it, with line numbers and syntax colour,
          without leaving the terminal.
        </Band>
        <div className="mm-panes">
          <div className="mm-pane">
            <PaneHead
              name="api"
              agent="claude"
              status="done"
              right={<span className="c-muted mm-small">done</span>}
            />
            <div className="mm-term" aria-hidden="true">
              <div>
                <span className="c-brand">●</span> Added a token-bucket limiter to /login, /refresh
                and /reset.
              </div>
              <div className="mm-out">3 files changed. The auth suite passes (24 tests).</div>
              <div className="mm-out">The limiter lives in src/auth/limits.ts.</div>
            </div>
            <div className="mm-changes-inline">
              <Changes />
            </div>
            <div className="mm-files-inline">
              <FilesPanel />
              <FilePreview />
            </div>
          </div>
        </div>
      </Turn>

      {/* ship: the pull requests dialog sits in the pane, under the narration */}
      <Turn id="ship" turn={turn}>
        <Band id="ship" title="Then ship what they open.">
          Your PRs, the ones waiting for your review, and the focused pane's repo, with approvals,
          CI and stacked PRs at a glance. Read the threads, request reviewers, comment, approve,
          update the branch or merge, while checks run live. It uses your own gh.
        </Band>
        <div className="mm-panes mm-panes-dialog">
          <PullRequests />
        </div>
      </Turn>

      {/* faq: a man page; the same entries feed the FAQPage structured data */}
      <Turn id="faq" turn={turn}>
        <Band id="faq" title="Questions people ask.">
          The short answers. Something else on your mind?{" "}
          <a href={`${GITHUB}/issues`} className="mm-inline-link">
            Open an issue
          </a>
          : what you did, what happened, and what you expected is enough.
        </Band>
        <div className="mm-panes">
          <div className="mm-pane">
            <PaneHead name="man minmux" status="idle" shell={null} />
            <div className="mm-man">
              <div className="mm-man-head" aria-hidden="true">
                <span>MINMUX(1)</span>
                <span>User Commands</span>
                <span>MINMUX(1)</span>
              </div>
              <h3 className="mm-man-sec">FAQ</h3>
              <dl className="mm-faq">
                {FAQ.map((f, i) => (
                  <div key={f.q} className="a-in" style={d(0.1 + i * 0.06)}>
                    <dt>{f.q}</dt>
                    <dd>{f.a}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>
        </div>
      </Turn>

      {/* install */}
      <Turn id="install" turn={turn}>
        <Band id="install" title="Install it in one line.">
          “…I also like reading the code an agent writes and making the edits myself, and a plain
          terminal makes that hard… minmux keeps the shell I already like and adds just enough to
          stay in the loop.” — made by{" "}
          <a href={MAKER.url} target="_blank" rel="noopener noreferrer" className="mm-inline-link">
            {MAKER.name}
          </a>
        </Band>
        <div className="mm-install">
          <div className="a-in mm-install-block">
            <span className="c-muted"># macOS and Linux</span>
            <div className="mm-cmd">
              <span className="c-brand">$</span>
              <code>{INSTALL_SH}</code>
              <CopyButton text={INSTALL_SH} />
            </div>
          </div>
          <div className="a-in mm-install-block" style={d(0.15)}>
            <span className="c-muted"># Windows, in PowerShell</span>
            <div className="mm-cmd">
              <span className="c-brand">&gt;</span>
              <code>{INSTALL_PS}</code>
              <CopyButton text={INSTALL_PS} />
            </div>
          </div>
          <div className="a-in mm-install-src" style={d(0.3)}>
            <span className="c-muted"># or build it from source</span>
            <code>git clone {GITHUB} &amp;&amp; cd minmux</code>
            <code>
              make install <span className="c-subtle"># deps, native rebuild, hooks</span>
            </code>
            <code>
              make build <span className="c-subtle"> # package for your OS</span>
            </code>
          </div>
          {/* the rest of what's in the box, one line each: honest and quick to scan */}
          <ul className="a-in mm-also" style={d(0.4)} aria-label="Also in minmux">
            <li>SSH hosts from your ~/.ssh/config, splits stay on the host</li>
            <li>4 theme families, light and dark, in one settings.json</li>
            <li>sessions come back after a restart</li>
            <li>no telemetry, no account</li>
            <li>macOS, Linux, Windows and WSL · MIT</li>
          </ul>
          <div className="a-in mm-ctas" style={d(0.5)}>
            <a href={GITHUB} className="mm-btn mm-btn-solid">
              Star on GitHub
            </a>
            <a href={`${GITHUB}/tree/main/docs`} className="mm-btn">
              Read the docs
            </a>
            <a href={`${GITHUB}/issues`} className="mm-btn">
              Open an issue
            </a>
          </div>
          <span className="mm-grow" />
          <p className="mm-credit">
            © 2026 minmux · MIT · made by{" "}
            <a href={MAKER.url} target="_blank" rel="noopener noreferrer">
              {MAKER.name}
            </a>
            , built in the open with the{" "}
            <a href={TEAM.url} target="_blank" rel="noopener noreferrer">
              {TEAM.name}
            </a>
          </p>
        </div>
      </Turn>
    </>
  )
}

type Row = {
  name: string
  depth: number
  dir?: "open" | "closed"
  mark?: "mod" | "add"
  sel?: boolean
}
const TREE: Row[] = [
  { name: ".github", depth: 0, dir: "closed" },
  { name: "node_modules", depth: 0, dir: "closed" },
  { name: "src", depth: 0, dir: "open", mark: "mod" },
  { name: "auth", depth: 1, dir: "open", mark: "mod" },
  { name: "bucket.ts", depth: 2 },
  { name: "limits.ts", depth: 2, mark: "add", sel: true },
  { name: "routes.ts", depth: 2, mark: "mod" },
  { name: "db", depth: 1, dir: "closed" },
  { name: "test", depth: 0, dir: "closed", mark: "mod" },
  { name: ".env.example", depth: 0 },
  { name: "package.json", depth: 0 },
  { name: "README.md", depth: 0 },
  { name: "tsconfig.json", depth: 0 },
]

/** The Files panel body: breadcrumb + tree (right panel on the files turn). */
export function FilesPanel({ onOpen }: { onOpen?: () => void }) {
  return (
    <div className="mm-tree" aria-hidden={onOpen ? undefined : true}>
      <div className="mm-crumbs">
        <span className="c-subtle">···</span>
        <Ph name="caret-right" size={11} />
        <span>workspace</span>
        <Ph name="caret-right" size={11} />
        <b>api</b>
        <span className="mm-grow" />
        <Ph name="pencil-simple" size={14} />
        <Ph name="folder-open" size={14} />
      </div>
      {TREE.map((r, i) => (
        <div
          key={r.name}
          className={`mm-tree-item a-in${r.sel ? " is-sel" : ""}`}
          data-mark={r.mark}
          style={{ paddingLeft: 12 + r.depth * 16, ...d(0.15 + i * 0.03) }}
        >
          <span className="mm-caret-slot">
            {r.dir && <Ph name={r.dir === "open" ? "caret-down" : "caret-right"} size={12} />}
          </span>
          {r.dir ? (
            <Ph
              name={r.dir === "open" ? "folder-open" : "folder"}
              fill
              size={16}
              className="mm-folder"
            />
          ) : (
            <Ph name="file" size={16} className="c-muted" />
          )}
          {r.sel && onOpen ? (
            <button type="button" className="mm-tree-name mm-tree-open" onClick={onOpen}>
              {r.name}
            </button>
          ) : (
            <span className="mm-tree-name">{r.name}</span>
          )}
        </div>
      ))}
    </div>
  )
}

const KW = new Set(["import", "from", "type", "const", "export", "function", "return", "if"])
/** A tiny highlighter for the preview's TypeScript: keywords, strings, comments, numbers. */
function highlight(line: string): ReactNode[] {
  if (line.trimStart().startsWith("//"))
    return [
      <span key={0} className="tok-cmt">
        {line}
      </span>,
    ]
  return line.split(/("[^"]*"|\b\d+\b|\b[a-z]+\b)/).map((t, i) =>
    t.startsWith('"') ? (
      <span key={i} className="tok-str">
        {t}
      </span>
    ) : /^\d+$/.test(t) ? (
      <span key={i} className="tok-num">
        {t}
      </span>
    ) : KW.has(t) ? (
      <span key={i} className="tok-kw">
        {t}
      </span>
    ) : (
      t
    ),
  )
}
const LIMITS_TS = [
  'import { bucket } from "./bucket"',
  'import type { Request, Response, NextFunction } from "express"',
  "",
  "// Token bucket per IP: AUTH_RATE_LIMIT requests a minute, refilled continuously.",
  "const PER_MIN = Number(process.env.AUTH_RATE_LIMIT ?? 10)",
  "",
  "export const authLimit = bucket({",
  "  capacity: PER_MIN,",
  "  refillPerSec: PER_MIN / 60,",
  "  key: (req: Request) => req.ip,",
  "})",
  "",
  "export function limited(req: Request, res: Response, next: NextFunction) {",
  "  if (authLimit.take(req)) return next()",
  '  res.status(429).set("Retry-After", "6").json({ error: "slow down" })',
  "}",
]

/** The file preview dialog (opened from the Files panel). */
export function FilePreview({ onClose }: { onClose?: () => void }) {
  return (
    <div className="mm-preview">
      <div className="mm-preview-head">
        <b>limits.ts</b>
        <span className="c-muted mm-small">typescript · 1.1 KB</span>
        <span className="mm-grow" />
        <Ph name="arrow-square-out" size={16} />
        <Ph name="folder-open" size={16} />
        {onClose ? (
          <button
            type="button"
            className="mm-icon-btn mm-preview-close"
            aria-label="Close preview (Esc)"
            onClick={onClose}
          >
            <Ph name="x" size={16} />
          </button>
        ) : (
          <Ph name="x" size={16} />
        )}
      </div>
      <pre className="mm-preview-body">
        {LIMITS_TS.map((l, i) => (
          <span key={i} className="mm-preview-line">
            <span className="mm-ln">{i + 1}</span>
            <span>{highlight(l)}</span>
          </span>
        ))}
      </pre>
    </div>
  )
}

/** The Changes panel body (file list + unified diff); shown in the right panel on turn 4. */
export function Changes() {
  return (
    <>
      <div className="mm-files">
        <div className="mm-file is-sel">
          <span className="mm-grow">src/auth/limits.ts</span>
          <span className="c-added">+38</span>
          <span className="c-removed">−0</span>
        </div>
        <div className="mm-file">
          <span className="mm-grow">src/auth/routes.ts</span>
          <span className="c-added">+6</span>
          <span className="c-removed">−2</span>
        </div>
        <div className="mm-file">
          <span className="mm-grow">test/auth.spec.ts</span>
          <span className="c-added">+21</span>
          <span className="c-removed">−4</span>
        </div>
      </div>
      <pre className="mm-diff a-in" style={d(0.35)} aria-hidden="true">
        <span className="h">@@ -0,0 +1,10 @@ src/auth/limits.ts</span>
        {[
          'import { bucket } from "./bucket"',
          "",
          "const PER_MIN = Number(",
          "  process.env.AUTH_RATE_LIMIT ?? 10)",
          "",
          "export const authLimit = bucket({",
          "  capacity: PER_MIN,",
          "  refillPerSec: PER_MIN / 60,",
          "})",
        ].map((l, i) => (
          <span key={i} className="add">
            +{l}
          </span>
        ))}
        <span className="h">@@ -12,7 +12,7 @@ src/auth/routes.ts</span>
        <span> router.post("/login",</span>
        <span className="del">- handleLogin)</span>
        <span className="add">+ authLimit, handleLogin)</span>
      </pre>
    </>
  )
}
