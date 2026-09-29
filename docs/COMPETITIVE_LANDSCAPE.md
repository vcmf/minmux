# Competitive Landscape — minmux

> Who else is building "run and watch a fleet of coding agents," how they differ, and where
> minmux's wedge is. Companion to `ARCHITECTURE.md` (design) and `ROADMAP.md` (progress).

Status: **living doc** — the space moves fast (tools rename, companies fold). Snapshot as of
**2026-07-06**; re-verify names/status before citing (see §6 for known traps).

> **Verification:** the facts in §3 (stacks, licenses, isolation models, status) were checked via a
> multi-source, adversarially-verified deep-research pass on **2026-07-07** — 21 primary/secondary
> sources, 25 claims put through 3-vote verification (23 confirmed, 2 refuted). Refuted claims and
> known gaps are called out in §6. Findings rest on project READMEs / official vendor docs.

---

## 1. The convergence thesis

Independently, from different starting points, a whole category converged on the same idea in
2025–2026: **a surface for running multiple coding agents in parallel and watching their status.**

- IDEs pivoted toward it — **Cursor 2/3** made an "agent-first" view the default; **VS Code**
  shipped a built-in **Agent Sessions** sidebar (model-agnostic: Claude, Codex, Copilot).
- A crop of standalone tools appeared — terminals, desktop apps, and kanban boards — all solving
  the same two problems:
  1. **Isolation** so parallel agents don't clobber each other's files → almost universally
     **git worktrees** (a few use containers).
  2. **A unified view** of every session's status (running / waiting / done).

So "a dashboard over agents" is now **table stakes, not a differentiator.** The differentiation is
in _form factor_, _cross-platform reach_, _agent-agnosticism_, and _execution quality_ (§4–§5).

---

## 2. The map: two axes

Every tool sits on two axes. This is the useful mental model.

```
                     SURFACE
   terminal-native ◄──────────────────► GUI board / IDE
        │                                     │
        │  cmux, ccmanager,        Conductor, Nimbalyst,
        │  Claude Squad, dmux,     Vibe Kanban, Cursor,
        │  Superset, Paneflow,     VS Code Agent Sessions
        │  amux                    Sculptor
        │
   ─────┼───────────────────────────────────────────  ISOLATION
        │  worktrees (almost everyone)  │  containers (Sculptor)
```

- **Surface** — is the primary object a _terminal/PTY_, or a _board / diff-review GUI_?
- **Isolation** — **git worktree per agent** is the default substrate; **containers** are the
  heavier-isolation outlier.

Crowded corners: **macOS-native terminal** (cmux, Conductor, Paneflow) and **web/kanban boards**
(Vibe Kanban, Nimbalyst). Thin corner → minmux's opening (§5).

---

## 3. The field, by form factor

> **⚠️ Name collision — two different "cmux":**
>
> - **cmux (Manaflow)** — the famous native macOS Ghostty terminal (3a below). GPL/AGPL, YC S24.
> - **cmux (`craigsc/cmux`)** — an unrelated ~560-line **pure-bash** CLI, "tmux for Claude Code":
>   fans a fleet of Claude agents across git worktrees on one repo. Different project, different scale.
>
> When anyone says "cmux," disambiguate which. This doc's "cmux" = Manaflow's unless noted.

### 3a. Terminal-native / TUI managers (minmux's direct neighbors)

Facts marked ✓ were confirmed 3-0 in the 2026-07-07 deep-research verification.

