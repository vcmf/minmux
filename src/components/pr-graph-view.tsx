// The pull requests dialog's graph view (docs/design/PR_GRAPH.md): a root per repo, a card per
// PR placed by `lib/pr-graph`, the edges in one SVG layer under them. DOM only, no canvas, no
// transitions (the dialog sits over WebGL terminals). The dialog owns the layout, the
// selection and the keys; a card opens its PR in the list view, its ↗ on GitHub.
import { useEffect, useMemo, useRef } from "react"
import {
  ArrowSquareOut,
  ChatCircle,
  Check,
  FolderSimple,
  GitBranch,
  GitMerge,
  GitPullRequest,
  TerminalWindow,
} from "@phosphor-icons/react"
import { agentIcon } from "./agent-icon"
import { AGENT_STATUS_STILL as DOT } from "../lib/agent-status-ui"
import { agentInfo } from "../lib/agent-kinds"
import type { PrPane } from "../lib/pr-panes"
import type { PrRow } from "../lib/pr-dashboard"
import { prStateUi } from "../lib/pane-git"
import { cardLook, GRAPH, type CardLook, type GraphLayout } from "../lib/pr-graph"
import { ipc } from "../lib/ipc"
import { repoUrl } from "../lib/pr-link"
import { folderName } from "../lib/pr-local"
import { toDialog } from "./to-dialog"

/** The word a card's status shows (none for a ready PR). */
function lookWord(row: PrRow, look: CardLook): string {
  if (look.done) return look.done
  if (row.merge === "conflicts") return "conflicts"
  if (row.ci === "failure") return "CI failing"
  if (row.review === "changes") return "changes requested"
  if (row.ci === "pending") return "CI running"
  return look.draft ? "draft" : ""
}

