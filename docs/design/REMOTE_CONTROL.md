# Remote control

Control minmux panes from a phone browser or from minmux on another machine, over the user's
Tailscale tailnet. Replaces the October phone-connect design (`term-phone-connect/docs/DESIGN.md`
rev 2) for now: no relay, no hosted page, no paid tier, no infrastructure of our own. Its
non-transport rules carry over (separate tap and coalescer for remote clients, epoch + offset,
answers validated in main by `waitId`, per-device permissions, clients swallow report sequences).

## Problem

minmux runs a dozen agents on one machine. Away from it (on the phone, or at another computer)
there's no way to see which ones wait for you, read what they did, or send the next message.

## Goals

- From a **phone browser**: list the panes of a minmux on one of my machines, open one, read it,
  send a message, answer an agent's question.
- From **minmux on another machine**: the same panes, opened as pane tabs, with full terminal
  input.
- **Only my devices.** Reachable over my tailnet only, and only by devices I approved.
- **No server of our own.** minmux serves the phone's web app itself.
- **Performance**: zero cost when nobody is connected; with clients connected, no measurable
  change to keystroke latency or main's event loop (gates in "Performance").

## Non-goals

- Users without Tailscale (relay tier: dropped for now; the transport is one module).
- Waking a sleeping machine, or keeping it awake. Quitting minmux ends remote sessions.
- Several people sharing one machine's minmux. One user, their devices.
- Chat view for ssh panes (their transcripts live on the host). They get Terminal view.
- Tailscale running inside WSL on Windows: the Windows Tailscale client is required.

## Decisions (2026-11-26/27, with the user)

| Question                    | Decision                                                                                             |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| Transport                   | Tailscale only. Both devices run Tailscale signed in to the same account                             |
| QR code                     | Only a shortcut for the first visit: a QR of the plain address, no secret in it                      |
| Pairing                     | Tailscale identity + approval on the desktop with a matching short code                              |
| Server for the web app      | minmux itself, from the remote-host worker                                                           |
| HTTP or HTTPS               | Plain HTTP on the Tailscale address first; `tailscale serve` HTTPS in step 6                         |
| Phone view of an agent pane | Chat view from the transcript first; Terminal view next                                              |
| Phone resizing the PTY      | Never. A minmux peer may drive the size while it has focus (step 5)                                  |
| Default device permission   | Send: view, send messages, answer. Raw keys is a per-device upgrade                                  |
| On or off by default        | Off until turned on in Settings (it opens a door to a shell)                                         |
| Repo                        | All in minmux                                                                                        |
| Expiry                      | Locked after 24 h without use, unlocked with a PIN set on the Mac; expired after 30 days without use |
| Messages while offline      | Never queued; one retry with the same id on reconnect, then "not sent, retry?"                       |

## Terms

- **Pane** in this doc and the protocol: one terminal session, keyed by its session id (the
  `sessions` key in main, `AgentEvent.paneId`), not `PaneLeaf.id`. Folder and file surfaces are
  not listed.
- **Client**: one browser tab or one minmux on another machine, with one WebSocket.
- **Device**: a Tailscale node approved by the user. One device can have several clients.

## Architecture

```
 Machine A                                                          Phone / Machine B
 ──────────────────────────────────────────────────────────         ───────────────────
 PTY ── main (node-pty, coalescer) ──► renderer (xterm)    hot path, unchanged
          │  ▲  · device table + permission checks
          │  │  · wait tracker (step 4) · pane-list cache
          │  │ write { device, pane, kind, bytes } → checked in main → proc.write
          ▼  │
        remote-host  (utilityProcess, started only when Remote control is on)
          · HTTP: the web app's static files · WebSocket per client
          · identity (tailscale whois), Host / Origin checks
          · chat feed: reads agent transcripts
          · terminal feed (step 3): coalescer per client, headless xterm, backpressure
          │
          └── listens on the Tailscale addresses only ── tailnet (WireGuard) ──► browser / minmux
```

