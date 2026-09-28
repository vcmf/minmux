import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

// Shell scripts inlined as line arrays (not template literals: they contain
// ${...} and octal \033 which JS template literals would choke on).

// Disable every mouse-tracking mode (X10/normal/button/any-event + SGR encoding).
// A full-screen TUI (e.g. an agent) that was killed abnormally — the classic case
// is Claude Code dying on lid-close/sleep — never restores these, so afterwards
// each mouse move floods the prompt with raw SGR reports (`35;70;25M…`). Emitting
// this from precmd self-heals the instant control returns to the shell; it's safe
// at a prompt because no full-screen program is running to want the mouse.
const MOUSE_RESET = "\\033[?1000l\\033[?1002l\\033[?1003l\\033[?1006l"

export const ZSH_ZSHENV = [
  "# smterm shell integration — zsh .zshenv (loaded for every zsh invocation).",
  'if [[ -f "${SMTERM_USER_ZDOTDIR:-$HOME}/.zshenv" ]]; then',
  '  source "${SMTERM_USER_ZDOTDIR:-$HOME}/.zshenv"',
  "fi",
  '[[ -n "$SMTERM_ZDOTDIR" ]] && ZDOTDIR="$SMTERM_ZDOTDIR"',
  "",
].join("\n")

export const ZSH_ZSHRC = [
  "# smterm shell integration — zsh .zshrc",
  "# Restore the user's ZDOTDIR and load their real interactive config first.",
  'ZDOTDIR="${SMTERM_USER_ZDOTDIR:-$HOME}"',
  'if [[ -f "$ZDOTDIR/.zshrc" ]]; then',
  '  source "$ZDOTDIR/.zshrc"',
  "fi",
  "",
  "# Repoint HISTFILE to the user's real location (correctness — runs even if shared",
  "# history is opted out). We inject ZDOTDIR to load this rc, and a system zshrc runs",
  "# BEFORE us (e.g. macOS /etc/zshrc: `HISTFILE=${ZDOTDIR:-$HOME}/.zsh_history`), pointing",
  "# HISTFILE INTO our temp ZDOTDIR — siloing smterm history from every other terminal.",
  "# Undo it whenever HISTFILE landed inside our dir (any filename), preserving the",
  "# basename so we match what other terminals use. Never touches a HISTFILE elsewhere.",
  'if [[ -o interactive && -n "${SMTERM_ZDOTDIR-}" && "${HISTFILE-}" == "${SMTERM_ZDOTDIR-}"/* ]]; then',
  '  HISTFILE="${SMTERM_USER_ZDOTDIR:-$HOME}/${HISTFILE:t}"',
  "fi",
  "",
  "# Shared, incrementally-written history across panes (cmux-like) unless opted out",
  "# (SMTERM_SHARE_HISTORY=0). After the user's rc so our setopt wins; fills sane",
  "# HISTFILE/SAVEHIST/HISTSIZE only when unset. SHARE_HISTORY writes each command",
  "# immediately, so history also survives an abrupt close (not just a clean exit).",
  'if [[ -o interactive && "${SMTERM_SHARE_HISTORY:-1}" != "0" ]]; then',
  '  [[ -z "${HISTFILE-}" ]] && HISTFILE="${SMTERM_USER_ZDOTDIR:-$HOME}/.zsh_history"',
  "  (( ${SAVEHIST:-0} < 1 )) && SAVEHIST=10000",
  "  (( ${HISTSIZE:-0} < 1 )) && HISTSIZE=10000",
  "  setopt SHARE_HISTORY",
  "fi",
  "",
  "# Emit OSC 133 marks so smterm can track command start/finish.",
  'if [[ -o interactive && -z "${__SMTERM_ZSH_HOOKS-}" ]]; then',
  "  __SMTERM_ZSH_HOOKS=1",
  "  autoload -Uz add-zsh-hook 2>/dev/null",
  "  __smterm_preexec() { printf '\\033]133;C\\007'; }",
  "  __smterm_precmd() {",
  "    local ret=$?",
  "    printf '\\033]133;D;%s\\007' \"$ret\"",
  '    printf \'\\033]7;file://%s%s\\007\' "${HOST:-localhost}" "$PWD"',
  "    printf '" + MOUSE_RESET + "' # heal a crashed TUI's leftover mouse mode",
  "  }",
  "  add-zsh-hook preexec __smterm_preexec 2>/dev/null",
  "  add-zsh-hook precmd __smterm_precmd 2>/dev/null",
  "fi",
  "",
  "# Route `claude` through smterm's scoped hook settings so the agents board can",
  "# observe its sessions/sub-agents. Only when smterm provides the file; the user's",
  "# global ~/.claude config is untouched. (M6 — docs/design/AGENT_OBSERVABILITY.md)",
  'if [[ -o interactive && -n "${SMTERM_CLAUDE_SETTINGS-}" ]]; then',
  '  claude() { command claude --settings "$SMTERM_CLAUDE_SETTINGS" "$@" }',
  "fi",
  "",
].join("\n")

