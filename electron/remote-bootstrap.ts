// Remote shell integration (docs/design/SSH_REMOTES.md §8): the command an ssh pane runs on a
// host that opted in, and the handshake that hands its shell a nonce. Pure — unit-tested.
//
// Two channels, on purpose:
//  - The command text is read by the host's login shell first (bash, zsh, fish, csh…), so it is
//    fixed: one hex challenge plus base64 of the script below, all inside single quotes, with
//    no quote, backslash or `!` of its own. Nothing about you, and no secret, is in it (other
//    users on the host can read it with `ps`).
//  - The secret travels through the terminal: the script prints a hello carrying the
//    challenge, turns echo off, and main answers with one line (the nonce). The shell's
//    reports carry that nonce, so text a program prints can't pass for them.
//
// Anything unexpected (not bash or zsh, no mktemp / stty, no answer) → the plain login shell.

import { BASH_HOOKS, ZSH_HOOKS } from "./shell-integration"

import { SMTERM_OSC } from "../src/lib/remote-reports"

export { SMTERM_OSC }

const HEX = /^[0-9a-f]{16,64}$/

// The standard OSC 133 / OSC 7 emits in the local hooks, and their nonce-tagged remote form.
// Each must appear in the scripts (checked in remoteHooks), or the remote shell would report
// untagged — and then nothing it says counts.
const EMITS: [string, string][] = [
  ["printf '\\033]133;C\\007'", `printf '\\033]${SMTERM_OSC};%s;C\\007' "$__smterm_nonce"`],
  [
    "printf '\\033]133;D;%s\\007' \"$ret\"",
    `printf '\\033]${SMTERM_OSC};%s;D;%s\\007' "$__smterm_nonce" "$ret"`,
  ],
  [
    "printf '\\033]7;file://%s%s\\007'",
    `printf '\\033]${SMTERM_OSC};%s;7;file://%s%s\\007' "$__smterm_nonce"`,
  ],
]

/** A local hook script with every report tagged with the nonce (throws if one is missing). */
export function remoteHooks(script: string): string {
  let out = script
  for (const [from, to] of EMITS) {
    if (!out.includes(from)) throw new Error(`remote hooks: missing ${from}`)
    out = out.split(from).join(to)
  }
  return out
}

// zsh reads only this file of ours: it gives zsh back the user's own ZDOTDIR (as sshd's
// `zsh -c` left it), removes our temp dir, and adds the hooks. zsh then reads the user's
// .zprofile / .zshrc / .zlogin from there, as a plain login would — and nothing started from
// them (tmux…) inherits a ZDOTDIR pointing at a dir that's gone. The nonce is assigned
// before any user file runs (so `allexport` there can't export it) and never exported.
export const REMOTE_ZSHENV = [
  "# smterm remote integration — zsh .zshenv (the only file of ours zsh reads).",
  "typeset +x __smterm_nonce",
  'case "${SMTERM_ZDOTDIR-}" in */smterm.*) command rm -rf -- "$SMTERM_ZDOTDIR" 2>/dev/null ;; esac',
  'if [[ -n "${SMTERM_USER_ZDOTDIR-}" ]]; then ZDOTDIR=$SMTERM_USER_ZDOTDIR; else unset ZDOTDIR; fi',
  "unset SMTERM_ZDOTDIR SMTERM_USER_ZDOTDIR",
  'if [[ -f "${ZDOTDIR:-$HOME}/.zshenv" ]]; then source "${ZDOTDIR:-$HOME}/.zshenv"; fi',
  remoteHooks(ZSH_HOOKS),
].join("\n")

// bash runs with --rcfile (never a login shell then): read the files a login bash would, in
// its order (those usually source ~/.bashrc themselves), and behave like one on the way out.
export const REMOTE_BASHRC = [
  "# smterm remote integration — bash (loaded via bash --rcfile). Remove our temp dir.",
  "export -n __smterm_nonce 2>/dev/null",
  'case "${__SMTERM_TMP-}" in */smterm.*) command rm -rf -- "$__SMTERM_TMP" 2>/dev/null ;; esac',
  "unset __SMTERM_TMP",
  "SMTERM_SHARE_HISTORY=0 # the host's history settings are its own",
  'logout() { exit "$@"; }',
  'trap \'[[ -f "$HOME/.bash_logout" ]] && . "$HOME/.bash_logout"\' EXIT',
  "if [[ -f /etc/profile ]]; then source /etc/profile; fi",
  'if [[ -f "$HOME/.bash_profile" ]]; then source "$HOME/.bash_profile"',
  'elif [[ -f "$HOME/.bash_login" ]]; then source "$HOME/.bash_login"',
  'elif [[ -f "$HOME/.profile" ]]; then source "$HOME/.profile"; fi',
  "",
  remoteHooks(BASH_HOOKS),
].join("\n")

