// Which hosts run smterm's shell integration (`ssh.integration`, opt-in per host). Shared by
// main (which builds the command) and the host menu (which toggles it).

import { globMatch } from "./ssh-hosts-ui"

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** On for `alias`: its own entry (`alias` / `!alias`) decides; else some pattern matches it
 *  and no `!pattern` does (case-insensitive globs, as ssh matches Host). */
export function integrationOn(alias: string, list: readonly string[]): boolean {
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

/** The list with `alias` switched on or off: its own entries go first, and a pattern that
 *  still decides otherwise gets an exception (`!alias`, or the alias itself). */
export function setIntegration(list: readonly string[], alias: string, on: boolean): string[] {
  const out = list.filter((e) => !same(e, alias) && !same(e, `!${alias}`))
  if (integrationOn(alias, out) !== on) out.push(on ? alias : `!${alias}`)
  return out
}