export const ZSH_ZPROFILE = [
  "# smterm shell integration — zsh .zprofile (login shells)",
  'if [[ -f "${SMTERM_USER_ZDOTDIR:-$HOME}/.zprofile" ]]; then',
  '  source "${SMTERM_USER_ZDOTDIR:-$HOME}/.zprofile"',
  "fi",
  "",
].join("\n")

const ZSH_ZLOGIN = [
  "# smterm shell integration — zsh .zlogin (login shells)",
  'if [[ -f "${SMTERM_USER_ZDOTDIR:-$HOME}/.zlogin" ]]; then',
  '  source "${SMTERM_USER_ZDOTDIR:-$HOME}/.zlogin"',
  "fi",
  "",
].join("\n")

// Everything below runs AFTER the user's rc — which may `set -u` / `setopt nounset`: every
// variable we read there is expanded as ${X-} so an unset one can't abort our integration.
const BASH_LOCAL_PRELUDE = [
  "# smterm shell integration — bash (loaded via bash --rcfile).",
  "if [[ -f /etc/bash.bashrc ]]; then source /etc/bash.bashrc; fi",
  'if [[ -f "$HOME/.bashrc" ]]; then source "$HOME/.bashrc"; fi',
  "",
]

/** bash's hooks, after the user's own startup files (shared by local and remote rcs). */
export const BASH_HOOKS = [
  "# Only instrument interactive shells, once.",
  'case "$-" in *i*) ;; *) return ;; esac',
  '[[ -n "${__SMTERM_BASH_HOOKS-}" ]] && return',
  "__SMTERM_BASH_HOOKS=1",
  "",
  "# Shared history across panes (cmux-like) unless opted out (SMTERM_SHARE_HISTORY=0):",
  "# append this session's new lines to HISTFILE and re-read others' before each prompt.",
  'if [[ "${SMTERM_SHARE_HISTORY:-1}" != "0" ]]; then shopt -s histappend; __smterm_share_hist=1; else __smterm_share_hist=0; fi',
  "",
  "# Start ARMED: the DEBUG trap also fires for this rc's own remaining lines — those must not",
  "# emit a C before the first prompt. __smterm_pc_end (end of the first prompt) disarms it.",
  "__smterm_armed=1",
  "__smterm_in_pc=0",
  "",
  "# DEBUG fires for EVERY simple command, including each piece of PROMPT_COMMAND (starship,",
  "# direnv, VTE…). Only a command the user runs from the prompt is a 'command start' (C):",
  "# skip our own functions and anything between __smterm_precmd (first in PROMPT_COMMAND)",
  "# and __smterm_pc_end (last) — else every prompt would emit a spurious C after its D.",
  "__smterm_preexec() {",
  '  [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return',
  '  [[ "$BASH_COMMAND" == __smterm_* ]] && return',
  "  [[ $__smterm_in_pc == 1 ]] && return",
  "  [[ $__smterm_armed == 1 ]] && return",
  "  __smterm_armed=1",
  "  printf '\\033]133;C\\007'",
  "}",
  "",
  "__smterm_precmd() {",
  "  local ret=$?",
  "  __smterm_in_pc=1",
  "  [[ $__smterm_share_hist == 1 ]] && { history -a; history -n; }",
  "  printf '\\033]133;D;%s\\007' \"$ret\"",
  '  printf \'\\033]7;file://%s%s\\007\' "${HOSTNAME:-localhost}" "$PWD"',
  "  printf '" + MOUSE_RESET + "' # heal a crashed TUI's leftover mouse mode",
  "}",
  "__smterm_pc_end() { __smterm_in_pc=0; __smterm_armed=0; }",
  "",
  "# Wrap the user's PROMPT_COMMAND between our markers. NEWLINE-joined, not '; ': a value",
  "# ending in ';' / '&' / a newline (e.g. \"history -a; $PROMPT_COMMAND\") would make '; ;'",
  "# a syntax error at every prompt. bash 5.1+ may hold it as an ARRAY: wrap every element.",
  'if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then',
  '  PROMPT_COMMAND=(__smterm_precmd "${PROMPT_COMMAND[@]}" __smterm_pc_end)',
  "else",
  "  PROMPT_COMMAND=$'__smterm_precmd\n'\"${PROMPT_COMMAND-}\"$'\n__smterm_pc_end'",
  "fi",
  "trap '__smterm_preexec' DEBUG",
  "",
  "# Route `claude` through smterm's scoped hook settings (agents board — M6).",
  'if [[ $- == *i* && -n "${SMTERM_CLAUDE_SETTINGS-}" ]]; then',
  '  claude() { command claude --settings "$SMTERM_CLAUDE_SETTINGS" "$@"; }',
  "fi",
  "",
].join("\n")