**remote-host** is a `utilityProcess` like `fs-worker` and `sessions-worker`: its own event loop
and heap, so its parsing, compression and socket work never run on main's thread. Main forks it
when Remote control is turned on and kills it when it's turned off; with it off, main has no
remote code on any path.

The worker parses untrusted network input in a full Node process, so it is **not trusted with
authority**. The device table, tokens and permissions live in main; the worker forwards the
device id it authenticated, and main decides. A compromised worker can impersonate an approved
device (it holds the sockets) but can't raise a device's permission or reach a pane it isn't
allowed to.

### What main does

- **Pane list.** The renderer owns tabs, titles and per-pane status. While at least one client is
  connected, it pushes a summary on a new channel `remote:panes`: per tab, per pane `{ id, title,
tab, kind, agent, status, cwd, branch, started, paste }`. Computed in the existing store
  subscription (not a React hook), on change, at most 4 per second.
  - `status` for remote use is computed **without the visible-pane suppression** of
    `reduceSignals` (the pane left focused on the desktop must still show "needs input" on the
    phone). For agent panes it comes from the agent graph's state; for shells from a second
    signals fold with `visible = false`, kept only while clients are connected.
  - `paste`: the pane's xterm `modes.bracketedPasteMode`, read when the summary is built. It
    decides how `send` writes (below), with no scanning of the output stream.
  - **No window** (macOS ⌘W keeps sessions running headless, `main.ts` `close` handler): main
    keeps the last summary, marks it `stale`, and fills panes the summary doesn't know from
    `sessions`. The phone shows "desktop window closed: list may be out of date". Device
    approval doesn't need the renderer (below).
- **Agent sessions per pane.** Main forwards to the worker, per pane, the lead session's
  `{ agent, sessionId, transcripts }`, where `transcripts` are the host paths from
  `transcriptTargets(p, paneId)` (WSL panes on Windows resolve through their distro), plus a nudge
  on each hook event so the chat feed reads new lines promptly. No transcript is read in main.
- **Writes.** The worker sends `{ device, pane, kind: "send" | "answer" | "keys", bytes }`. Main
  checks the device's permission for `kind`, the pane exists, and goes through the same guard as
  `pty:write` (a pending ssh spawn swallows it). Capped at 16 KB.
- **Terminal tap (step 3).** In `startPty`'s coalescer callback, after `emit(rec, d)`: if
  `rec.remoteWatchers > 0`, post `{ epoch, offset, d }` to the worker over a dedicated
  `MessagePort`. One integer compare per batch otherwise.

## Identity and devices

1. **Where it listens.** The worker resolves the Tailscale CLI (PATH, `/usr/local/bin`, the macOS
   app bundle `Tailscale.app/Contents/MacOS/Tailscale`, `%ProgramFiles%\Tailscale\tailscale.exe`),
   runs `tailscale ip`, and listens on the IPv4 and IPv6 Tailscale addresses, port 7420
   (configurable). Never `0.0.0.0`, never the LAN. It re-checks every 30 s; Tailscale stopped
   means the server stops and Settings says why. On Windows the first listen raises a Defender
   Firewall prompt: Settings explains it before turning on. On Linux (weak host model) a packet to
   the 100.x address may arrive on any interface; `whois` refuses a non-tailnet source (rule 2), so
   this is covered, and the doc says it.
