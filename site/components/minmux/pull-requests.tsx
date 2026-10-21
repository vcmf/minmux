import type { CSSProperties } from "react"
import { Ph } from "./icons"

type Chip = "approved" | "ci-running" | "ci-passed" | "behind" | "draft" | "comments"

interface Pr {
  n: number
  title: string
  repo: string
  chips: [Chip, string][]
  stackedOn?: number // drawn under the PR it builds on
  sel?: boolean
}

// a believable afternoon: the PRs the demo's agents opened, one stacked on another
const PRS: Pr[] = [
  {
    n: 42,
    title: "feat(auth): rate-limit the auth routes",
    repo: "acme/api",
    chips: [
      ["approved", "approved"],
      ["ci-running", "CI running"],
      ["comments", "3 comments"],
    ],
    sel: true,
  },
  {
    n: 43,
    title: "refactor(auth): migrate the old limiter call sites",
    repo: "acme/api",
    chips: [
      ["ci-passed", "CI passed"],
      ["comments", "1 comment"],
    ],
    stackedOn: 42,
  },
  {
    n: 41,
    title: "test(web): e2e tests for the login form",
    repo: "acme/web",
    chips: [
      ["draft", "draft"],
      ["ci-passed", "CI passed"],
    ],
  },
  {
    n: 39,
    title: "docs: rewrite the install section",
    repo: "acme/docs",
    chips: [
      ["approved", "approved"],
      ["behind", "behind base"],
      ["ci-passed", "CI passed"],
    ],
  },
]

const CHECKS: { name: string; kind: string; done?: boolean }[] = [
  { name: "typecheck", kind: "ci", done: true },
  { name: "unit tests", kind: "ci" },
  { name: "e2e (login)", kind: "ci" },
  { name: "lint", kind: "ci" },
]

const COMMITS = [
  {
    sha: "a91f3c2",
    msg: "feat(auth): read the limit from AUTH_RATE_LIMIT",
    ago: "1 min ago",
    live: true,
  },
  {
    sha: "7c20d4e",
    msg: "feat(auth): token-bucket limiter on /login, /refresh, /reset",
    ago: "9 min ago",
  },
  { sha: "e3d2551", msg: "test(auth): cover the 429 path", ago: "12 min ago" },
]

const d = (s: number): CSSProperties => ({ animationDelay: `${s}s` })

/** The pull requests dialog (a gh-dash in the terminal), drawn with the demo's own PRs. */
export function PullRequests() {
  return (
    <div className="mm-prs" aria-hidden="true">
      <div className="mm-prs-head">
        <Ph name="github-logo" size={16} />
        <b>Pull requests</b>
        <span className="mm-prs-account">
          @you <Ph name="caret-down" size={11} />
        </span>
        <span className="mm-grow" />
        <span className="c-subtle mm-small">Updated just now</span>
        <Ph name="arrow-clockwise" size={14} className="c-muted" />
        <Ph name="x" size={14} className="c-muted" />
      </div>
      <div className="mm-prs-tabs">
        <span data-on="true">
          Mine <span className="c-subtle">4</span>
        </span>
        <span>
          Review requested <span className="c-subtle">1</span>
        </span>
        <span>
          acme/api <span className="c-subtle">2</span>
        </span>
      </div>
      <div className="mm-prs-body">
        <div className="mm-prs-list">
          {PRS.map((p, i) => (
            <div
              key={p.n}
              className={`mm-pr a-in${p.sel ? " is-sel" : ""}${p.stackedOn ? " is-stacked" : ""}`}
              style={d(0.1 + i * 0.06)}
            >
              <div className="mm-pr-title">
                <Ph name="git-pull-request" size={13} className="c-brand" />
                <span className="c-subtle">#{p.n}</span>
                <span className="mm-ellipsis">{p.title}</span>
              </div>
              <div className="mm-pr-sub">
                <span className="c-muted">{p.repo}</span>
                {p.chips.map(([kind, label]) => (
                  <span key={label} className="mm-chip" data-kind={kind}>
                    {kind === "approved" && <Ph name="check" size={10} />}
                    {label}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="mm-prs-detail">
          <div className="mm-prs-h">
            <Ph name="git-pull-request" size={15} className="c-brand" />
            <b>feat(auth): rate-limit the auth routes</b>
            <span className="c-subtle">#42</span>
          </div>
          <div className="c-muted mm-small">
            acme/api · you <span className="mm-chip">author</span> · feat/rate-limits → main ·{" "}
            <span className="c-added">+65</span> <span className="c-removed">−6</span>
          </div>
          <div className="mm-prs-label">REVIEWERS</div>
          <div className="mm-prs-line">
            <span>maya</span>
            <span className="mm-chip" data-kind="approved">
              <Ph name="check" size={10} />
              approved
            </span>
            <span className="mm-chip mm-chip-btn">
              <Ph name="plus" size={10} />
              Request reviewer
            </span>
          </div>
          <div className="mm-prs-line">
            <span className="mm-chip mm-chip-btn">
              Squash and merge <Ph name="caret-down" size={10} />
            </span>
            <span className="mm-chip mm-chip-btn c-brand">
              <Ph name="git-merge" size={11} />
              Merge
            </span>
            <span className="c-subtle mm-small">Checks are still running.</span>
          </div>
          <div className="mm-prs-label">
            CHECKS <span className="c-subtle">(3 running) · updating live</span>
          </div>
          {CHECKS.map((c, i) => (
            <div key={c.name} className="mm-prs-check a-in" style={d(0.4 + i * 0.08)}>
              {c.done ? (
                <Ph name="check-circle" size={13} className="c-added" fill />
              ) : (
                <span className="a-spin">
                  <Ph name="circle-notch" size={13} className="c-warn" />
                </span>
              )}
              <span>{c.name}</span>
              <span className="c-subtle">{c.kind}</span>
            </div>
          ))}
          <div className="mm-prs-label">
            COMMITS <span className="c-subtle">({COMMITS.length})</span>
          </div>
          {COMMITS.map((c) => (
            <div key={c.sha} className="mm-prs-commit">
              {c.live ? (
                <span className="a-spin">
                  <Ph name="circle-notch" size={12} className="c-warn" />
                </span>
              ) : (
                <Ph name="check-circle" size={12} className="c-added" fill />
              )}
              <span className="c-brand">{c.sha}</span>
              <span className="mm-grow mm-ellipsis">{c.msg}</span>
              <span className="c-subtle">{c.ago}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