export const BASH_RC = [...BASH_LOCAL_PRELUDE, BASH_HOOKS].join("\n")

export interface ShellOption {
  id: string
  label: string
  command: string
  args: string[]
}

export interface Injection {
  env: Record<string, string>
  args: string[]
}

// Per profile (main sets it at startup): each instance rewrites these scripts on every spawn,
// so a dev build on another branch must never write the scripts an installed app's shells read.
let integrationDirName = "smterm"
export function setIntegrationDirName(name: string): void {
  integrationDirName = name
}

function integrationBase(): string {
  return path.join(os.tmpdir(), integrationDirName, "shell-integration")
}

function materialize(base: string): void {
  const zsh = path.join(base, "zsh")
  fs.mkdirSync(zsh, { recursive: true })
  fs.writeFileSync(path.join(zsh, ".zshenv"), ZSH_ZSHENV)
  fs.writeFileSync(path.join(zsh, ".zshrc"), ZSH_ZSHRC)
  fs.writeFileSync(path.join(zsh, ".zprofile"), ZSH_ZPROFILE)
  fs.writeFileSync(path.join(zsh, ".zlogin"), ZSH_ZLOGIN)
  const bash = path.join(base, "bash")
  fs.mkdirSync(bash, { recursive: true })
  fs.writeFileSync(path.join(bash, "bashrc"), BASH_RC)
}

/** Env + args to inject OSC 133 shell integration; null if unsupported. */
export function buildInjection(shell: string): Injection | null {
  const name = path.basename(shell)
  let base: string
  try {
    base = integrationBase()
    materialize(base)
  } catch {
    return null // best-effort: fall back to a plain shell
  }
  if (name === "zsh" || name.endsWith("-zsh")) {
    const ours = path.join(base, "zsh")
    const user = process.env.ZDOTDIR ?? os.homedir()
    return {
      env: {
        ZDOTDIR: ours,
        SMTERM_ZDOTDIR: ours,
        SMTERM_USER_ZDOTDIR: user,
        SMTERM_SHELL_INTEGRATION: "1",
      },
      args: [],
    }
  }
  if (name === "bash") {
    return {
      env: { SMTERM_SHELL_INTEGRATION: "1" },
      args: ["--rcfile", path.join(base, "bash", "bashrc")],
    }
  }
  return null
}

