/** minmux's CHANGELOG.md (written by git-cliff in the app repo), read and parsed at build time. */

import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** The site lives in the app repo (`site/`); the build runs from there. */
const CHANGELOG = join(process.cwd(), "..", "CHANGELOG.md")

export interface ReleaseGroup {
  /** "Added", "Fixed", "Faster", … as the app's cliff.toml names them. */
  title: string
  items: string[]
}

export interface Release {
  /** "0.1.58", or "Unreleased". */
  version: string
  url?: string
  date?: string
  groups: ReleaseGroup[]
  /** Prose under the heading with no group (the hand-written 0.1.0 entry). */
  notes: string[]
}

/** The repo's CHANGELOG.md. A failed read fails the build, so a deploy never ships an empty page. */
export function loadChangelog(): Promise<string> {
  return readFile(CHANGELOG, "utf8")
}

const HEADING = /^## (?:\[([^\]]+)\]\(([^)]+)\)|(.+?))(?: - (\d{4}-\d{2}-\d{2}))?\s*$/

/** `## [ver](url) - date` starts a release, `### Group` a group, `- line` an item. */
export function parseChangelog(md: string): Release[] {
  const releases: Release[] = []
  let release: Release | undefined
  let group: ReleaseGroup | undefined
  let para: string[] = []
  const endPara = () => {
    if (release && para.length) release.notes.push(para.join(" "))
    para = []
  }
  for (const raw of md.split("\n")) {
    const line = raw.trimEnd()
    const h = HEADING.exec(line)
    if (h) {
      endPara()
      release = { version: h[1] ?? h[3], url: h[2], date: h[4], groups: [], notes: [] }
      releases.push(release)
      group = undefined
    } else if (!release) {
      continue // the file's own header
    } else if (line.startsWith("### ")) {
      endPara()
      group = { title: line.slice(4).trim(), items: [] }
      release.groups.push(group)
    } else if (line.startsWith("- ") && group) {
      group.items.push(line.slice(2).trim())
    } else if (line.trim() === "") {
      endPara()
    } else if (!group) {
      para.push(line.trim())
    }
  }
  endPara()
  return releases
}

export type Inline = { text: string; href?: string; code?: boolean }

const INLINE = /\[([^\]]+)\]\(([^)\s]+)\)|`([^`]+)`/g

/** Splits a line into plain text, links and code spans (all a changelog line uses). */
export function parseInline(s: string): Inline[] {
  const out: Inline[] = []
  let last = 0
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push({ text: s.slice(last, m.index) })
    out.push(m[3] !== undefined ? { text: m[3], code: true } : { text: m[1], href: m[2] })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ text: s.slice(last) })
  return out
}