| Tool                | Stack                                                       | Platforms                 | Isolation                                | Agents                                                                                            | License / status                                           |
| ------------------- | ----------------------------------------------------------- | ------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **cmux** (Manaflow) | Native, Ghostty (`libghostty`) GPU engine                   | macOS only                | worktrees                                | Claude Code (breadth uncertain — "Claude-only" claim refuted, see §6)                             | GPL/AGPL. YC S24. ~17k★ in ~2 weeks                        |
| **ccmanager** ✓     | TUI/CLI (no tmux)                                           | Cross-platform            | **worktrees + optional devcontainers** ✓ | **8** ✓: Claude Code, Gemini CLI, Codex CLI, Cursor Agent, Copilot CLI, Cline, OpenCode, Kimi CLI | MIT. minmux's closest on breadth + cross-platform          |
| **Claude Squad** ✓  | Go TUI, tmux                                                | Cross-platform (tmux)     | worktrees ✓                              | Claude Code, Codex, Gemini, Aider, OpenCode, Amp ✓                                                | **AGPL-3.0** ✓ (smtg-ai)                                   |
| **dmux** ✓          | Node CLI, tmux 3.0+                                         | Cross-platform (tmux)     | worktrees (pane = worktree) ✓            | **12** ✓: Claude, Codex, Gemini, Cline, OpenCode, Qwen, Cursor, Copilot, Amp, pi, Crush, Grok     | **MIT** ✓ (standardagents)                                 |
| **craigsc/cmux**    | ~560-line pure bash                                         | Cross-platform (bash+git) | worktrees ✓                              | Claude Code (fleet on one repo)                                                                   | OSS. The _other_ cmux (see collision note)                 |
| **amux**            | Single Python file → HTTPS server + web dashboard over tmux | Cross-platform (tmux)     | tmux sessions                            | multiple                                                                                          | ⚠️ _unverified in this pass_ — self-healing watchdog claim |
| **Superset**        | Terminal built for agents                                   | —                         | —                                        | multiple                                                                                          | ⚠️ _unverified in this pass_                               |
| **Paneflow**        | Native, Rust on Zed's **GPUI**                              | Linux / Windows           | —                                        | —                                                                                                 | ⚠️ _unverified in this pass_ — native non-mac take         |
| **wmux**            | Electron + xterm.js                                         | Windows                   | —                                        | —                                                                                                 | ⚠️ _unverified in this pass_ — Windows port of cmux        |

### 3b. Desktop GUI apps

| Tool                      | Stack       | Platforms                            | Isolation                                                    | Agents                           | License / status                                                                      |
| ------------------------- | ----------- | ------------------------------------ | ------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------- |
| **Conductor** ✓           | Desktop app | **Mac-only** ✓ (Windows waitlist)    | worktrees ✓                                                  | Claude Code, Codex, Cursor ✓     | Closed-source. **Melty Labs**, YC S24                                                 |
| **Crystal → Nimbalyst** ✓ | Electron    | Desktop (+ iOS companion, Nimbalyst) | worktrees ✓                                                  | Codex, Claude Code (+ harnesses) | **Crystal deprecated 2026-02-26** ✓ (frozen ~3,080★) → **Nimbalyst** (MIT), same team |
| **Sculptor** ✓            | Desktop app | Desktop                              | **containers, NOT worktrees** ✓ (worktree claim refuted 0-3) | multiple                         | **MIT** ✓ (Imbue). Experimental research preview; limited external contributions      |

### 3c. Board / Kanban orchestration

| Tool              | Stack                | Isolation   | Agents                                                                             | License / status                                                                                                       |
| ----------------- | -------------------- | ----------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **Vibe Kanban** ✓ | **Rust**, web kanban | worktrees ✓ | **10+** ✓: Claude, Codex, Gemini, Copilot, Amp, Cursor, OpenCode, Droid, CCR, Qwen | **Apache-2.0** ✓. ⚠️ **BloopAI sunsetting ~2026-04-10** ✓ ("couldn't find a business model"); OSS community-maintained |
| **Nimbalyst**     | Electron             | worktrees   | Claude Code, Codex, + harnesses                                                    | MIT; also board-shaped (see 3b)                                                                                        |

### 3d. Built into editors

| Tool                               | Isolation                      | Agents                                                    | Status                                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------ | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Cursor 3.0**                     | worktrees                      | up to **8** parallel                                      | Agents Window (sidebar over all sessions/repos). Released **2026-04-02** ✓. Backlash over agent UI crowding code + non-remappable shortcuts (§4)                                                          |
| **VS Code Agents Window** ✓        | worktrees ✓                    | exactly **3** ✓: Copilot CLI, Copilot Cloud, Claude agent | Preview, shipped **VS Code 1.120, May 2026** ✓. Third-party/local agents managed from the main window                                                                                                     |
| **VS Code Copilot CLI Sessions** ✓ | **Worktree or Folder** modes ✓ | Copilot CLI (background)                                  | Runs multiple CLI sessions in parallel locally via Agent Sessions sidebar. **Only tracks agents launched through / registered with VS Code** — a bare `claude` in a plain terminal is _not_ auto-detected |