2. **Who is connecting.** For each new TCP connection, `tailscale whois --json <ip:port>` (cached
   per peer address for 60 s; ~90 ms measured on macOS). Refused with 403 unless:
   - this machine is **not tagged** (`Self.Tags` empty). A tagged machine's user is the shared
     "tagged-devices" user, which would admit every tagged node; on a tagged machine Remote
     control can't be turned on, Settings says why;
   - the peer has no `Node.Tags`, and its `UserProfile.ID` equals `Self.UserID`.
     Connections from this machine itself pass `whois` (it's our node), so the device token is what
     stops a local process (rule 3).
3. **Approval.** Only a **POST from our own page** (its `Origin` must be this server) can start
   one; an `<img>`, a link or a form on another site can't. (Fetch Metadata headers would say
   more, but browsers send them to HTTPS pages only.) The page gets a random
   pending id and shows a **4-character code**. Main shows the prompt as a **native dialog**
   (works with no window): "iphone-15 wants to control minmux. Code K7QM. Allow / View only /
   Deny". Allow binds to that pending id only, and only that page's next poll gets the token.
   One pending prompt per node at a time; at most 3 per node per 10 minutes; a pending prompt
   expires after 2 minutes.
   - The token: 32 random bytes in an `HttpOnly; SameSite=Strict; Path=/` cookie, stored hashed in
     `configDir()/remote-devices.json` with `{ deviceId, nodeId, name, permission, tokenHash,
addedAt, lastSeen }`. A token only works from the node it was issued to (`whois` node id).
     Cookies aren't port-scoped, so another HTTP service on that phone's view of this host could
     receive the cookie; the node binding and the hash make it useless elsewhere.
   - An iOS home-screen app has its own cookie jar: adding to the home screen asks for approval
     again (same flow, the code makes it quick).
   - Settings lists devices: rename, change permission, revoke (closes its sockets at once).
   - Names come from `whois` → `Node.Name`'s first label (`iphone-15`); iOS reports `HostName`
     as `localhost`.
4. **Browser attacks.** Every HTTP request and WebSocket upgrade checks `Host` against this
   machine's MagicDNS name, short name and Tailscale addresses (DNS rebinding); every upgrade and
   every state-changing request checks `Origin` equals the page's own origin (cross-site
   WebSocket, CSRF). The web app ships with a CSP as strict as the renderer's (`electron/csp.ts`).
5. **Encryption.** WireGuard between devices. TLS comes in step 6, for browser features.

Settings shows the address `http://<machine>:7420` with a Copy button and a QR code.

## Protocol

One WebSocket per client at `/ws`, versioned in `hello`. JSON text frames for control, binary
frames for terminal bytes (step 3).

```
client → host
hello      { v, client: "web" | "minmux" }
watch      { pane, view, since? }                  unwatch { pane }   // since: resume point
send       { pane, text, id }                      // composer message, id for dedupe
unlock     { pin }                                 // device locked after 24 h idle
keys       { pane, bytes }                         // raw input, permission "keys"
start      { tab }                                 // step 3: start a tab the desktop never opened
answer     { pane, waitId, choice }                // step 4
drive      { pane, cols, rows } | release { pane } // step 5, minmux peers only

host → client
welcome    { v, machine, device, permission }
locked     { reason: "idle" | "pin-attempts" | "expired" }
ack        { id, ok, reason? }                     // a send was written (or refused)
panes      { tabs[], panes[], stale }              // full list, on change, ≤ 4/s
chat       { pane, items[], before? }              // chat view: items (before = cursor for more)
snapshot   { pane, epoch, offset, cols, rows, screen }   // step 3
output     binary: { pane, epoch, offset } + bytes        // step 3
waiting    { pane, waitId, question, choices[] } | resolved { pane, waitId }   // step 4
stale      { pane }
error      { code, message }
bye        { reason }                              // revoked, turned off, quitting, version
```

A `v` mismatch gets `bye { reason: "version" }` and the page says which side to update (only
minmux peers can differ; the web app comes from the same minmux).

## Connection loss and expiry

### Unstable or lost connections

- **Liveness.** The worker sends a WebSocket ping every 15 s. The client treats 35 s without a
  ping as dead; the worker drops a socket after 45 s without a pong. The phone shows a
  "Reconnecting…" bar and greys out the composer while it's down.
- **Network switches.** The Tailscale address stays the same across Wi-Fi, cellular and DERP
  relays, so a TCP connection often survives a switch. When it doesn't, the client reconnects with
  backoff (1 s, doubling, capped at 30 s), and at once on `visibilitychange` to visible and on
  `online` (iOS kills sockets of a backgrounded page).