const heredoc = (file: string, tag: string, body: string): string[] => {
  if (body.split("\n").includes(tag)) throw new Error(`remote bootstrap: ${tag} in its body`)
  return [`__smterm_w <<'${tag}' >> "$d/${file}"`, body, tag]
}

const osc = (kind: string) => `printf '\\033]${SMTERM_OSC};${kind};%s\\007' "$S"`

// Runs under sh (POSIX: dash, busybox, bash-as-sh). `S` is the challenge (set by the command).
// Returns only on failure — the command then execs the plain login shell.
export const PAYLOAD = [
  ": smterm", // the command only evals a decoded payload that starts with this
  "set +f; unset IFS",
  osc("boot"), // it ran (whatever it picks next)
  "# Writes stdin to stdout with builtins only (no cat: each process costs a few ms).",
  "__smterm_w() { while IFS= read -r __l; do printf '%s\\n' \"$__l\"; done; }",
  "__smterm_boot() {",
  "  s=${SHELL-}",
  '  case "${s##*/}" in bash|zsh) ;; *) return 1 ;; esac',
  '  [ -x "$s" ] || return 1',
  "  m=$(umask); umask 077",
  '  d=$(mktemp -d "${TMPDIR:-/tmp}/smterm.XXXXXXXX" 2>/dev/null) || { umask "$m"; return 1; }',
  '  [ -d "$d" ] || { umask "$m"; return 1; }',
  "  trap 'command rm -rf -- \"$d\"; exit 1' HUP INT QUIT TERM",
  "  # The handshake: echo off (the answer must never show), raw, keys like ^C read as data,",
  "  # 5 s for each line. Lines typed before the answer came (an Enter during the login) are",
  "  # read past: only the one carrying our marker counts.",
  "  t=$(stty -g 2>/dev/null) || t=",
  '  if [ -z "$t" ] || ! stty -echo -icanon -isig min 0 time 50 2>/dev/null; then',
  '    command rm -rf -- "$d"; trap - HUP INT QUIT TERM; umask "$m"; return 1',
  "  fi",
  `  ${osc("hello")}`,
  "  n= a= k=0",
  "  while [ $k -lt 32 ]; do",
  "    k=$((k + 1)); l=",
  "    IFS= read -r l; r=$?",
  '    case "$l" in *smterm:*) a=1; l=${l##*smterm:}; n=${l%%:*}; break ;; esac',
  "    [ $r -eq 0 ] || break # nothing for 5 s",
  "  done",
  "  # No answer yet (a very slow link): wait out a late one, so it never lands in the shell.",
  '  if [ -z "$a" ]; then stty min 0 time 20 2>/dev/null; while IFS= read -r l; do :; done; fi',
  '  stty "$t" 2>/dev/null',
  '  case "$n" in *[!0-9a-f]*) n= ;; esac',
  '  if [ ${#n} -ne 32 ] || [ "$l" != "$n:-" ]; then',
  '    command rm -rf -- "$d"; trap - HUP INT QUIT TERM; umask "$m"; return 1',
  "  fi",
  '  case "${s##*/}" in',
  "  zsh)",
  `    printf '__smterm_nonce=%s\\n' "$n" > "$d/.zshenv"`,
  ...heredoc(".zshenv", "__SMTERM_ZSHENV__", REMOTE_ZSHENV),
  '    trap - HUP INT QUIT TERM; umask "$m"',
  "    SMTERM_USER_ZDOTDIR=${ZDOTDIR-}; ZDOTDIR=$d; SMTERM_ZDOTDIR=$d",
  "    export SMTERM_USER_ZDOTDIR ZDOTDIR SMTERM_ZDOTDIR",
  '    exec "$s" -l',
  "    ;;",
  "  bash)",
  `    printf '__smterm_nonce=%s\\n' "$n" > "$d/bashrc"`,
  ...heredoc("bashrc", "__SMTERM_BASHRC__", REMOTE_BASHRC),
  '    trap - HUP INT QUIT TERM; umask "$m"',
  "    __SMTERM_TMP=$d; export __SMTERM_TMP",
  '    exec "$s" --rcfile "$d/bashrc" -i',
  "    ;;",
  "  esac",
  '  command rm -rf -- "$d"; trap - HUP INT QUIT TERM; umask "$m"; return 1',
  "}",
  `__smterm_boot || ${osc("skip")} # the plain shell, next: main stops looking`,
  "",
].join("\n")

