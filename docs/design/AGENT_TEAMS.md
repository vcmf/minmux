# Design — Claude Code agent teammates as native minmux panes

> Surface the sub-agents a coding agent spawns **as real minmux panes**, so a tab that runs
> `claude` shows its whole working team (each with our existing per-pane status), not just one
> opaque stream. Companion to `ARCHITECTURE.md`; this is a **design sketch for a future, standalone
> project** — not on any current milestone.

Status: **DRAFT / design discussion** (2026-07-10). No code yet.

---

## 1. Goal & scope

**Goal.** When a `claude` session spawns **agent-team teammates**, each teammate becomes a first-class
minmux pane in the same tab — created, driven, and torn down by the agent — so minmux's existing
sidebar + per-pane status rail shows "the working agents inside the tab" for free.

**In scope (v1):** Claude Code **agent teams** (`--teammate-mode`) on native shells (macOS/Linux).

**Explicitly out of scope:**

- **`Task`-tool sub-agents** (spawned _within_ one session). They live in **one process, one stdout** —
  there is no second PTY to attach to, so **no terminal can split them into panes** (cmux can't
  either). This is a hard limit of the medium, not a gap we can close. See §9.
- **Non-Claude agents** — the mechanism is agent-agnostic in principle (§3), but v1 targets Claude Code.
- **WSL** — deferred; reuses the WSL cwd/exec plumbing once it lands (see `GOTCHAS #windows`).

**Non-negotiable principle.** This stays **terminal-first**: teammates are real PTYs in the pane tree,
reusing our status engine. We are **not** reading Claude's private state files or scraping its UI (the
control-plane road — see §11). The agent hands us structure through a protocol; we render panes.

---

## 2. Why this is hard (the crux)

A terminal sees **one PTY byte stream**. An agent's internal work is invisible to it. So this is a
**data-source problem**, not a rendering one. The two kinds of "sub-work" differ fundamentally:

|                          | How it runs                                                                                           | Can it be a pane?                                              |
| ------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **`Task` sub-agents**    | in-process, share the one stdout                                                                      | **No** — one PTY                                               |
| **Agent-team teammates** | Claude spawns **separate CLI processes** and drives them via **tmux commands** (`teammateMode: tmux`) | **Yes** — each is its own process → its own PTY → its own pane |

The teammate case is tractable **because Claude, in tmux mode, externalises the team as tmux operations.**
If we make minmux answer those tmux operations, teammates become our panes. That's the whole idea.

---

## 3. Mechanism: impersonate `tmux` (a shim), don't implement it

Claude's `teammateMode: tmux` (a) checks it's "inside tmux" (via `$TMUX`), then (b) shells out to `tmux`
for `split-window`, `send-keys`, `capture-pane`, etc. We exploit both:

1. **Spoof `$TMUX`** in the lead `claude`'s environment so it believes it's in a tmux session and takes
   the tmux path.
2. **Put a fake `tmux` on `PATH`** (our shim) ahead of any real tmux. Every `tmux …` call Claude makes
   hits our shim, which forwards a structured request to minmux over a socket and prints back the
   tmux-shaped output Claude expects.

This is the **cmux approach** (validated in the wild) and is far lighter than implementing the tmux
control protocol (`tmux -CC`): we only emulate the handful of subcommands Claude actually calls.

```
  lead pane: `claude --teammate-mode` (env: $TMUX spoofed, PATH has our shim,
                                            MINMUX_TMUX_SOCK, MINMUX_LEAD_SESSION)
        │  runs `tmux split-window -- claude <teammate…>`
        ▼
  our `tmux` shim (tiny bin)  ──JSON over unix socket──►  minmux main (tmux-shim server)
        ▲  prints tmux-shaped stdout (pane id, capture text, …)   │
        └──────────────────────────────────────────────────────  │ spawn PTY + tell renderer
                                                                   ▼
                                    node-pty (teammate)  +  renderer inserts a pane leaf
                                                            in the lead's tab (attach-or-spawn)
                                                                   ▼
                              a real minmux pane with our existing status / cwd / sidebar entry
```

---

## 4. Components

| Component             | Where                                                                                                        | Job                                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **`tmux` shim**       | new small binary (bundled; Node or a tiny compiled exe)                                                      | Parse `tmux` argv → one socket request; print tmux-shaped stdout/exit code                                             |
| **Shim server**       | `electron/tmux-shim-server.ts` (main)                                                                        | Listen on a per-lead unix socket / named pipe; map requests → PTY + pane ops                                           |
| **Launcher glue**     | `electron/shell-integration.ts` + `pty:spawn`                                                                | When launching an agent in team mode, inject `$TMUX` spoof, `PATH` shim dir, `MINMUX_TMUX_SOCK`, `MINMUX_LEAD_SESSION` |
| **Argv parser**       | `electron/tmux-cmd.ts` (**pure, tested**)                                                                    | `tmux argv → { op, … }` — the risky parsing lives here, unit-tested                                                    |
| **Renderer bridge**   | new IPC event `team:pane` (main→renderer) + a store action                                                   | Insert/remove a teammate pane leaf in the lead's tab; mount via attach-or-spawn                                        |
| **Reuse (unchanged)** | `node-pty`, pane-tree store, `terminal-manager` (attach-or-spawn), status engine, `renderer-policy`, sidebar | Teammate panes ARE normal sessions — everything downstream is free                                                     |