- **Resume, not restart.** The client keeps, per watched pane, its last chat item id and its
  terminal `{ epoch, offset }`, and re-sends them in `watch { since }`. The worker answers with what
  was missed when it still has it (chat: items after that id; terminal: bytes after that offset in
  the same epoch, if `OutputBuffer` still holds them), else a fresh feed or snapshot.
- **Sends are never queued while offline.** Each `send` carries a client id; the worker answers
  `ack` once main wrote it (or refused it). An unacked send is retried once on reconnect with the
  same id, and main ignores ids it has seen (last 100 per device, kept 10 minutes), so a message
  can't be typed twice. A send older than 60 s is not retried: the phone shows "not sent, retry?",
  since the agent may have moved on.
- **Host unreachable.** The page can't tell a sleeping Mac from a closed minmux; it says "can't
  reach <machine>: is it awake with minmux running?" and keeps retrying in the background. After a
  minmux restart, approved devices reconnect on their own (the device table is on disk).
- **Visible on the desktop.** While any device is connected, the status bar shows it
  ("iphone-15 connected"); Settings has **Disconnect all**.

### Expiry

- **Locked after 24 h without use.** A device's `lastSeen` (any message from it) older than 24 h
  makes it locked: its token still identifies it, but every message except `unlock` gets
  `locked { reason: "idle" }` and the page asks for the PIN.
- **PIN.** Set on the Mac when Remote control is turned on (6 or more digits), stored in main as
  an scrypt hash, checked in main. A correct PIN unlocks for another 24 h of use. 5 wrong PINs lock
  that device until it's approved again on the Mac (`pin-attempts`); 10 wrong PINs across all
  devices within an hour turn PIN unlocking off until the user turns it back on in Settings. No PIN
  set: a locked device needs approval on the Mac again.
- **Expired after 30 days without use**: the device is removed, as if revoked.
- Turning Remote control off ends every session at once; turning it back on keeps the devices.

## Chat view (step 2)

For panes whose lead is an agent session. The worker reads the transcript itself, incrementally
(offset per file, bounded slices that yield, like `transcript-fold`), and turns it into items:

- `user` (text you sent), `assistant` (text), `tool` (name, one-line summary, first 2 KB of the
  result, collapsed), and `question`: an agent's multiple-choice ask (Claude's `AskUserQuestion`,
  Codex's `request_user_input`, OpenCode's `question` tool) with every question, its options and
  descriptions, whether several can be picked, and the answer once its result is in the
  transcript. Answering it from the phone is step 4. Permission prompts aren't in transcripts:
  they show as the pane's waiting state (from hooks) above the message box.
- Items are upserted by id (a tool's result, a question's answer land on the earlier item).
- When the pane's session ends, its conversation stays on screen until another session leads
  the pane.
- On `watch`: the last 50 items; scrolling up asks for older ones.
- New lines are read on main's hook nudge plus a 1 s poll while watched. A reply shows once it's
  in the transcript, not letter by letter.

Per-agent parsing lives with the agents: a `chat` reader next to each `agents/*-history.ts`
(Claude and Codex JSONL; OpenCode from its SQLite database, read-only, like `opencode-history`
in the sessions worker). Unknown records are skipped; a reader that throws marks the pane "Chat
view unavailable" with a switch to Terminal view. Transcripts stay internal formats: best-effort,
never throw out of the reader.

A shell pane, an ssh pane, or an agent pane before its first hook opens in Terminal view (from
step 3; in step 2 it shows a placeholder).

## Sending only between turns (step 2)

