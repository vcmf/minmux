import { execFileSync } from "node:child_process"

// A macOS/Linux app launched from Finder/Dock inherits a bare `launchd` PATH
// (/usr/bin:/bin:…), NOT the user's shell PATH — so Homebrew/cargo tools (starship,
// etc.) are missing and `.zshrc` lines like `starship init` fail with "command not
// found". We fix it the way VS Code/iTerm do: run the login+interactive shell once at
// startup, capture its resolved env, and import it so spawned PTYs see the real PATH.

const DELIM = "__MINMUX_ENV__"

/** Extract the KEY=VALUE block our probe prints between two delimiters. Pure — tested.
 *  Ignores any prompt/init noise the interactive shell emits outside the delimiters. */
export function parseEnvBlock(stdout: string): Record<string, string> {
  const start = stdout.indexOf(DELIM)
  const end = stdout.lastIndexOf(DELIM)
  if (start === -1 || end <= start) return {}
  const block = stdout.slice(start + DELIM.length, end)
  const env: Record<string, string> = {}
  for (const line of block.split("\n")) {
    const eq = line.indexOf("=")
    if (eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1)
  }
  return env
}

/** Resolve the login+interactive shell's environment (PATH etc.). Best-effort —
 *  returns {} on any failure so the app still launches (with the bare env). */
export function resolveLoginShellEnv(shell: string): Record<string, string> {
  try {
    const out = execFileSync(shell, ["-ilc", `echo ${DELIM}; env; echo ${DELIM}`], {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    })
    return parseEnvBlock(out)
  } catch {
    return {}
  }
}

/** Import the login shell's PATH (+ any vars missing from the current env) into
 *  process.env, so PTYs spawned later inherit a usable environment. */
export function applyLoginShellEnv(shell: string): void {
  const resolved = resolveLoginShellEnv(shell)
  if (resolved.PATH) process.env.PATH = resolved.PATH // launchd's PATH is the wrong one
  for (const [k, v] of Object.entries(resolved)) {
    if (process.env[k] === undefined) process.env[k] = v
  }
}
