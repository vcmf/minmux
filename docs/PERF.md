# minmux — Performance & Load Testing

Companion to [ROADMAP.md](./ROADMAP.md) M3.6 Track B. This is the **methodology + baselines**;
optimizations land against these numbers (measure → fix → re-measure, never optimize blind).

## How to run

```
MINMUX_PERF=1 make run     # runs the suite once on launch, prints a [PERF] JSON line to stdout
```

Or, in DevTools console of a normal run: `await window.__minmuxPerf()`.

The harness lives in [`src/lib/perf.ts`](./src/lib/perf.ts) (dev-only; gated by `MINMUX_PERF`, never
runs in normal use). It uses the real Electron renderer (real WebGL) and the real `node-pty`/IPC path.

## What it measures

| Scenario     | Path exercised                                     | Metric                       |
| ------------ | -------------------------------------------------- | ---------------------------- |
| **renderer** | `term.write` → xterm parse → WebGL (no PTY/IPC)    | MB/s to drain 20 MB          |
| **e2e**      | shell → node-pty → **main→renderer IPC** → write   | MB/s + **IPC message count** |
| **idle**     | app sitting still (git poll, clock, status timers) | main/renderer CPU %          |
| **memory**   | RSS per process after the run                      | main / renderer / GPU MB     |

`app.getAppMetrics()` (main) supplies CPU/RSS. The e2e generator is a deterministic
`yes | head -n N` firehose bracketed by concatenation-built markers (so the shell's echo of the
command line doesn't trip the timing — see the comment in `perf.ts`).

## Baselines

Machine: Apple Silicon MacBook Pro, macOS, zsh (with shell integration). Dev build.

**Output IPC coalescing — fair A/B** (interleaved, same machine state; `MINMUX_NO_COALESCE=1` toggles
the old per-chunk path). This is the honest comparison; absolute MB/s drifts with machine load, so
compare the two columns to each other, not across sessions.

| Metric (14.5 MB firehose) | per-chunk (before) | **coalesced (after)** | Δ           |
| ------------------------- | ------------------ | --------------------- | ----------- |
| End-to-end throughput     | ~21 MB/s           | **~34 MB/s**          | **1.6× ↑**  |
| IPC messages              | ~17,700            | **~108**              | **≈165× ↓** |

Other baselines (2026-07-08):

| Metric                         | Value                  | Notes                                  |
| ------------------------------ | ---------------------- | -------------------------------------- |
| Renderer throughput            | **~49 MB/s**           | 20 MB via xterm+WebGL (no PTY/IPC)     |
| Idle CPU (main / renderer)     | **0% / 0%**            | background timers are effectively free |
| Memory (main / renderer / GPU) | **~140 / 250 / 80 MB** | ~480 MB total (Electron baseline)      |

## Findings & next steps

1. **IPC coalescing — done ✅.** Batching PTY output in main (`electron/coalescer.ts`, 4 ms / 256 KB
   flush) cut messages ~165× and raised throughput ~1.6× (numbers above). The message-count drop also
   slashes per-byte CPU, which matters most with **many concurrent busy panes**. Toggle the old path
   with `MINMUX_NO_COALESCE=1` for regression A/Bs.
2. **Flow control (next candidate).** Under a sustained firehose, pause `node-pty` when xterm's
   `write()` callback backlog grows and resume when drained, so the PTY can't outrun the renderer /
   balloon memory. Measure first — may not be worth it now that message overhead is gone.
3. **Idle is already fine** — no action; keep it that way as features add timers.
4. **Not yet measured** (add scenarios as needed): input latency, N-busy-panes CPU/RSS scaling,
   huge-repo git-poll cost, and React re-render counts under high-frequency status updates.
