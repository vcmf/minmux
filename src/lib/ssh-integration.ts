// Which hosts run smterm's shell integration: `ssh.integrationMode` (ask per host, all hosts,
// or off) and the `ssh.integration` list of alias patterns inside it. Shared by main (which
// builds the command) and the renderer (host menu, split hint, settings).

import { globMatch } from "./ssh-hosts-ui"

/** ask: only hosts you turned on (and a hint offers it); all: every host but `!alias`; off. */
export type IntegrationMode = "ask" | "all" | "off"

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** The list's own verdict: its entry for `alias` (`alias` / `!alias`) decides; else some
 *  pattern matches and no `!pattern` does (case-insensitive globs, as ssh matches Host). */
function listSays(alias: string, list: readonly string[]): boolean {
  if (list.some((e) => same(e, `!${alias}`))) return false
  if (list.some((e) => same(e, alias))) return true
  let hit = false
  for (const entry of list) {
    if (entry.startsWith("!")) {
      if (globMatch(entry.slice(1), alias)) return false
    } else if (globMatch(entry, alias)) hit = true
  }
  return hit
}

/** On for `alias` under `mode`. */
export function integrationOn(
  alias: string,
  list: readonly string[],
  mode: IntegrationMode = "ask",
): boolean {
  if (mode === "off") return false
  return listSays(alias, mode === "all" ? ["*", ...list] : list)
}

/** No entry mentions `alias` at all: you never chose for it (a hint may ask). */
export function undecided(alias: string, list: readonly string[]): boolean {
  return !list.some((e) => globMatch(e.startsWith("!") ? e.slice(1) : e, alias))
}

/** The list with `alias` switched on or off under `mode`: its own entries go first, and a
 *  pattern that still decides otherwise gets an exception (`!alias`, or the alias itself). */
export function setIntegration(
  list: readonly string[],
  alias: string,
  on: boolean,
  mode: IntegrationMode = "ask",
): string[] {
  const out = list.filter((e) => !same(e, alias) && !same(e, `!${alias}`))
  if (integrationOn(alias, out, mode) !== on) out.push(on ? alias : `!${alias}`)
  return out
}

/** "Don't ask again": an explicit `!alias`, whatever the patterns say. */
export function declineIntegration(list: readonly string[], alias: string): string[] {
  return [...list.filter((e) => !same(e, alias) && !same(e, `!${alias}`)), `!${alias}`]
}