---

## 5. The tmux surface we must emulate

The exact set is **undocumented and version-specific** — so **step 0 is empirical discovery** (§14): run
`claude --teammate-mode tmux` against a _logging_ shim and record every `tmux` invocation. Expected set
(from cmux + tmux norms), each mapped to an minmux op:

| tmux command                                  | Maps to                                                                                                                                            |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `display-message -p '#{...}'` / `has-session` | Answer identity/probe (return the lead's synthetic pane/session id) so Claude believes it's in tmux                                                |
| `split-window [-h/-v] [-c cwd] -- <cmd…>`     | **Spawn** `<cmd>` as a new session (node-pty), **insert a pane** in the lead's tab split in the given direction; return a synthetic pane id (`%N`) |
| `send-keys -t %N <keys> [Enter]`              | **Write** the (key-name-decoded) bytes to pane `%N`'s PTY                                                                                          |
| `capture-pane -t %N -p [-S -N]`               | **Dump** pane `%N`'s buffer text (reuse `OutputBuffer`) → stdout                                                                                   |
| `select-pane -t %N`                           | **Focus** that pane (`setActivePane`)                                                                                                              |
| `kill-pane -t %N`                             | **Kill** that session + remove the pane leaf                                                                                                       |
| `list-panes -F '#{...}'`                      | Enumerate the team's panes in the requested format                                                                                                 |
| `set-option` / `set-hook` / `wait-for` / …    | No-op or minimal stub as discovered                                                                                                                |

Two fiddly bits: **key-name decoding** for `send-keys` (`Enter`→`\r`, `C-c`, hex, literal `-l`), and
**`capture-pane` fidelity** (visible screen vs scrollback ranges). Both are pure and testable.

---

## 6. Teammate lifecycle (reuses attach-or-spawn)

The elegant part: a teammate pane is a **normal minmux session**, just _initiated by the shim_ instead
of the user. PTYs live in main; the pane tree lives in the renderer store — so `split-window` becomes:

1. Shim server (main) allocates a `sessionId`, `pty.spawn`s the teammate command (cwd from `-c`),
   registers it in the `sessions` map exactly like `pty:spawn`.
2. Main emits `team:pane` → renderer: `{ leadSessionId, sessionId, dir, command, args }`.
3. Renderer store inserts a leaf in the **lead's tab** pane-tree, split `dir` from the lead pane.
4. `terminal-manager.attach` runs → `pty:spawn` for an **already-live** id → **reattach path** (rebinds
   output, replays buffer). No double-spawn.
5. From here it's an ordinary pane: OSC-7 cwd, status signals, sidebar row, renderer-policy — **free**.

Teardown: `kill-pane`/teammate exit → remove the leaf + `pty:kill`. Lead session ends → tear down the
whole team (walk the socket's pane set). "One team per session" (Claude's own constraint) keeps this
bounded.

---

## 7. Shim ↔ minmux protocol

- **Transport:** unix domain socket (macOS/Linux) / named pipe (Windows). Path in `MINMUX_TMUX_SOCK`,
  created per lead session when minmux launches the agent in team mode.
- **Framing:** newline-delimited JSON, request→response. The shim blocks on the reply, then emulates
  tmux's stdout + exit code.
- **Context:** `MINMUX_LEAD_SESSION` ties every request to the lead's pane so teammates land in the
  right tab (even with multiple teams across tabs, each lead has its own socket).

```jsonc
// shim → server
{ "op": "split",   "dir": "row|col", "cwd": "/…", "cmd": "claude", "args": ["--teammate", "…"] }
{ "op": "sendKeys","pane": "%3", "data": "review PR\r" }
{ "op": "capture", "pane": "%3", "start": -200 }
{ "op": "kill",    "pane": "%3" }
{ "op": "select",  "pane": "%3" }
{ "op": "list" }
// server → shim
{ "ok": true, "pane": "%3" }              // split/select/kill
{ "ok": true, "text": "…screen dump…" }   // capture
{ "ok": true, "panes": [{ "pane": "%2", "title": "…" }, …] } // list
```

---

## 8. Layout & rendering policy

- **Placement:** teammates stack in a **right-hand column** off the lead (cmux's convention), auto-
  equalising as they spawn/exit — expressible directly in our binary pane-tree (`col` split with the
  lead on the left, a `row`-of-teammates on the right), driven by `react-resizable-panels`.
- **Renderer cost is already handled.** Many teammate panes → **`renderer-policy` already caps WebGL to
  `MAX_WEBGL_PANES` (4) visible**, the rest DOM. No new perf work; the team just obeys the existing
  policy (`GOTCHAS #renderer`). Don't animate the team panes' containers (same gotcha).
- **Status "for free":** each teammate pane feeds the existing status engine (working / needs-input /
  idle) → sidebar dots + the per-tab attention rail. **This is the "show working agents in a tab" ask,
  satisfied without a bespoke view.**

---

## 9. The hard limit, stated plainly

`Task`-tool sub-agents cannot be paned by anyone — one process, one stdout. If we ever want to _hint_ at
them, the only honest source is a **cooperative signal from the agent** (a Claude hook or an OSC the
agent emits), rendered as a non-interactive "N background tasks" badge on the lead pane — never scraped.
Treat that as a separate, optional, clearly-labelled follow-up, not part of this design.

---

## 10. Reattach, persistence, quit

- **Renderer reload:** teammate PTYs live in main (like all sessions) → survive a reload; panes
  re-attach via the existing buffer replay.
- **Full quit:** teammates die with the app (same as every session today); on relaunch the team is _not_
  restored (Claude's teams don't survive either — its docs note no session-resumption for in-process
  teammates). Layout restore should **skip** shim-created panes (they're re-created by the agent, not by
  us) — mark them so `workspace.json` doesn't try to respawn orphans.
- **Socket cleanup:** remove the socket + tear down team panes when the lead session ends.

---

## 11. Alternatives considered (and why the shim)

| Approach                                   | Verdict                                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Scrape the agent's rendered team panel** | ❌ Fragile (UI/ANSI/redraw churn); breaks every version                                                                                |
| **Read `~/.claude/teams/*` + `tasks/*`**   | ⚠️ Works, but couples us to Claude's private on-disk format, is experimental/moving, and is the **control-plane** road (agent lock-in) |
| **Claude hooks → minmux**                  | ⚠️ Cleaner signalling, but still Claude-specific and needs hook setup; good for the §9 _badge_, not for real panes                     |
| **Full tmux `-CC` control mode**           | Heaviest; a whole protocol. More "standard" but far more than we need                                                                  |
| **`tmux` shim on PATH (this doc)**         | ✅ Lightest path to _real panes_; protocol-shaped (not private-file coupling); proven by cmux; reuses all our pane infra               |

Watch **anthropics/claude-code#36926** ("support cmux as a `teammateMode` backend"): if Claude adds
first-class third-party backends, **becoming a registered backend beats shimming** — revisit then.

---

## 12. Risks

- **Undocumented, moving target.** The tmux surface Claude uses isn't a stable contract; it can change
  between Claude versions. Mitigate: keep the parser pure + tested; discovery harness (§14) re-runnable;
  fail _soft_ (an unrecognised `tmux` command → benign no-op + log, never crash the agent).
- **Finicky even for the specialist.** cmux ships this and still has open bugs (teammate tabs not
  opening, capture/attach races, layout mismatches). Budget for rough edges; this is a real project.
- **`send-keys`/`capture-pane` fidelity.** Key decoding and screen-vs-scrollback capture are the classic
  failure points; test heavily.
- **Security/PATH.** The shim dir is prepended to `PATH` only for the agent's env, not globally; the
  socket is per-session, user-only perms.

---

## 13. Scope boundaries (recap)

Teams (not `Task` sub-agents) · Claude Code first (agent-agnostic later) · native shells (WSL later) ·
real panes + existing status (no bespoke dashboard, no scraping, no private-file reads).

---

## 14. Phasing

- **P0 — Discovery.** Logging shim: run `claude --teammate-mode tmux` with `$TMUX` spoofed and record
  every `tmux` invocation + expected stdout. Output: the exact command surface (§5 confirmed).
- **P1 — Minimal loop.** `display-message`/`has-session` probe answers + `split-window` (spawn teammate
  pane) + `send-keys` + `kill-pane`. A teammate appears as a pane, the lead can message it, it tears
  down. Pure `tmux-cmd` parser + socket protocol landed and tested.
- **P2 — Fidelity.** `capture-pane` (buffer dump), `select-pane`, `list-panes`, key-name decoding,
  layout (right column, equalise).
- **P3 — Lifecycle.** Team teardown on lead exit, reattach across reloads, `workspace.json` skips
  shim panes, socket cleanup.
- **P4 — Polish.** Sidebar grouping (team under lead), notifications per teammate, opt-out setting,
  graceful soft-fail on unknown commands.

---

## 15. Testing

- **Pure/unit:** `tmux-cmd` argv parser (every command in §5, key decoding, capture ranges); the socket
  protocol encode/decode. This is where confidence comes from.
- **Manual verify** (can't run in vitest): real `claude --teammate-mode` spawning teammates → panes
  appear, messaging works, teardown clean; ≥5 teammates → renderer-policy holds; unknown `tmux` command
  → soft no-op, agent unaffected.

---

## 16. What it reuses (why it's smaller than it looks)

`node-pty` spawn + `pty:spawn` **attach-or-spawn** · the pane-tree store + `splitActive`-style ops ·
`terminal-manager` mount/reattach · the **status engine** (`signalSession`/`reduceSignals`) → the
per-tab rail that answers the original ask · `renderer-policy` (WebGL cap) · sidebar · the `ipc.ts` seam.
The genuinely **new** surface is small: the shim binary, `tmux-shim-server.ts`, the pure `tmux-cmd.ts`
parser, and one `team:pane` renderer event.
