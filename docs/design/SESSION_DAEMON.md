# Design — Session persistence via a detached daemon

> Let a session **outlive the app**: an `ssh` connection or a running `claude` keeps going after you
> quit, crash, or auto-update smterm; on relaunch you **reattach to the live screen**. Promotes
> `../ARCHITECTURE.md` Appendix A from a sketch to a buildable plan. Companion to `ARCHITECTURE.md`
> (§8/§11 seam, Appendix A) and `ROADMAP.md` → **M5**.

Status: **DRAFT / design discussion** (2026-08-11). No code yet. Supersedes ARCHITECTURE Appendix A.

---

## 1. Goal & the reframe: there are *two* reconnects

The motivating ask — _"stay connected to an ssh session on reconnect"_ — actually bundles **two
different failures** that need **two different mechanisms**. Keeping them separate is what makes the
scope well-defined.

| Failure | Example | Solved by |
|---|---|---|
| **The app disconnects** | You quit / crash / **auto-update** smterm | **The daemon** (this doc) — PTYs live in a process that outlives the window |
| **The network disconnects** | Laptop sleeps, wifi flips, VPN drops | **Wrapping the remote's tmux/mosh** (§9) — the daemon can't save a dead TCP socket |

The daemon keeps the **local** side alive (the `ssh` process, the shell, the agent). It does **not**
resurrect a TCP connection the OS already tore down — when the network drops, `ssh` exits no matter
who owns its PTY. The full _"my remote session survives everything"_ story is therefore
**daemon (app-side) + remote-tmux wrap (network-side)**, and §9 covers the second half.

**Non-goal (be explicit with users): machine reboot.** Processes die on reboot; tmux doesn't survive
it either. The already-shipped **layout restore** (`workspace.json` → respawn fresh shells in the same
cwds) is the fallback there. The daemon adds *live-process* survival on top, not reboot survival.

### 1.1 What it buys us

- ✅ Close/reopen the window → your agent & ssh are **still running**, reattached to their live screen.
- ✅ GUI crash / GPU-process death → shells survive.
- ✅ **Auto-update** the app → sessions ride through the restart (this is new since Appendix A — see §6).
- ✅ (Stage 4) Attach from a **second window** / a `smterm attach` CLI.
- ❌ Machine reboot. ❌ A remote session whose network died _without_ a remote multiplexer (→ §9).

---

## 2. The core move: split the PTY owner from the UI

Today the Electron **main process** owns the `node-pty` map _and_ the window, so PTYs die with a full
quit (they already survive a *renderer* reload via attach-or-spawn — see `GOTCHAS.md#session-survival`).
Persistence means moving PTY ownership into a long-lived, **detached daemon** (`smterm-daemon`, a
separate Node process), with the Electron app as a **thin client** that connects over a socket, sends
keystrokes/resizes, and paints byte streams. Same client/server split as tmux, zellij, and
`wezterm-mux-server`.

```
 ┌─────────────────────────────┐          ┌──────────────────────────────────────┐
 │  smterm app (Electron)      │  socket  │  smterm-daemon (detached, long-lived)  │
 │  main = THIN CLIENT ────────┼──────────┼─▶ node-pty map (the real PTYs)         │
 │  renderer = xterm.js        │  framed  │   @xterm/headless model per session    │
 │                             │  msgs    │   bounded scrollback ring per session  │
 └─────────────────────────────┘          └──────────────────────────────────────┘
      dies / reloads / updates freely            keeps PTYs + screen model alive
```

The insulation for this already exists (Appendix A.6): the renderer only ever talks to
`src/lib/ipc.ts` (`ptySpawn/ptyWrite/ptyResize/ptyKill` + a per-session data stream). **v1 backs that
seam with the in-process `node-pty` map; the daemon becomes a *second implementation of the same
seam*.** Nothing above `ipc.ts` should know whether the PTY is in-process or across a socket.

---

## 3. The hard part: the daemon models the *screen*, not a byte pipe

This is where ~80% of the difficulty lives, and what separates "a persistent process" from "a good
reattach."