export function PrGraphView(props: {
  graph: GraphLayout
  selected: string | null
  hereUrl: string | undefined
  panes: Map<string, PrPane[]>
  titleOf: (pane: string) => string
  focusedRepo: string | undefined // the repo tab's repo: its root opens that tab
  onOpen: (url: string) => void
  onRoot: (repo: string) => void
  onGo: (pr: PrRow) => boolean
  tabOf: (pr: PrRow) => string | undefined // the tab that lists a stub's PR
  worktrees: Map<string, string[]> // PR url → worktrees with its branch, no terminal in them
}) {
  const { graph, selected, hereUrl, panes, titleOf, focusedRepo, onOpen, onRoot, onGo, tabOf } =
    props
  const { worktrees } = props
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector(".pr-gcard.sel")?.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
    })
  }, [selected])
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const n of graph.nodes) {
      const k = n.row.repo.toLowerCase()
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return m
  }, [graph])
  const G = GRAPH
  return (
    <div className="pr-graph" ref={ref} role="listbox" aria-label="Pull requests graph">
      <div className="pr-graph-canvas" style={{ width: graph.width, height: graph.height }}>
        {graph.seps.map((y) => (
          <div key={y} className="pr-gsep" style={{ top: y }} aria-hidden />
        ))}
        <svg
          className="pr-gedges"
          width={graph.width}
          height={graph.height}
          aria-hidden
          focusable="false"
        >
          {graph.edges.map((e) => (
            <path key={e.key} d={e.d} className={e.hot ? "hot" : undefined} />
          ))}
        </svg>
        {graph.roots.map((r) => {
          const tab = !!focusedRepo && focusedRepo.toLowerCase() === r.repo.toLowerCase()
          const n = counts.get(r.repo.toLowerCase()) ?? 0
          return (
            <div
              key={r.repo}
              className="pr-groot"
              style={{ left: r.x, top: r.y, width: G.rootW, height: G.rootH }}
            >
              <button
                className="pr-gopen"
                title={tab ? `List ${r.repo}'s pull requests` : `Open ${r.repo} on GitHub`}
                onClick={(e) => {
                  toDialog(e.currentTarget)
                  onRoot(r.repo)
                }}
              >
                <span className="pr-groot-name">{r.repo}</span>
                <span className="pr-groot-sub">
                  {r.branch && (
                    <>
                      <GitBranch size={11} /> {r.branch} ·{" "}
                    </>
                  )}
                  {n} PR{n === 1 ? "" : "s"}
                </span>
              </button>
              <ExternalButton url={repoUrl(r.repo)} what={r.repo} />
            </div>
          )
        })}
        {graph.labels.map((l) => (
          <span
            key={`${l.x} ${l.y}`}
            className="pr-glabel"
            style={{ left: l.x, top: l.y, maxWidth: G.cardW - 8 }}
          >
            {l.text}
          </span>
        ))}
        {graph.stubs.map((s) => (
          <button
            key={s.for}
            className="pr-gstub"
            style={{ left: s.x, top: s.y, width: G.stubW, height: G.stubH }}
            title={`Stacked on #${s.on.number}: ${s.on.title}${tabOf(s.on) ? ` (in ${tabOf(s.on)})` : ""}`}
            onClick={(e) => {
              toDialog(e.currentTarget)
              onGo(s.on)
            }}
          >
            #{s.on.number}
            {tabOf(s.on) ? ` · ${tabOf(s.on)}` : ""}
          </button>
        ))}
        {graph.nodes.map((n) => (
          <PrCard
            key={n.row.url}
            row={n.row}
            x={n.x}
            y={n.y}
            selected={n.row.url === selected}
            here={n.row.url === hereUrl}
            panes={panes.get(n.row.url) ?? []}
            worktrees={worktrees.get(n.row.url) ?? []}
            titleOf={titleOf}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  )
}

function ExternalButton({ url, what, hint }: { url: string; what: string; hint?: string }) {
  return (
    <button
      className="pr-gext"
      title={`Open ${what} on GitHub${hint ? ` (${hint})` : ""}`}
      aria-label={`Open ${what} on GitHub`}
      onClick={(e) => {
        ipc.openExternal(url)
        toDialog(e.currentTarget)
      }}
    >
      <ArrowSquareOut size={12} />
    </button>
  )
}

function PrCard(props: {
  row: PrRow
  x: number
  y: number
  selected: boolean
  here: boolean
  panes: PrPane[]
  worktrees: string[]
  titleOf: (pane: string) => string
  onOpen: (url: string) => void
}) {
  const { row, x, y, selected, here, panes, worktrees, titleOf, onOpen } = props
  const look = cardLook(row)
  const word = lookWord(row, look)
  const cls = [
    "pr-gcard",
    look.tone ? `tone-${look.tone}` : "",
    look.draft ? "draft" : "",
    look.done ? "done" : "",
    selected ? "sel" : "",
    here ? "here" : "",
  ]
    .filter(Boolean)
    .join(" ")
  const ui = prStateUi(row.state)
  const Icon = row.state === "merged" ? GitMerge : GitPullRequest
  return (
    <div
      className={cls}
      style={{ left: x, top: y, width: GRAPH.cardW, height: GRAPH.cardH }}
      role="option"
      aria-selected={selected}
      aria-label={`#${row.number} ${row.title}${word ? `, ${word}` : ""}${look.approved ? ", approved" : ""}`}
    >
      <button
        className="pr-gopen"
        title={cardTip(row, word, look, panes, worktrees, titleOf)}
        aria-label={`Open #${row.number} in the list`}
        onClick={(e) => {
          toDialog(e.currentTarget)
          onOpen(row.url)
        }}
      />
      <div className="pr-gline">
        <span className="pr-gstate" style={{ color: `var(--${ui.color})` }} title={ui.word}>
          <Icon size={13} weight={row.state === "draft" ? "regular" : "bold"} />
        </span>
        <span className="pr-num">#{row.number}</span>
        <span className="pr-gtitle">{row.title}</span>
      </div>
      <div className="pr-gline pr-gsub">
        {look.approved && (
          <span className="pr-gtick" title="Approved">
            <Check size={9} weight="bold" />
          </span>
        )}
        {word && <span className="pr-gword">{word}</span>}
        <code className="pr-gbranch">{row.head}</code>
        <span
          className={`pr-gcomments${row.comments ? "" : " none"}`}
          title={`${row.comments} comment${row.comments === 1 ? "" : "s"}`}
        >
          <ChatCircle size={12} />
          {row.comments}
        </span>
      </div>
      <div className="pr-gline pr-gwhere">
        <Where panes={panes} worktrees={worktrees} titleOf={titleOf} />
        {here && <span className="pr-chip pane here">here</span>}
      </div>
      <ExternalButton url={row.url} what={`#${row.number}`} hint="o" />
    </div>
  )
}

/** A card's hover text (its parts take no pointer: the card's button has it all). */
function cardTip(
  row: PrRow,
  word: string,
  look: CardLook,
  panes: PrPane[],
  worktrees: string[],
  titleOf: (pane: string) => string,
): string {
  const state = [word, look.approved ? "approved" : ""].filter(Boolean).join(", ")
  const at = [...panes.map((p) => titleOf(p.pane)), ...worktrees.map((w) => `${w} (no terminal)`)]
  const where = at.length ? `Checked out in ${at.join(", ")}` : "Not checked out"
  const comments = `${row.comments} comment${row.comments === 1 ? "" : "s"}`
  return [
    `#${row.number} ${row.title}`,
    state,
    `${row.head} · ${comments}`,
    where,
    "Enter opens it",
  ]
    .filter(Boolean)
    .join("\n")
}

/** Where a PR is checked out: the busiest pane's agent and status, else a terminal. */
function Where(props: { panes: PrPane[]; worktrees: string[]; titleOf: (pane: string) => string }) {
  const { panes, worktrees, titleOf } = props
  const lead = panes[0] // (sorted: waiting, working, idle agents, then terminals)
  const tree = worktrees[0]
  if (!lead && tree)
    return (
      <span className="pr-gat pr-gtree">
        <FolderSimple size={12} />
        <span className="pr-gat-text">
          {folderName(tree)} · worktree, not open
          {worktrees.length > 1 ? ` +${worktrees.length - 1}` : ""}
        </span>
      </span>
    )
  if (!lead) return <span className="pr-gnone">not checked out</span>
  const n = panes.length + worktrees.length
  const more = n > 1 ? ` +${n - 1}` : ""
  if (!lead.agent)
    return (
      <span
        className="pr-gat"
        title={`Checked out in ${[...panes.map((p) => titleOf(p.pane)), ...worktrees].join(", ")}`}
      >
        <TerminalWindow size={12} />
        <span className="pr-gat-text">
          {titleOf(lead.pane)}
          {more}
        </span>
      </span>
    )
  const AgentIcon = agentIcon(lead.agent)
  const d = DOT[lead.status ?? "idle"]
  return (
    <span className="pr-gat">
      <AgentIcon size={12} />
      <span className={`dot sm ${d.cls}`} />
      <span className="pr-gat-text">
        {agentInfo(lead.agent).label} {d.word} · {titleOf(lead.pane)}
        {more}
      </span>
    </span>
  )
}