/** Is this shell command `wsl.exe`? (The Linux shell runs INSIDE it.) Pure — tested. */
export function isWslShell(shell: string): boolean {
  return /(^|[\\/])wsl\.exe$/i.test(shell)
}

/** Extra `wsl.exe` args to set the Linux start dir: a tracked Linux path if we have
 *  one, else `~`. Without this, wsl inherits the *Windows* cwd and lands in
 *  `/mnt/c/...` instead of the home. Pure — tested. */
export function wslCdArgs(cwd: string | undefined): string[] {
  return ["--cd", cwd && cwd.startsWith("/") ? cwd : "~"]
}

/** The distro a `wsl.exe` invocation targets, from its args (`-d`/`--distribution <name>`),
 *  or undefined when unspecified (⇒ the default distro). Lets us translate a WSL pane's
 *  Linux paths against the RIGHT distro's UNC share. Pure — tested. */
export function parseWslDistroArg(args: string[]): string | undefined {
  const i = args.findIndex((a) => a === "-d" || a === "--distribution")
  return i >= 0 ? args[i + 1] : undefined
}

/** The login shell (last field) of a `getent passwd` line. Pure — tested. */
export function parseLoginShell(getentLine: string): string {
  const f = getentLine.trim().split(":")
  return f.length >= 7 ? (f[f.length - 1] ?? "") : ""
}

/** Trailing `wsl.exe` args + env to run the login shell with our integration sourced
 *  INSIDE WSL — reusing the same OSC-133/OSC-7 scripts we use natively (so status +
 *  cwd work). `wslBase` is our script dir already translated to a WSL path. Pure —
 *  tested. Returns null for shells we don't integrate (fish, …) → plain shell.
 *  `wslenv` lists env vars WSL must forward across the boundary (via $WSLENV). */
export function wslInjection(
  loginShell: string,
  wslBase: string,
): { args: string[]; env: Record<string, string>; wslenv: string[] } | null {
  const name = loginShell.split("/").pop() ?? ""
  if (name === "bash") {
    // --rcfile takes a literal path (already WSL-translated); it sources ~/.bashrc.
    // Forward SMTERM_SHARE_HISTORY so the shared-history opt-out crosses into WSL.
    return {
      args: ["--", "bash", "--rcfile", `${wslBase}/bash/bashrc`, "-i"],
      env: {},
      // /p path-translates the (Windows) hook-settings path so claude-in-WSL can read it.
      // COLORFGBG crosses so agents in WSL can detect our light/dark theme.
      wslenv: ["SMTERM_SHARE_HISTORY", "SMTERM_CLAUDE_SETTINGS/p", "SMTERM_PANE_ID", "COLORFGBG"],
    }
  }
  if (name === "zsh") {
    // zsh finds our .zshrc via $ZDOTDIR; it restores ZDOTDIR to $HOME + sources ~/.zshrc.
    // SMTERM_ZDOTDIR lets the rc detect + undo a HISTFILE a system zshrc pointed into our
    // injected ZDOTDIR (same history-siloing fix as local shells — see ZSH_ZSHRC). We do
    // NOT forward SMTERM_USER_ZDOTDIR (the distro-side ZDOTDIR is unknown at inject time),
    // so the repoint target falls back to $HOME — matching this path's existing behaviour
    // of sourcing ~/.zshrc. Known limitation: a custom in-WSL ZDOTDIR isn't honoured here.
    const zdir = `${wslBase}/zsh`
    return {
      args: ["--", "zsh", "-i"],
      env: { ZDOTDIR: zdir, SMTERM_ZDOTDIR: zdir, SMTERM_SHELL_INTEGRATION: "1" },
      wslenv: [
        "ZDOTDIR",
        "SMTERM_ZDOTDIR",
        "SMTERM_SHELL_INTEGRATION",
        "SMTERM_SHARE_HISTORY",
        "SMTERM_CLAUDE_SETTINGS/p", // /p path-translates it for claude-in-WSL to read
        "SMTERM_PANE_ID",
        "COLORFGBG", // so agents in WSL can detect our light/dark theme
      ],
    }
  }
  return null
}

