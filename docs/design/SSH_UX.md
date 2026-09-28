# SSH remotes: UX review

Tracking doc for the UI/UX pass on SSH remotes (phase 1 shipped on `epic/ssh-remotes`). It
records what the feature looks like today, how comparable products handle the same problems,
the approaches we could take, and what we decide. Design background lives in
[`SSH_REMOTES.md`](./SSH_REMOTES.md); build history in
[`SSH_IMPLEMENTATION_PLAN.md`](./SSH_IMPLEMENTATION_PLAN.md).

Status: **decisions made (2026-09-28)**; S0 done. The recommendations in §3 were accepted with the §6 overrides: per-host colour only when set (no hash), no new picker shortcut, no "Add host…". §5 is the record; build from it. Screenshots are in
[`ssh-ux/`](./ssh-ux/), taken from the built app with a throwaway HOME, a
`~/.ssh/config` (nine `Host` entries, eight listable: `*.corp` is a pattern) and a stub `ssh` that prints a login banner and a prompt.

---

## 1. What we have today

| #   | Screen                                                 | Shot                                                |
| --- | ------------------------------------------------------ | --------------------------------------------------- |
| 1   | Launch: session tree on top, Remote list at the bottom | [01-overview](ssh-ux/01-overview.png)               |
| 2   | New-tab picker with the SSH group                      | [02-picker](ssh-ux/02-picker.png)                   |
| 3   | Palette, typing `host`                                 | [03-palette](ssh-ux/03-palette.png)                 |
| 4   | Connected to one host                                  | [04-connected](ssh-ux/04-connected.png)             |
| 5   | Two hosts split side by side                           | [05-split-two-hosts](ssh-ux/05-split-two-hosts.png) |
| 6   | Changes panel on a remote pane                         | [06-changes-notice](ssh-ux/06-changes-notice.png)   |
| 7   | Connection dropped                                     | [07-closed](ssh-ux/07-closed.png)                   |
| 8   | Password prompt                                        | [08-password](ssh-ux/08-password.png)               |
| 9   | Relaunch with `restore: on-focus`                      | [09-restore-waiting](ssh-ux/09-restore-waiting.png) |
| 10  | Host removed from the config                           | [10-failed](ssh-ux/10-failed.png)                   |
| 11  | No hosts, light theme                                  | [11-empty-light](ssh-ux/11-empty-light.png)         |

What works: one click from the sidebar gets a real shell on the host; splits stay on it; the
pane header carries a globe, an `SSH` badge and, when it matters, a clear Connect / Reconnect /
Retry button; the Changes panel explains itself instead of showing a stale local repo.

### Findings

Severity: **P0** broken, **P1** confusing or slow in daily use, **P2** polish.

