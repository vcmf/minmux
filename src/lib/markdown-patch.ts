// A markdown Preview's DOM, updated block by block (docs/design/MARKDOWN.md, "Performance"): an
// agent rewriting a file mostly adds or changes a few blocks, so only the blocks whose HTML
// changed are parsed and replaced (the run between the unchanged ones at the start and at the
// end). A 4 MB document whose top gains a section costs a few nodes, not a whole innerHTML write.
// Untouched blocks keep their nodes: loaded images, open <details> and the scroll position stay.
import type { Block } from "./markdown"

/** What a Preview shows now: each block's HTML and its nodes. */
export interface Shown {
  html: string[]
  nodes: Node[][]
}

export const emptyShown = (): Shown => ({ html: [], nodes: [] })

/** Bring `body` from `shown` to `next`; returns the nodes added (to hydrate). */
export function patchBlocks(body: HTMLElement, shown: Shown, next: Block[]): Node[] {
  const old = shown.html
  let a = 0
  while (a < old.length && a < next.length && old[a] === next[a]!.html) a++
  let z = 0
  while (
    z < old.length - a &&
    z < next.length - a &&
    old[old.length - 1 - z] === next[next.length - 1 - z]!.html
  ) {
    z++
  }
  for (let k = a; k < old.length - z; k++)
    for (const n of shown.nodes[k]!) n.parentNode?.removeChild(n)

  const changed = next.slice(a, next.length - z)
  const added: Node[][] = []
  if (changed.length) {
    // Each block parsed on its own: a tag one leaves open (raw <details>) closes at its end
    // instead of taking in the blocks after it.
    const tpl = document.createElement("template")
    for (const b of changed) {
      tpl.innerHTML = b.html
      added.push([...tpl.content.childNodes])
    }
    // Before the first unchanged block after them that has a node (else at the end).
    const before = shown.nodes.slice(old.length - z).find((ns) => ns.length)?.[0] ?? null
    const frag = document.createDocumentFragment()
    for (const n of added.flat()) frag.appendChild(n)
    body.insertBefore(frag, before && before.parentNode === body ? before : null)
  }

  shown.nodes = [...shown.nodes.slice(0, a), ...added, ...shown.nodes.slice(old.length - z)]
  shown.html = next.map((b) => b.html)
  // Every block's line (they move when text is added above): set where it changed.
  next.forEach((b, i) => {
    const el = shown.nodes[i]!.find((n): n is HTMLElement => n.nodeType === Node.ELEMENT_NODE)
    if (!el) return
    const line = b.line ? String(b.line) : undefined
    if (el.dataset.line === line) return
    if (line) el.dataset.line = line
    else delete el.dataset.line
  })
  return added.flat()
}