/** Best-effort WSL integration: translate our script dir into the distro (`wslpath`)
 *  + detect its login shell (`getent`), then build the injection. Returns null on any
 *  failure so the caller falls back to a plain `wsl.exe` (never breaks WSL). */
export function buildWslInjection(
  distroArgs: string[],
): { args: string[]; env: Record<string, string> } | null {
  try {
    const base = integrationBase()
    materialize(base)
    const run = (extra: string[]) =>
      execFileSync("wsl.exe", [...distroArgs, ...extra], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      })
    const wslBase = run(["wslpath", "-u", base]).trim()
    if (!wslBase) return null
    const passwd = run(["-e", "sh", "-c", 'getent passwd "$(id -un)"'])
    const inj = wslInjection(parseLoginShell(passwd), wslBase)
    if (!inj) return null
    const env: Record<string, string> = { ...inj.env }
    if (inj.wslenv.length)
      env.WSLENV = [process.env.WSLENV, ...inj.wslenv].filter(Boolean).join(":")
    return { args: inj.args, env }
  } catch {
    return null // WSL not ready / wslpath missing / exotic setup → plain shell
  }
}

/** Parse `wsl.exe -l -q` output (one distro per line). Pure — unit-tested. */
export function parseWslDistros(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, "").trim())
    .filter((line) => line.length > 0)
}

function wslDistros(): string[] {
  try {
    // wsl.exe emits UTF-16LE.
    const out = execFileSync("wsl.exe", ["-l", "-q"], { encoding: "utf16le" })
    return parseWslDistros(out)
  } catch {
    return []
  }
}

/** The default distro's name from `wsl.exe -l -v` output — the row marked with `*`.
 *  Pure — unit-tested. undefined if no default row is found. */
export function parseDefaultDistro(listVerbose: string): string | undefined {
  for (const line of listVerbose.replace(/\0/g, "").split(/\r?\n/)) {
    const m = /^\s*\*\s+(\S+)/.exec(line)
    if (m) return m[1]
  }
  return undefined
}

// A WSL pane spawned without `-d` runs the default distro; the UNC share still needs its
// name. Resolve it once (rarely changes) so the files browser works there too.
let cachedDefaultDistro: string | null | undefined
export function defaultWslDistro(): string | undefined {
  if (cachedDefaultDistro !== undefined) return cachedDefaultDistro ?? undefined
  try {
    const out = execFileSync("wsl.exe", ["-l", "-v"], { encoding: "utf16le" })
    cachedDefaultDistro = parseDefaultDistro(out) ?? null
  } catch {
    cachedDefaultDistro = null
  }
  return cachedDefaultDistro ?? undefined
}

/** Shells/profiles available on this machine, for the "New" picker. */
export function listShells(): ShellOption[] {
  const out: ShellOption[] = []
  if (process.platform === "win32") {
    out.push({ id: "powershell", label: "PowerShell", command: "powershell.exe", args: [] })
    out.push({ id: "cmd", label: "Command Prompt", command: "cmd.exe", args: [] })
    for (const distro of wslDistros()) {
      out.push({
        id: `wsl:${distro}`,
        label: `WSL: ${distro}`,
        command: "wsl.exe",
        args: ["-d", distro],
      })
    }
  } else {
    const def = process.env.SHELL ?? "/bin/zsh"
    out.push({ id: "default", label: path.basename(def), command: def, args: [] })
    for (const cand of ["/bin/zsh", "/bin/bash", "/bin/sh"]) {
      if (fs.existsSync(cand) && !out.some((s) => s.command === cand)) {
        out.push({ id: cand, label: path.basename(cand), command: cand, args: [] })
      }
    }
  }
  return out
}
