# minmux docs

Project documentation. Code lives above this folder; the two docs that stay at the repo root are
`README.md` (the public/GitHub readme) and `CLAUDE.md` (agent instructions, auto-loaded by Claude
Code — nested `electron/CLAUDE.md` too).

## Reference (living docs)

| Doc                                  | What                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------ |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System design, seams, decisions (incl. the Tauri→Electron pivot, Appendix A daemon). |
| [ROADMAP.md](./ROADMAP.md)           | Milestones + status. Update as we go.                                                |
| [GOTCHAS.md](./GOTCHAS.md)           | The non-obvious traps, with the _why_. Each has a one-line flag in `CLAUDE.md`.      |
| [TESTING.md](./TESTING.md)           | Where tests live, patterns, gates; real-app checks via the `run-minmux` skill.       |
| [PERF.md](./PERF.md)                 | Performance methodology + baselines (`MINMUX_PERF=1` harness).                       |

## Research

| Doc                                                    | What                                                     |
| ------------------------------------------------------ | -------------------------------------------------------- |
| [COMPETITIVE_LANDSCAPE.md](./COMPETITIVE_LANDSCAPE.md) | Where minmux's wedge is vs cmux/Warp/Cursor/etc.         |
| [mux_product_spec.md](./mux_product_spec.md)           | The `mux` product/visual spec we adopted for the design. |

## Design docs / RFCs — [`design/`](./design/)

Proposals and forward-looking designs (written before/at a decision; may be ahead of the code).

| Doc                                                              | What                                                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [design/AGENT_OBSERVABILITY.md](./design/AGENT_OBSERVABILITY.md) | **M6** — live agents & worktrees board via Claude hooks + OTEL.                  |
| [design/AGENT_TEAMS.md](./design/AGENT_TEAMS.md)                 | Surfacing agent teammates as native panes (tmux-shim sketch; future/standalone). |

## Archive — [`archive/`](./archive/)

Resolved investigations, kept for history (not current guidance).

| Doc                                                          | What                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| [archive/RENDERING_ISSUES.md](./archive/RENDERING_ISSUES.md) | The WebGL glyph-garble investigation — resolved (see `GOTCHAS.md#renderer`). |

## Conventions

- **Reference docs** are living — edit in place.
- **Design docs** capture a proposal + trade-offs; when superseded, note it at the top rather than
  deleting (keep the reasoning trail).
- **Archive** holds finished investigations; move a doc here instead of deleting when it has
  historical value.