### 3e. Not yet mapped (surfaced but unverified — candidates for the next pass)

From `awesome-agent-orchestrators` (claims **46+** "parallel agent runners") and other sources, these
came up but weren't verified here: **SplitMind, Claude Code Crew, Async Code Agent, constellagent,
paperclip, scion, shire, skillfold, swarm-protocol** — plus category-adjacent tools not covered:
**Terragon, Sourcegraph Amp's orchestrator, Warp's agent mode, Zed's agent panel.**

Directories to track (the field moves weekly):

- [awesome-agent-orchestrators](https://github.com/andyrewlee/awesome-agent-orchestrators)
- [awesome-cli-coding-agents](https://github.com/bradAGI/awesome-cli-coding-agents)

---

## 4. Lessons from competitors' criticism (design constraints for us)

The _idea_ is validated everywhere; execution keeps failing on the **same two things**. These are
free lessons — bake them into minmux's design (see `ARCHITECTURE.md` §8, §9).

1. **Respect the primary surface.** Cursor's loudest complaint: the agent/chat chrome _"take[s]
   space more than the actual code."_ → For us the **terminal (PTY) must stay the star**; status is
   ambient badges, not a giant panel that eats the shell.
2. **Respect the keyboard — and let users remap.** Both **cmux** (keyboard shortcuts break after
   opening/closing browser tabs) and **Cursor** (layout shortcuts conflict with custom bindings,
   _not reconfigurable_) drew blood here. → **User-configurable keybindings from v1**; never hijack
   a combo the user can't rebind.
3. **Native ≠ automatically fast or bug-free.** cmux went native explicitly citing perf/input, yet
   ships **laggy scrolling, higher CPU than plain Ghostty**, and input bugs. → Stack choice isn't
   the quality lever; **execution is.** Reassures the Tauri decision (`ARCHITECTURE.md` §3).
4. **Make the escape hatch discoverable.** Cursor's "Classic Editor" existed but users had to be
   _told_ by a moderator. → Any mode/layout switch must be obvious.
5. **Persistence & remote are real gaps users hit.** cmux is **macOS-only with no detach/reattach**
   → "doesn't work on remote terminals." → Our answer is deliberate (`ARCHITECTURE.md` Appendix A):
   local daemon later; **wrap the remote's `tmux`/`mosh`** rather than shipping a remote daemon.

---

## 5. minmux's positioning (the wedge)

Against the map in §2, the thin/open corner is:

> **Genuinely cross-platform (macOS · Linux · Windows · WSL) · terminal-native with real PTYs ·
> lightweight · agent-agnostic.**

How we compare to the two poles we're threading between:

| Dimension                 | cmux                          | ccmanager               | **minmux (target)**                    |
| ------------------------- | ----------------------------- | ----------------------- | -------------------------------------- |
| Surface                   | Native GPU terminal           | TUI (inside a terminal) | GUI terminal (Tauri + xterm.js)        |
| Platforms                 | macOS only                    | Cross-platform          | **mac · Linux · Windows · WSL**        |
| Agent-agnostic            | Yes (runs any CLI)            | **Yes, broadest**       | Yes (any PTY program)                  |
| Footprint                 | Native, but heavy in practice | Tiny (TUI)              | **Small (Tauri, not Electron)**        |
| Native polish             | **Highest**                   | n/a (TUI)               | Mid (webview)                          |
| Notifications / attention | Yes                           | Limited                 | **Headline feature** (OSC 9 / OSC 133) |
| Split panes + tabs GUI    | Yes                           | Limited (TUI)           | **Yes, v1**                            |
| Persistence / reattach    | ❌                            | Via tmux                | Planned (Appendix A)                   |

**Honest read of the competition:**

- **cmux** beats us on native polish but is **macOS-only** — its cross-platform ports are separate
  projects (wmux/Electron, Paneflow/GPUI). One codebase across four targets is our structural edge.
- **ccmanager** is the closest on _agent breadth + cross-platform_, but it's a **TUI** — no native
  GUI tabs/panes, weaker notifications, no OS-native toasts. Our GUI + native notifications is the
  differentiator there.
- **Board tools** (Vibe Kanban, Nimbalyst, Conductor) optimize for _review/PR/kanban_. We optimize
  for **watching live terminals** — a different job. Not a direct fight; a different surface.

**What is NOT a differentiator (don't sell these):** "a view over agents," "worktree isolation,"
"parallel agents." Everyone has them. Our story is **reach + terminal-native + weight + attention
signals**, not the fleet concept itself.

---

## 6. Naming & status traps, and refuted claims (verify before citing)

**Traps:**

- **"cmux" is two projects** — Manaflow's native macOS terminal vs `craigsc/cmux`'s bash script.
  Always disambiguate (see the collision note above §3a).
- **Crystal → Nimbalyst** — renamed; old repo says "Crystal is now Nimbalyst" (deprecated 2026-02-26).
- **Vibe Kanban** — company **BloopAI sunsetting ~2026-04-10** ("couldn't find a business model");
  project continues as Apache-2.0 community-maintained. Alive as OSS, dead as a company.
- **Sculptor** — isolates with **containers**, not worktrees (see refuted claim below). Often listed
  loosely as an "orchestrator" but is a container-based parallel-agent desktop app.

**Refuted in the 2026-07-07 verification (do NOT rely on these):**

- ✗ "cmux (Manaflow) supports only Claude Code" — refuted 1-2. Its multi-agent breadth is genuinely
  uncertain; don't state it either way without checking the current repo.
- ✗ "Sculptor uses git worktrees as primary isolation" — refuted 0-3. It uses **containers**.

**Gaps (named in the question but not verifiable this pass):** amux, Superset, Paneflow, wmux
returned no surviving claims — treat their rows in §3a as provisional until re-verified.

The category is churny — assume any tool here may have renamed, changed license, or folded since this
snapshot. The two directories in §3e are the freshest trackers.

---

## Sources

**Primary (verified 2026-07-07):**

- [Claude Squad — GitHub (smtg-ai/claude-squad)](https://github.com/smtg-ai/claude-squad)
- [ccmanager — GitHub (kbwo/ccmanager)](https://github.com/kbwo/ccmanager)
- [dmux — GitHub (standardagents/dmux)](https://github.com/standardagents/dmux)
- [craigsc/cmux — GitHub (the bash "tmux for Claude Code")](https://github.com/craigsc/cmux)
- [Conductor — conductor.build](https://www.conductor.build/)
- [Crystal → Nimbalyst — GitHub (stravu/crystal)](https://github.com/stravu/crystal)
- [Sculptor — GitHub (imbue-ai/sculptor)](https://github.com/imbue-ai/sculptor) · [Imbue announce](https://imbue.com/blog/sculptor-announce)
- [Vibe Kanban — GitHub (BloopAI/vibe-kanban)](https://github.com/BloopAI/vibe-kanban) · [shutdown post](https://vibekanban.com/blog/shutdown)
- [VS Code Agents Window — docs](https://code.visualstudio.com/docs/agents/agents-window)
- [VS Code Copilot CLI background sessions — docs](https://code.visualstudio.com/docs/copilot/agents/background-agents)

**Secondary / context:**

- [Best AI Agent Multiplexers Compared (2026): 12 Tools Ranked — amux.io](https://amux.io/guides/best-ai-agent-multiplexers-2026/)
- [9 Open-Source Agent Orchestrators for AI Coding (2026) — Augment Code](https://www.augmentcode.com/tools/open-source-agent-orchestrators)
- [cmux — GitHub (manaflow-ai/cmux)](https://github.com/manaflow-ai/cmux)
- [New Coding Model and Agent Interface — Cursor 2.0 changelog](https://cursor.com/changelog/2-0) · [Cursor 3 agent-first — InfoQ](https://www.infoq.com/news/2026/04/cursor-3-agent-first-interface/)
- [Your Home for Multi-Agent Development — VS Code blog](https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development)
- [awesome-agent-orchestrators — GitHub](https://github.com/andyrewlee/awesome-agent-orchestrators) · [awesome-cli-coding-agents — GitHub](https://github.com/bradAGI/awesome-cli-coding-agents)