Decided 2026-11-27 with the user, after three review rounds kept finding ways a hook-based
tracker could think no dialog was open while one was on screen: an agent pane takes a phone's
message **only between turns**. `electron/remote/turns.ts` (pure, tested) marks a pane "between"
only on positive evidence from its lead session: Stop, the idle reminder, a fresh SessionStart.
Anything else from it (or its sub-agents) means a turn is on; no event since launch counts as on.
A dialog can only be up during a turn, so a message's Enter can't answer one. Background and
nested sessions in the same pane are left out. Mid-turn the phone lets you write and says the
agent is working; Send waits for the turn to end. Shell panes aren't affected.

Known limit: Claude fires no hook when someone interrupts it at the desktop (Esc, Ctrl+C mid-turn),
so the phone shows "working" until its idle reminder, about a minute later. Taking Esc as a turn's
end isn't safe (it also just closes a dialog while the turn goes on).

The wait tracker below stays for what the phone shows (the "asking" banner and its prompt) and
for step 4's answer cards; it no longer decides whether a message may be sent alone.

## Wait tracker (step 2)

Moved here from step 4 (2026-11-27, with the user): sending needs to know when an agent shows a
dialog, or a message's Enter could answer it. `electron/remote/waits.ts`, pure, its own test
matrix, apart from the renderer's reducer and its known flaw. Main feeds it every hook event
(always, not only while a device is connected), the desktop's answer keys, and pane ends.