| ID  | Sev | Finding                                                                                                                                                                                                                                                                                                               | Shot       |
| --- | --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| F1  | P0  | The "connection closed" line lands on row 2 of the scrollback, over the login banner, instead of below the last prompt. Our mode reset sends `ESC[?1049l` unconditionally; outside the alt screen that also restores a cursor position saved at the start of the session. Only send it when the alt buffer is active. | 07         |
| F2  | P1  | Outside the pane, a dropped, waiting or failed pane looks like any idle shell: the sidebar row says `idle` with a grey dot, the tab has no mark. You only learn a host is down by looking at that pane.                                                                                                               | 07, 09, 10 |
| F3  | P1  | A pane sitting at a password prompt reads `idle`, and the host row shows a green "connected" dot. Nothing says "this one is waiting for you", which is the state smterm is otherwise good at surfacing.                                                                                                               | 08         |
| F4  | P1  | Remote panes look like local ones. The terminal area is identical; the only cues are a 14 px globe and a small `SSH` badge. With a local and a remote pane side by side it is easy to type into the wrong one.                                                                                                        | 04, 05     |
| F5  | P1  | The Remote list is squeezed into the bottom 40% of the sidebar while the session tree above is mostly empty. Five of eight hosts fit; the sixth is cut off under the legend. There is no search, so a long config means scrolling.                                                                                    | 01         |
| F6  | P1  | The palette puts the verb first and the host second, and lists every host twice (Connect, Split right). Eight hosts become 16 rows, and long details wrap the label onto two lines ("Connect to / host").                                                                                                             | 03         |
| F7  | P1  | "Retry" on a host that is gone from the config can never succeed. The useful actions there are "Open ssh config" and "Close pane".                                                                                                                                                                                    | 10         |
| F8  | P2  | The picker wraps long aliases mid-word (`prod-db-replica-eu-` / `west-1`) and shows no user@host, so two similar hosts are hard to tell apart.                                                                                                                                                                        | 02         |
| F9  | P2  | In narrow panes the header truncates the host to one letter (`g…`, `s…`) while the `SSH` badge and four icon buttons keep their space.                                                                                                                                                                                | 06         |
| F10 | P2  | The tab title follows the focused pane, so a tab holding `gpu-box` and `staging-api` is called whichever you clicked last. The sidebar group row does the same.                                                                                                                                                       | 05         |
| F11 | P2  | The pane row's subline `ssh · gpu-box` repeats the title. That line could carry something useful: the user@host, or the connection state.                                                                                                                                                                             | 04         |
| F12 | P2  | Git-only hosts such as `github.com` are listed as places to open a terminal. Hiding them needs a settings.json edit.                                                                                                                                                                                                  | 01         |
| F13 | P2  | The disconnect message is jargon (`code 255`) and offers one key. There is no keyboard way to close the pane from there, and no automatic retry for a blip.                                                                                                                                                           | 07         |
| F14 | P2  | After a relaunch with several waiting panes, each needs its own Enter. There is no "connect all".                                                                                                                                                                                                                     | 09         |
| F15 | P2  | Host row actions (split right, split down) only appear on hover, and there is no context menu for the rest (copy `ssh` command, hide host, open config at this host).                                                                                                                                                 | 01, 05     |
| F16 | P2  | The empty state doesn't say where hosts come from or how to add one.                                                                                                                                                                                                                                                  | 11         |

---

## 2. How other products do it

Condensed from a survey of docs and issue trackers (sources inline). Where a claim couldn't be
confirmed from a source it is marked _unverified_.