Today's reload-reattach replays a ~256 KB **raw-byte** ring because xterm often still holds state
(`electron/output-buffer.ts`). A **cold** reattach — the app fully died and relaunched — can't do
that: replaying raw bytes from a ring reproduces *history*, not the **current screen** (and for an
alt-screen TUI it's outright wrong). So the daemon must keep a **headless terminal emulator per
session** and, on attach, hand the client a **snapshot that repaints the current screen**.

- **Emulator:** `@xterm/headless` (xterm.js's headless build — identical VT semantics to our
  renderer, so what the daemon models == what the app would draw). Feed PTY output into it **and**
  fan raw bytes out to attached clients concurrently.
- **Snapshot:** `@xterm/addon-serialize` emits the reconstructing escape sequences for the current
  grid + cursor + modes. Attach flow: `attach(id, cols, rows)` → daemon replies with the serialized
  snapshot (initial paint) → then streams live bytes.

**Fidelity cases that will eat the time** (these are the real work, not the socket plumbing):
- **Alt-screen TUIs** — `vim`, `htop`, `less`, **Claude's own TUI**: the snapshot must restore the
  alternate buffer, cursor position, and **mouse mode**, so reattach lands you *inside* the app, not
  at a bare prompt. (Ties into the existing mouse-mode-reset gotcha.)
- **Reflow on resize** — reattaching at a different window size must reflow the headless grid to the
  new client cols/rows before painting.
- **Scrollback bound** — how much history the daemon keeps per session (memory vs. "scroll up after
  reattach"). Start bounded (e.g. N lines), make it a setting later.
- **cwd / status / title** — OSC-7 cwd, OSC-133 command status, OSC-0/2 title must be **tracked in
  the daemon** (or re-derived) so a reattaching client shows current cwd/status/branch immediately,
  not only after the next prompt.

---

## 4. Transport & protocol

- **Transport:** Unix domain socket (macOS/Linux) / named pipe (Windows), in a user-private dir.
  Never TCP unless/until a deliberate remote-daemon feature (Stage 4) — and never by default.
- **Framing:** length-prefixed framed messages. A **small, frozen** verb set:
  `spawn · attach · write · resize · data · snapshot · exit · list · kill`.
- **The daemon stays DUMB.** It multiplexes PTYs, runs the headless model, and ring-buffers output.
  **All product logic stays in the client** (shell integration injection, WSL translation, hook
  wiring, agent graph, session labels). This is the single most important protocol rule — see §6.

### 4.1 Lifecycle

- **Discover-or-spawn:** on app start the client looks for a live daemon via pidfile + socket; if
  none, it spawns one (detached, `unref`'d) and hands off. If one exists, it just connects.
- **Child cleanup moves to the daemon.** The `before-quit` guard's job changes from "kill or confirm"
  to "detach" (§8).
- **Orphan reaping:** the daemon auto-exits when it has **no sessions AND no clients** for a grace
  period. A daemon holding live sessions never auto-exits.
- **node-pty in the daemon:** it's a native module, so the daemon is a packaged Node process that
  ships the prebuilt `node-pty` for each platform (same `electron-rebuild` concern, different host).

---

## 5. Performance: the extra hop

We care about the terminal hot path, so the daemon must not tax it.

- **Output path** gains: `pty → headless-parse + fan-out → socket → app main → renderer → xterm`.
  The headless parse is **CPU-per-byte** — it must run *concurrently with* raw-byte forwarding, never
  gate it. The `OutputCoalescer` + backpressure (`docs/PERF.md`) move to the **socket boundary**.
- **Input path** gains one local-socket round-trip (`app → socket → daemon → pty`). A warm Unix
  socket is sub-millisecond, but **we gate each stage on measuring it** with the `SMTERM_PERF=1`
  harness. Proposed budget: **< 1–2 ms** added keystroke-to-PTY latency; regressions block the stage.
- Snapshot cost is paid **once per attach**, off the steady-state path.

---

## 6. Auto-update × the daemon (new since Appendix A)

We now ship update-awareness (#45) and auto-update is on the roadmap. A detached daemon complicates
it: after the app updates, the **old-version daemon is still holding live sessions**.

**Policy: keep the daemon thin and its protocol frozen (§4), so a *new* client speaks to an *old*
daemon fine.** On update: new sessions spawn on a freshly-started daemon; the old daemon **drains**
(keeps its sessions until they end) and exits when empty. No forced session kill on update.

The rejected alternative — a "smart", version-matched daemon — turns every update into a forced
disconnect. The frozen-thin-protocol rule (already the spirit of A.6) is what makes persistence and
auto-update coexist; it's non-negotiable for that reason.

---

## 7. Security

- Socket/pipe in a **user-only** location: `0700` dir + `0600` socket on Unix; a restrictive ACL on
  the Windows named pipe. A PTY may hold ssh credentials or a live agent session — another local user
  must not be able to attach.
- No network exposure by default (§4). Any future remote-attach (Stage 4) is a separate, explicit,
  authenticated feature — not a side effect of the local daemon.

---

## 8. UX

- **Quit semantics change.** Today's `before-quit` confirm becomes a choice (remembered as a setting):
  **"Keep sessions running in the background"** (default) vs **"Close everything."**
- **Persistence is visible, not surprising.** A per-session "persistent / detached" indicator, and a
  small **"N background sessions"** hint — a natural fit for the status bar we just shipped (#45).
- **Relaunch = auto-reattach.** Restore the layout (already shipped) *and* reconnect each pane to its
  live daemon session, with a subtle "reconnected" cue. If a session is gone (reboot), fall back to
  the existing respawn-fresh-in-cwd behavior.

---

## 9. Remote sessions: wrap the remote's tmux, don't ship a daemon (Appendix A.5)

The second half of the ssh story. A **remote session** is a local session whose command is
`ssh <host> -t 'tmux new -A -s <name>'` (or `mosh … tmux …`). Persistence for the *network* drop lives
in the **remote's** tmux; on reconnect, ssh re-establishes and re-attaches the same tmux. Our daemon
only owns the local `ssh` process — we **never deploy our binary to every host**.

- The local daemon (§2–§8) + a remote multiplexer together give: quit the app *and* drop the network,
  reattach, and the remote work is still there.
- First-class UX: a "New remote session" affordance that builds the `ssh -t 'tmux new -A'` command,
  with mosh as an option for roaming. Bundling/one-liner install of tmux on the remote is a
  nice-to-have, not a requirement (users mostly have it).

---

## 10. Cross-cutting interplay

- **Agent hooks (file-drop).** The observability watcher (`electron/agent-hooks.ts`) is already
  transport-independent — Claude writes event files, the app watches them. It can keep running in the
  **app**, not the daemon; sessions moving to the daemon doesn't change it. (Confirm: the app still
  resolves `SMTERM_PANE_ID` → pane; the daemon just carries the env through on spawn.)
- **WSL.** The daemon spawns `wsl.exe` exactly as main does today; all the WSL translation
  (`wsl-paths.ts`, distro resolution) stays **client-side** per §4 — the daemon just runs the command
  it's handed. A Windows-hosted daemon owning a `wsl.exe` PTY is the same shape as now.
- **Token/transcript reads** stay in the app (they read files by path); unaffected.

---

## 11. Staged build plan

Appendix A had the *what*; this is the *order*, chosen to ship value early and defer the scary parts.

- **Stage 0 — done.** Stable `ipc.ts` seam (A.6). ✅
- **Stage 1 — pty-host child + screen model, still app-lifetime.** Move `node-pty` into a forked
  child speaking the framed protocol; add `@xterm/headless` per session for snapshotting;
  reattach-after-reload goes through it. Ships: cleaner separation + **snapshot-based repaint** (already
  better than raw replay) and the **perf validation** of the hop. *No detached-lifecycle risk yet.*
- **Stage 2 — detach it (the M5 headline).** Host survives full quit/crash/update: discover-or-spawn,
  pidfile/socket, version handshake, orphan reaping, auto-reattach on relaunch, the quit-UX of §8.
  Ships: _"close/reopen/crash/update → your agent & ssh are still running."_
- **Stage 3 — remote ergonomics (§9).** First-class remote sessions wrapping `ssh -t 'tmux new -A'` /
  mosh. Ships: the full network-drop-survives story.
- **Stage 4 — future.** Multi-client attach, `smterm attach` CLI, opt-in headless/remote daemon.

Stage 1 de-risks the emulator/perf work; Stage 2 delivers the headline; Stage 3 completes the
motivating example.

---

## 12. Open questions / decisions needed

1. **Build-local, wrap-remote — confirm.** Home-grown `smterm-daemon` for local (uniform across
   macOS/Windows/Linux/WSL, clean UX); wrap tmux/mosh only for remote (§9). Using tmux/zellij *under
   the hood locally* would drop Windows and impose foreign semantics — recommend against.
2. **Quit default (§8).** "Keep running in background" as the default, or opt-in per session?
3. **Perf budget (§5).** Confirm the < 1–2 ms added-latency gate for Stage 1.
4. **v1 scope.** Is app-side survival (Stage 1 + 2) the first shippable milestone, with remote
   (Stage 3) as a fast-follow?
5. **Scrollback bound (§3).** Starting cap per session, and whether it's a setting from day one.

---

## 13. Complexity & effort estimate

> Rough, for scoping only — **±40%** given the novelty. Calibrated to the current codebase
> (~7.9k prod + ~4.2k test LoC; dense — `output-buffer.ts` is 45 lines). Not a commitment.

| Stage / component | Prod LoC | Test LoC | Complexity | Key risk |
|---|---|---|---|---|
| Shared: protocol + framing | 120–180 | 120 | Med | partial-read/frame edges |
| **Stage 1 — pty-host child + screen model** | | | **High** | |
| · host process (socket server + pty map; mostly relocated) | 250–400 | 150 | Med-High | backpressure, disconnects |
| · headless emulator per session (`@xterm/headless` + serialize) | 120–200 | 100 | Med-High | **fidelity wildcard** |
| · client side in app (main proxies to socket) | 200–300 | 120 | Med | rewire the `ipc.ts` seam |
| · fork + socket lifecycle (app-owned; kills on quit) | 80–150 | 60 | Med | **native-module-in-child packaging** |
| · snapshot→reattach + perf validation | 100–200 | 60 | Low-Med | measure the hop |
| **Stage 2 — detach it (M5 headline)** | | | **High** | |
| · detached lifecycle (pidfile, discover-or-spawn, unref, handshake, reap) | 200–350 | 150 | High | **cross-platform detach** |
| · auto-reattach on relaunch + fallback | 150–250 | 100 | Med-High | layout↔session mapping |
| · quit-UX (keep/close, indicators, status hint) | 150–250 | 100 | Med | low |
| · security (0600 socket / pipe ACL) + auto-update drain | 120–230 | 100 | Med-High | Windows ACL, drain policy |
| **Stage 3 — remote (wrap tmux/mosh)** | | | **Med** | |
| · remote-session command builder + UX | 200–350 | 120 | Med | ssh auth / host-key prompts |
| · reconnect ergonomics | 100–200 | 60 | Med | detect exit vs detach |

**Totals by scope:**
- **Stage 1 only** (refactor + screen model, no survival yet): **~1,800–2,300 LoC**.
- **Stage 1 + 2** (app-side survival — the headline): **~3,000–4,000 LoC**.
- **Stage 1 + 2 + 3** (full "ssh survives everything"): **~3,500–4,800 LoC** — ~**+30–40%** on the
  current codebase. A new subsystem, not a feature.

**LoC undersells it — the risk concentrates in ~500 lines of glue.** Three wildcards drive the real
effort:
1. **Screen-model fidelity** (Stage 1). `@xterm/headless` + `addon-serialize` is purpose-built for
   this so it'll _mostly_ work fast; the last mile — alt-screen apps (vim/htop/**Claude's TUI**),
   mouse modes, reflow-on-resize — is where "reattach repaints slightly wrong" bugs live. Hard to
   unit-test; needs a **manual TUI matrix**. Biggest single uncertainty.
2. **Cross-platform detached lifecycle** (Stage 2). Outliving the app + reconnecting differs on
   Windows (named pipes; no Unix `unref`-to-daemon trick) vs Unix; stale sockets, two-instance races.
3. **Native-module packaging for the helper** (Stage 1). `node-pty` prebuilt + loaded in a
   *separately-spawned* process (not Electron main), through electron-builder, on three platforms — a
   known rabbit hole.

**De-risks it:** Stage 0 done (the seam); `output-buffer`/`coalescer` already factored; Stage 1 keeps
app-lifetime so the emulator + perf are validated *before* the detached-lifecycle work.
**Blows it up:** headless fidelity forcing a custom VT layer (unlikely), or deep Windows detach
issues. For scale: the whole token feature (#43/#44) was ~500 LoC — this is ~7–10× the code and much
higher in novelty/risk. Stage 1 = most novel work / low external risk; Stage 2 = less code, highest
bug risk; Stage 3 = most code-for-least-risk (tmux does the hard part).

---

## 14. References

- `../ARCHITECTURE.md` Appendix A (the original sketch this supersedes), §8/§11 (the `ipc.ts` seam).
- `GOTCHAS.md#session-survival` (current PTY lifetime + reload-reattach).
- `docs/PERF.md` (the coalescer + the `SMTERM_PERF` harness the perf gate uses).
- Prior art: tmux (control mode `-CC`, as in iTerm2), `wezterm-mux-server`, VS Code's pty-host +
  persistent sessions, zellij.