const PAYLOAD_B64 = Buffer.from(PAYLOAD, "utf8").toString("base64")

/** The ssh remote command for an integrated pane. Every character is inert in any Unix login
 *  shell's single quotes; the only variable part is the (hex) challenge. */
export function remoteBootstrapCommand(challenge: string): string {
  if (!HEX.test(challenge)) throw new Error("remote bootstrap: challenge must be hex")
  // set -f + an empty IFS: $B and $p expand as one word, unglobbed, so no double quotes are
  // needed (they'd have to survive Windows argv quoting on the way to ssh.exe / wsl.exe).
  const body = [
    `S=${challenge}`,
    `B=${PAYLOAD_B64}`,
    "set -f",
    "IFS=",
    "p=$(printf %s $B|base64 -d 2>/dev/null)||p=$(printf %s $B|base64 -D 2>/dev/null)||p=",
    "case $p in :?smterm*) eval $p;; esac",
    "exec ${SHELL:-/bin/sh} -l",
  ].join(";")
  return `exec sh -c '${body}'`
}

/** The line main types in answer to the hello (read with echo off). */
export function handshakeReply(nonce: string): string {
  if (!HEX.test(nonce)) throw new Error("remote bootstrap: nonce must be hex")
  return `smterm:${nonce}:-\r`
}

// A pane stops looking after this much output: the hello comes right after login, so a
// session that got this far without one isn't integrated (and scanning costs nothing again).
// Once the bootstrap booted, its hello (or skip) follows within a few lines.
const HELLO_SCAN_LIMIT = 1 << 20
const AFTER_BOOT_LIMIT = 64 << 10

/** Watches a pane's output for its bootstrap: `booted` once the script runs on the host, and
 *  the answer to its hello, once. Done after the hello, a skip (the plain shell), or a budget. */
export class HelloWatch {
  private readonly bootMark: string
  private readonly helloMark: string
  private readonly skipMark: string
  private tail = ""
  private scanned = 0
  private sinceBoot = 0
  booted = false
  done = false

  constructor(
    challenge: string,
    private readonly reply: string,
  ) {
    this.bootMark = `\x1b]${SMTERM_OSC};boot;${challenge}\x07`
    this.helloMark = `\x1b]${SMTERM_OSC};hello;${challenge}\x07`
    this.skipMark = `\x1b]${SMTERM_OSC};skip;${challenge}\x07`
  }

  /** The answer to write, the first time the hello shows up in `data`; else null. */
  feed(data: string): string | null {
    if (this.done) return null
    const text = this.tail + data
    if (!this.booted && text.includes(this.bootMark)) this.booted = true
    if (this.booted) {
      if (text.includes(this.helloMark)) return this.finish(this.reply)
      if (text.includes(this.skipMark)) return this.finish(null)
      this.sinceBoot += data.length
      if (this.sinceBoot > AFTER_BOOT_LIMIT) return this.finish(null)
    }
    this.scanned += data.length
    if (this.scanned > HELLO_SCAN_LIMIT) return this.finish(null)
    this.tail = text.slice(-(this.helloMark.length - 1))
    return null
  }

  private finish(reply: string | null): string | null {
    this.done = true
    this.tail = ""
    return reply
  }
}

// A host without sh fails as soon as it's logged in; much later is the user's own session.
const QUICK_FAILURE_MS = 120_000

/** The host couldn't run the bootstrap: the pane ended on its own (not closed, replaced or
 *  quit by smterm, not killed by a signal — ^C at a password prompt), before it booted, soon
 *  after starting, and not with ssh's own 255 (connection or auth failure). */
export function integrationFailed(end: {
  booted: boolean
  exitCode: number
  signal: number
  closedBySmterm: boolean
  livedMs: number
}): boolean {
  if (end.booted || end.closedBySmterm || end.signal) return false
  return end.exitCode !== 255 && end.livedMs < QUICK_FAILURE_MS
}

export const INTEGRATION_FAILED_NOTE =
  "\r\n\x1b[2m[smterm] This host couldn't start shell integration; reconnect for a plain shell.\x1b[0m\r\n"

/** `ssh -G` output sets a RemoteCommand (ssh prints the line only when one is set). */
export const hasRemoteCommand = (sshG: string): boolean =>
  /^remotecommand[ \t]+(?!none[ \t]*$)\S/im.test(sshG)