- Opens on a permission prompt (Claude's Notification of kind `permission_prompt`, or an unknown
  kind that isn't the idle reminder; Codex's and OpenCode's PermissionRequest) and on a question
  tool starting (PreToolUse of AskUserQuestion, request_user_input, question), per agent (the
  session or a sub-agent) and per tool call when known.
- Closes when that agent moves on: the call finishes (PostToolUse), another call starts
  (Codex sends nothing when answered), PermissionReplied, SubagentStop; for the pane on Stop,
  UserPromptSubmit, SessionStart/End and the idle reminder; when someone at the desktop presses
  an answer key (Enter, Esc, Ctrl+C, a digit 1-9: Esc denies a Claude prompt without any hook); when the
  pane closes.
- The pane list devices get carries `asking` (and the prompt's message) from it. The desktop's
  "needs input" also covers the idle reminder, when a message is exactly what the agent wants, so
  it no longer gates sending.

## Sending a message (step 2)

- **Refused unless the agent is between turns** (above), and while the wait tracker shows a
  dialog. The phone shows "Claude is asking something: answer it on the
  desktop" until step 4 brings answer buttons. Reason: the paste's Enter would confirm the
  highlighted option of a permission dialog, usually "Yes".
- `paste` on (the foreground program enabled bracketed paste): `ESC[200~` + text + `ESC[201~`,
  then `\r` 60 ms later as its own write, after checking again that the pane isn't waiting.
  `paste` off: the text, then `\r`. With no renderer (no `paste` known): agent panes paste, shells
  don't.
- Text is capped at 16 KB and stripped of `ESC` and C0 controls except `\n` and `\t`, so a
  message can't carry key sequences; raw keys need the `keys` permission.
- The desktop shows who typed: a "from iphone-15" chip on the pane's sidebar row for 10 s after a
  remote write.

## Terminal view (step 3)

- **Offsets.** Each PTY session gets a monotonic `bytesIn` counter (chars pushed) and an
  `epoch`. `OutputBuffer` records the absolute offset of its first retained char. The tap sends
  `{ epoch, offset }` of each emitted batch; `reattach` (which resets the coalescer and drops its
  in-flight bytes) and an ssh reconnect bump the epoch explicitly.
- **Snapshot.** On the first `watch` of a pane, main flushes the pane's coalescer, then hands the
  worker the buffer contents up to the emitted offset, with that offset. The worker feeds a
  headless xterm (`@xterm/headless` + `@xterm/addon-serialize`), then applies tap batches from
  that offset on, so nothing is replayed twice. A gap (an offset jump) or a new epoch means a new
  snapshot.
- **Backpressure.** The PTY is never paused for a client. Each socket has a cap on
  `bufferedAmount` (256 KB); over it the worker stops sending that client terminal frames and
  sends `stale`; when it drains, a fresh snapshot. A client over the cap for 30 s is dropped.
- The phone renders with `@xterm/xterm` at the pane's width, scaled to fit, pinch to zoom, and
  swallows report sequences. A keys bar (Esc, Tab, Ctrl-C, arrows, Enter) for `keys` devices.
- Headless terminals are disposed 30 s after the last watcher leaves.
- **Starting a tab** the desktop never opened (lazy start, GOTCHAS #hidden-terminals): a
  terminal-manager path that starts a tab's terminals straight into the parking lot at their last
  saved size, with no layout render, firing the same one-shot agent resume as showing the tab.
  Until step 3, unstarted panes are listed greyed out ("not started on the desktop") and can't be
  opened.

**As built (2026-11-27):**

- A snapshot needs no start offset in `OutputBuffer`: main flushes the coalescer first, so the
  buffer's contents end exactly at `bytesIn`, and the tap carries on from there (a flush emits all
  that's pending, so each batch ends at `bytesIn` too).
- The page never sees raw history: the worker's headless xterm serializes the screen and the last
  500 lines (`@xterm/addon-serialize`).
- The phone's xterm has no input of its own (it never answers terminal queries back into the
  PTY); raw keys go through the keys bar, for devices with the `keys` permission, and count as
  desktop keys for the wait tracker. xterm loads as its own chunk, only when a terminal opens.
- A shell pane opens in Terminal view, an agent pane in Chat; a toggle switches.
- **Starting a tab the desktop never opened moved out of this step**: those panes stay greyed out
  on the phone ("not started on the desktop"). It needs a terminal-manager path that starts into
  the parking lot without a layout, a change on the desktop's own terminal life cycle worth its
  own PR.
- Measured (built app, a phone watching a pane flooding `seq` output, keystroke echo in another
  pane, three interleaved rounds each, two runs): p50 17 ms both ways, p95 24-26 ms watched vs
  23-24 ms unwatched; main's CPU about 6% either way.

## Answering (step 4)

- **Wait tracker in main**: built in step 2 (above). Step 4 gives each wait a `waitId` and adds
  the screen as a further way to close one.
- **Claude** needs the `PermissionRequest` hook added to its armed events (it has `Notification`
  only today, which carries a message and no choices). The hook keeps acking at once; it never
  decides.
- **Screen check.** Before writing answer keys, main asks the worker's headless mirror for the
  pane's screen and checks it shows the dialog the per-agent answer table expects. No match: the
  answer is refused and the phone switches to Terminal view.
- Answer tables per agent in `electron/agents/*`. A prompt without an entry shows its text and
  "Reply in Terminal view", no buttons.
- Codex sends nothing when an approval is answered on the desktop; the screen check is what
  catches a stale wait there.

## minmux on another machine (step 5)

- The sidebar's **Remote** section gets **Machines**: peers from `tailscale status --json`
  (online, untagged, same user, not this machine), probed at `:7420/hello`, polled every 30 s
  while the section is open.
- A machine expands to its tabs and panes. Opening one adds a **remote surface** to the focused
  pane: a terminal surface whose bytes come from the protocol, through `terminal-manager` like any
  terminal (attach / park / WebGL).
- The protocol client runs in a `remote-client` utilityProcess on B; B's renderer reaches it
  through main like any session.
- Size: a remote surface sends `drive` while it has keyboard focus and `release` on blur; A
  applies it and its own pane shows the remote size letterboxed, with a "driven from <machine>"
  chip. A keystroke on A takes the size back.
- B is a device of A, approved once (the approval page opens in B's browser from the Machines
  list).

## HTTPS and notifications (step 6)

- **Use HTTPS**: `tailscale serve --bg` forwarding to a **unix socket** with 0600 permissions (or,
  where serve can't target one, loopback with a per-launch secret header serve can't be given by
  others); never trust `Tailscale-User-*` headers on a port any local process can reach. The
  device token stays required. Needs HTTPS certificates on in the tailnet admin console (detected
  from `CertDomains`); on Linux `tailscale serve` needs root or `tailscale set --operator=$USER`.
  The certificate puts machine and tailnet names in public CT logs; Settings says so.
- Then: home-screen install (manifest + service worker) and Web Push sent by minmux to the
  browser's push service (VAPID keys per machine; payloads encrypted to the device, no terminal
  text).

## Web app

- Its own Vite input (`remote/index.html`, `src/remote/*`) built to `out/remote`; shares `src/lib`
  pure code and the theme tokens, not the desktop store or components. React, as on the desktop;
  `@xterm/xterm` loaded only by Terminal view.
- Layout: pane list grouped by tab (status dot, needs-input first) → pane screen (Chat / Terminal
  toggle, composer, wait card).
- Reconnects and resumes as in "Connection loss and expiry"; a PIN screen when locked.

## Settings

`remote.enabled` (false) · `remote.port` (7420) · PIN (hash, main only) · `remote.https` (false, step 6). A **Remote
control** section: on/off, status (Tailscale missing / signed out / tagged machine / listening at
…), address + Copy + QR, devices (rename / permission / revoke).

## Performance

Rules:

1. Off means no worker and no remote code on any path.
2. Main's added work: forward the pane summary and agent hints while clients are connected; check
   and write remote input. From step 3, one compare per coalesced batch, one `postMessage` per
   batch for watched panes, and a `bytesIn` add per chunk.
3. Parsing, compression (`permessage-deflate`), serialization and socket I/O in the worker.
4. Never pause a PTY or wait on a client.
5. The renderer's summary (and the second signals fold) only while clients are connected.

Gates (`MINMUX_PERF=1`, new scenarios in `src/lib/perf.ts`):

- **idle, Remote on, 0 clients** and **1 idle client**: main CPU unchanged; worker < 1% (step 1).
- **input beside remote**: keystroke p95 with 2 clients watching a firehose pane in Terminal view
  vs none, interleaved A/B; within noise, ≤ 1 ms (step 3).
- **e2e with a watcher**: firehose MB/s and IPC message count unchanged (step 3).
- Bytes per minute to a phone for a working Claude pane, Chat vs Terminal (recorded, step 3).

## Steps

1. **Remote host** (#246): setting, worker lifecycle, CLI lookup, listen + `whois` + tag rules + Host /
   Origin checks, approval (navigation-only, code, native dialog), device table in main, Settings
   section (address, QR, devices), PIN, expiry and lock, pings and reconnect, `hello` / `welcome` / `panes`, renderer summary with remote
   status and the no-window fallback. Web app: pane list. Security pass before merge. Idle gates.
2. **Chat view + send** (#247): per-agent chat readers, chat feed with resume, composer with ids and acks, refuse-while-waiting,
   paste mode, sent-from chip.
3. **Terminal view** (#248): offsets + epoch, resume from an offset, tap, snapshot, headless mirror, backpressure, keys
   permission + keys bar, start-tab. Security pass (raw keys). Input and e2e gates.
4. **Answers** (#249): wait tracker + test matrix, Claude `PermissionRequest`, screen check, answer
   tables, wait cards.
5. **minmux peers** (#250): Machines, remote surfaces, `remote-client` worker, size driving.
6. **HTTPS + notifications** (#251): serve over a unix socket, install, Web Push on waits.

## Risks

- **Remote input is shell access.** Off by default, approval per device, permissions in main,
  Host / Origin checks, a security pass at steps 1 and 3.
- **Transcript formats change**: readers are best-effort; Terminal view is the fallback.
- **Pasted Enter per agent**: the delayed `\r` gets checked against Claude, Codex and OpenCode in
  the real app (step 2).
- **Remote status vs desktop status** can differ for the focused pane by design (the phone isn't
  looking at it). The sidebar is unchanged.