- **VS Code Remote-SSH** (Cursor and Windsurf inherit it). A Remote Explorer tree built from
  `~/.ssh/config`, each host expanding into its recent folders; a "Connect to Host…" quick pick;
  "Add New SSH Host" writes into your config file. One remote per window, so every terminal in it
  is remote. The bottom-left status bar item shows `SSH: host` in a themeable colour, which is
  the cue most users rely on. A drop shows a modal "Attempting to reconnect…", and after that
  gives up, "Cannot reconnect. Please reload the window". That last dialog is a long-running
  complaint. ([docs](https://code.visualstudio.com/docs/remote/ssh),
  [#10122](https://github.com/microsoft/vscode-remote-release/issues/10122))
- **JetBrains Gateway.** A form-based wizard with "Test Connection". Once connected, the toolbar
  shows the backend name with latency and memory; clicking it opens a control center with ping,
  CPU, RAM and the server log. ([docs](https://www.jetbrains.com/help/idea/work-inside-remote-project.html))
- **Zed.** A Remote Projects dialog; you paste an `ssh …` command and Zed tests it before saving.
  SSH prompts (host keys, passphrases, passwords) show in Zed's own UI. A remote daemon survives
  drops, though users report it failing to reconnect after sleep.
  ([docs](https://zed.dev/docs/remote-development), [#59344](https://github.com/zed-industries/zed/issues/59344))
- **Warp.** Detects `ssh` and offers to install its extension in-line (always / never / ask, with
  a per-host denylist). Prompt chips show host and cwd. After sleep the UI can keep looking
  connected until you type. ([docs](https://docs.warp.dev/terminal/warpify/ssh),
  [#12687](https://github.com/warpdotdev/warp/issues/12687))
- **Tabby.** Profiles in groups, each with a name, icon and colour that also tints its tabs. On
  disconnect: "Press any key to reconnect". Users asked for Enter = close, R = reconnect, and
  for restoring tabs _without_ reconnecting, with a Reconnect button in the corner.
  ([#4245](https://github.com/Eugeny/tabby/issues/4245),
  [#9865](https://github.com/Eugeny/tabby/discussions/9865))
- **Termius.** A host vault with nested groups and tags, search and a tag filter. Every tab and
  pane header has a status dot: green for new output, **yellow for "requires your input, such as
  a password"**, red for a failed connection.
  ([docs](https://docs.termius.com/terminal/workspaces))
- **Windows Terminal.** Profiles in the new-tab dropdown; an SSH profile generator from the
  OpenSSH config exists (on by default is _unverified_). On exit it prints "[process exited with
  code 255] You can now close this terminal with Ctrl+D, or press Enter to restart".
  ([docs](https://learn.microsoft.com/en-us/windows/terminal/customize-settings/profile-advanced))
- **WezTerm.** SSH domains generated from `~/.ssh/config`, shown in a launcher menu and the
  palette; splits inherit the domain. Plain SSH domains lose their panes on a drop; the
  multiplexed variant can be reattached by hand. ([docs](https://wezterm.org/multiplexing.html))
- **iTerm2.** Automatic profile switching changes colours and badge per host (from shell
  integration). ([docs](https://iterm2.com/documentation-shell-integration.html))
- **kitty.** The ssh kitten can apply a per-host colour scheme while connected, and opens new
  windows on the same host and directory. ([docs](https://sw.kovidgoyal.net/kitty/kittens/ssh/))
- **SecureCRT / MobaXterm.** Session trees with folders. SecureCRT colours tabs for Connected,
  Disconnected and New Input, and has opt-in auto reconnect (guides warn against it on
  production). MobaXterm's stopped session prints "Press Return to exit tab, R to restart, S to
  save output".
- **cmux.** `cmux ssh` makes a workspace per host. Open proposals ask for exactly what smterm
  already does (pane-scoped ssh where splits inherit the host, mixed local and remote in one
  layout) plus saved remotes in the sidebar and auto reconnect.
  ([#7521](https://github.com/manaflow-ai/cmux/issues/7521))

### Patterns worth copying

1. **Config as the source of truth, with a helper to add to it.** VS Code, WezTerm, Windows
   Terminal. We already read the config; the gap is "Add host", which writes a block to it.
2. **A persistent list plus a fuzzy picker, with recents.** Everyone has both. Recents per host
   are common (VS Code folders, Gateway projects).
3. **A strong "this is remote" cue, ideally coloured per host.** VS Code's status bar, kitty and
   iTerm2 per-host colours, Tabby group colours.
4. **Connection state on the pane header and the tab**, with a distinct "needs input" state
   (Termius, SecureCRT). This maps directly onto our existing status dots.
5. **A disconnect message with separate keys for reconnect and close** (Windows Terminal,
   MobaXterm; what Tabby users ask for).
6. **A few automatic retries, then manual**, and restore without connecting as an option (VS
   Code, Cursor, SecureCRT; Tabby users).

### Things to avoid

- A dead end like "please reload the window". Reconnect must always be one action away.
- A UI that keeps saying "connected" after the link died (Warp, Zed after sleep).
- One key that does everything ("press any key to reconnect").
- Auto reconnect that you can't turn off, especially where re-running things is risky.

---

## 3. Approaches

Each question lists options with a recommendation. Decisions go in §5.

### Q1. Where do hosts live?

- **A. Keep the bottom section, fix its sizing.** Give it a real share of the sidebar (resizable
  split with the session tree), add a filter field above the list, pin and recent sort.
  Smallest change.
- **B. A sidebar switcher: Sessions | Remote.** Two tabs at the top of the sidebar, the Remote
  one full height with search, groups and recents (VS Code's Remote Explorer model). More room,
  but hosts are one click further away while you work.
- **C. Palette and picker first, sidebar shows only pinned + connected.** The sidebar keeps a
  short list (pinned hosts and hosts with live panes); everything else is found by typing, in
  a dedicated "Connect to host" picker (⌘⇧K or similar) that shows host first, detail second,
  with split variants as modifiers (⌥↵ split right) rather than duplicate rows.

**Recommendation: C, with A's filter as a fallback.** It fixes F5 and F6 together, scales to
long configs, and keeps the sidebar about what's running.

### Q2. How is connection state shown?

Today the only state lives inside the pane (text + button). Proposal: a remote pane gets its own
status values that reuse the existing dot vocabulary everywhere a pane appears (sidebar row, tab
badge, pane header, bell count).

| State        | Dot                            | Word                | When                                                              |
| ------------ | ------------------------------ | ------------------- | ----------------------------------------------------------------- |
| connecting   | pulsing grey                   | connecting          | spawn requested, nothing printed yet                              |
| needs input  | amber                          | password / host key | the output ends in a password, passphrase, OTP or host-key prompt |
| live         | normal status (idle / running) | as today            | ssh running and past auth                                         |
| disconnected | red                            | disconnected        | ssh exited on its own                                             |
| failed       | red                            | can't connect       | spawn refused                                                     |
| waiting      | hollow                         | not connected       | restored under on-focus                                           |

- **A. Add these states (above).** Fixes F2, F3. "Needs input" detection is a heuristic on the
  last output line; it only colours a dot, so a miss is harmless.
- **B. Only disconnected/failed, skip the prompt heuristic.** Simpler; leaves F3 open.

**Recommendation: A.** Prompt detection can ship behind the same code path as the existing
attention heuristic.

### Q3. How do you know a pane is remote?

- **A. Host chip in the pane header**, coloured, showing `user@host` (replaces the `SSH` badge),
  plus the same colour as a thin top rail on the pane.
- **B. Per-host colour, applied to the chip, the tab and the sidebar row.** Auto-assigned from a
  hash of the alias, overridable (`"ssh": { "colors": { "prod-*": "red" } }`). Makes prod
  visibly different from a scratch box, which is the case people care about.
- **C. Tint the terminal background per host** (kitty / iTerm2 style). Strongest cue, but it
  fights the user's theme and WebGL repaint rules; keep for later if at all.

**Recommendation: A + B.** C stays out.

### Q4. What happens on a disconnect?

- **A. Keep the message, make it plain and give it two keys:** `Connection to gpu-box lost.
Enter to reconnect · Esc to close`. Show the ssh exit reason in words where we can map it
  (255 → "the connection dropped or was refused").
- **B. A + a few automatic retries** (say 3, with 2 s / 5 s / 10 s backoff) _only_ when the
  drop happened after the session was live for a while and the pane was idle, shown as
  "reconnecting in 5 s…". Auth failures and "host not listed" never auto-retry. Setting to turn
  it off.
- **C. Overlay card in the pane** (VS Code-like) with Reconnect / Close / Open config buttons,
  terminal dimmed behind it. More visible than a text line; hides the last output.

**Recommendation: A now, B next.** C conflicts with reading the last output, which is usually
why you care.

### Q5. What does a failed connection offer? (F7)

Match the action to the reason:

- host gone from config → **Open ssh config** · **Close**
- ssh missing → **How to install** · **Close**
- WSL distro down → **Start distro and retry**
- everything else → **Retry** · **Close**

### Q6. Restore after relaunch (F14)

- Keep `auto` / `on-focus`.
- With `on-focus`, add **"Connect all (3)"** to the bell / attention area and the palette, since
  a restored layout usually wants all of its hosts back.

### Q7. Titles for mixed tabs (F10, F11)

- Tab title: the host when every pane is on the same host; otherwise the focused pane's title
  plus a count (`gpu-box +1`).
- Sidebar pane subline: `user@hostname` (the detail we already have) instead of repeating the
  alias; the state word when not live.

### Q8. Host list management (F12, F15, F16)

- Row context menu: Open in new tab · Split right · Split down · Copy `ssh` command · Pin ·
  Hide · Open config at this host.
- Hide known git hosts by default (`github.com`, `gitlab.com`, `bitbucket.org`, `ssh.dev.azure.com`),
  undoable from a "Hidden (4)" footer.
- Empty state: one sentence on where hosts come from, "Open ssh config", and "Add host…" which
  asks for `user@host[:port]` and an alias and appends a `Host` block (shown before writing).
- Keyboard: host rows focusable (done), splits reachable without hover.

---

## 4. Proposed phasing

| Step   | Scope                                                                                                                                                                                           | Fixes                            |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| **S0** | Only send `ESC[?1049l` when the alt buffer is active; test with a normal-screen drop.                                                                                                           | F1                               |
| **S1** | Remote states on sidebar row, tab and header (Q2-A); plain disconnect message with Enter / Esc (Q4-A); reason-specific actions on failure (Q5).                                                 | F2, F3, F7, F13 (message + keys) |
| **S2** | Host chip + per-host colour (Q3 A+B); tab title and subline rules (Q7); narrow-header truncation order (chip shrinks last).                                                                     | F4, F9, F10, F11                 |
| **S3** | Host picker: host-first rows, split via modifier, recents and pins; sidebar shows pinned + connected (Q1-C); row context menu; git hosts hidden by default; better empty state and "Add host…". | F5, F6, F8, F12, F15, F16        |
| **S4** | Bounded auto-retry (Q4-B); "Connect all" on restore (Q6).                                                                                                                                       | F13 (auto-retry), F14            |

S0 is a bug fix and can go straight onto the epic. S1 and S2 are the ones that change daily
use. Perf note for every step: all of this is chrome; nothing reads terminal output except the
prompt heuristic in S1, which runs on the existing throttled output-idle path.

---

## 5. Decisions

| #   | Question                                                       | Decision                                                                                            | Date       |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------- |
| U1  | Where hosts live (Q1)                                          | Q1-C: sidebar shows pinned + connected; a host-first picker, split via modifier; filter as fallback | 2026-09-28 |
| U2  | Remote status states, incl. "needs input" (Q2)                 | Q2-A: connecting / needs input / disconnected / failed / waiting on sidebar, tab and header         | 2026-09-28 |
| U3  | Remote cue: chip, per-host colour (Q3)                         | Q3 A+B: coloured `user@host` chip + per-host colour; no terminal tint                               | 2026-09-28 |
| U4  | Disconnect message and keys; auto-retry (Q4)                   | Q4: A now (Enter reconnect, Esc close, plain reason), B next (bounded auto-retry, off switch)       | 2026-09-28 |
| U5  | Failure actions by reason (Q5)                                 | Q5: actions by failure reason                                                                       | 2026-09-28 |
| U6  | Restore: "Connect all" (Q6)                                    | Q6: keep auto / on-focus, add "Connect all"                                                         | 2026-09-28 |
| U7  | Mixed-tab titles and sublines (Q7)                             | Q7: host title when a tab is single-host, else focused + count; subline = user@hostname             | 2026-09-28 |
| U8  | Host management: menu, default-hidden git hosts, Add host (Q8) | Q8: row context menu, git hosts hidden by default, better empty state (no "Add host", see §6)       | 2026-09-28 |

## 6. Open questions (resolved)

- **Per-host colour: only when set** (`"ssh": { "colors": { "prod-*": "red" } }`); other hosts
  get a neutral chip. An automatic hash could paint a harmless box red and teach people to
  ignore red.
- **"Needs input" notifies when the window is in the background**, like agent attention.
- **No new shortcut for now.** The host picker opens from the palette (`ssh`) and the top-bar
  picker; add a binding later if it's missed.
- **No "Add host…" in this pass.** It would mean smterm writing to the user's `~/.ssh/config`,
  which phase 1 keeps theirs. The empty state explains where hosts come from and offers "Open
  ssh config".

## 7. Progress

- [x] **S0** banner position after a drop (F1). After xterm has parsed what's queued (the exit
      arrives with the last output), leave the alt screen only if still in it, reset input modes,
      and move the cursor below the last non-blank row if a program left it above. Checked in the
      built app: a normal drop, a tmux detach (its own `?1049l` in the same chunk as the exit), a
      `?1047h` program with a homed cursor, and a drop inside a `?1049h` TUI: the line lands below
      all output each time ([shot](ssh-ux/s0-drop.png)).
- [x] **S1** remote states, disconnect keys, failure actions (F2, F3, F7, F13 message + keys).
      An ssh pane is `connecting` until ssh prints; a password / passphrase / code / PIN / host-key
      prompt (checked once per quiet spell on the cursor line) shows as amber `password` etc. and,
      off-screen, raises attention (bell, status bar, OS notification). `disconnected` and
      `can't connect` are red, `not connected` hollow, on the sidebar row, the surface tab and the
      tab dot (a clean `exit` reads neutral `ended`). The message says what happened in words with
      `Enter to reconnect · Esc twice to close` (one Esc only asks: it's often vim habit right
      after a drop); prompts are only looked for outside full-screen programs and not on a line
      the user is typing; the pane you're driving never counts on the bell;
      failures carry their kind (shared `lib/ssh-errors.ts` with main): a host gone from the
      config adds "Open ssh config", one that can never work here offers no Retry. Shots:
      [connecting](ssh-ux/s1-connecting.png), [password](ssh-ux/s1-password.png),
      [disconnected](ssh-ux/s1-disconnected.png), [host gone](ssh-ux/s1-host-gone.png).
- [x] **S2** host chip, per-host colour, titles (F4, F9, F10, F11). A remote pane's header
      shows a chip with where it runs (the host's `user@hostname:port` from the config, else its
      alias; it follows the current config, i.e. what a reconnect would use) instead of `SSH`; it
      shrinks first and hides below 520 px of header, where the rail and globe still carry the
      host (the surface tab's icon is a globe even uncoloured). `ssh.colors` (ssh-style pattern
      lists such as `"prod-*,!prod-test": "red"`, first match; red / amber / blue as theme
      tokens, or `#rrggbb`; no named green, the focus / connected colour) colours the chip, a left rail on the pane header, the globe on the
      surface tab and sidebar rows, and the tab's underline. Uncoloured hosts stay neutral. A tab
      spanning places reads `focused +N` with the `+N` outside the ellipsis; the pane row's
      subline is `user@hostname`. Shots: [colours](ssh-ux/s2-colors.png),
      [narrow panes](ssh-ux/s2-narrow.png).
- [x] **S3** host picker, pinned + open sidebar, row menu, hidden git hosts, empty state (F5,
      F6, F8, F12, F15, F16). A host-first picker (store `hostPickerOpen`), opened from the sidebar's
      search icon, the palette ("Connect to host…") and the new-tab menu ("All hosts…"): pinned,
      recent, then config order; words match alias, detail and distro; ⏎ tab, ⌥⏎ split right, ⇧⏎
      split down; right-click for the host menu (open, splits, copy `ssh` command, pin, hide, open
      config for this machine's hosts). Pins live in `ssh.pinned` (settings), recents in local
      storage. The sidebar lists pinned + hosts with a pane open, then "All hosts (N)…". Main lists
      hidden hosts flagged (`hidden`) so the picker's "Hidden (N)" footer can show them again. The
      common git hosts are hidden on top of `ssh.hidden` (your own list) unless brought back
      (`ssh.shown`), so a saved settings.json never freezes the defaults; hiding is by alias, in
      every environment. The
      palette has one host-first row per host (no split duplicates); the new-tab menu shows six,
      ellipsized. Shots: [picker](ssh-ux/s3-picker.png), [menu](ssh-ux/s3-picker-menu.png),
      [sidebar, nothing pinned](ssh-ux/s3-sidebar-empty.png),
      [sidebar, pinned + open](ssh-ux/s3-sidebar-after.png),
      [new-tab menu](ssh-ux/s3-new-tab-menu.png).
- [ ] S4 bounded auto-retry, "Connect all"
