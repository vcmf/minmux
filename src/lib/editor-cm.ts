// The editor's CodeMirror pieces (docs/design/FILE_EDITING.md): the Tab command, the keymap the
// app's shortcuts can live with, and the highlight style on the file tab's theme colours. Only
// the editor's lazy chunk imports this: CodeMirror never loads with the app.
import { EditorSelection, type Extension, type StateCommand } from "@codemirror/state"
import { type Command, type KeyBinding } from "@codemirror/view"
import {
  defaultKeymap,
  historyKeymap,
  indentLess,
  indentMore,
  insertNewlineAndIndent,
} from "@codemirror/commands"
import { HighlightStyle, getIndentUnit, indentUnit, syntaxHighlighting } from "@codemirror/language"
import { openSearchPanel, searchKeymap } from "@codemirror/search"
import { tags as t } from "@lezer/highlight"

// CodeMirror's own `insertTab` always types a tab character.
/** Tab: spaces to the next indent stop (a tab in a tab-indented file); a selection indents. */
export const insertIndent: StateCommand = ({ state, dispatch }) => {
  if (state.selection.ranges.some((r) => !r.empty)) return indentMore({ state, dispatch })
  const tabs = state.facet(indentUnit) === "\t"
  const unit = getIndentUnit(state)
  const tr = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.from)
    let col = 0
    for (const ch of line.text.slice(0, range.from - line.from))
      col = ch === "\t" ? col + state.tabSize - (col % state.tabSize) : col + 1
    const insert = tabs ? "\t" : " ".repeat(unit - (col % unit))
    return {
      changes: { from: range.from, insert },
      range: EditorSelection.cursor(range.from + insert.length),
    }
  })
  dispatch(state.update(tr, { scrollIntoView: true, userEvent: "input" }))
  return true
}

// The app's ⌘K / Ctrl-K is the palette: CodeMirror's mac Ctrl-K (delete to line end) and
// Shift-Mod-K (delete line) go. Ctrl-M would turn Tab into focus moves: gone too.
const DROPPED = new Set(["Ctrl-k", "Shift-Mod-k", "Ctrl-m", "Alt-Shift-m"])
const kept = (b: KeyBinding) => !(b.key && DROPPED.has(b.key)) && !(b.mac && DROPPED.has(b.mac))

/** The editor's keys: ours first, then CodeMirror's defaults without the ones that clash. */
export function editorKeymap(save: Command, isMac: boolean): KeyBinding[] {
  return [
    { key: "Mod-s", run: save, preventDefault: true },
    { key: "Tab", run: insertIndent, shift: indentLess },
    { key: "Enter", run: insertNewlineAndIndent },
    // Find in the file: ⌘F (CodeMirror's), and Linux / Windows' Ctrl+Shift+F, the app's find key.
    ...(isMac ? [] : [{ key: "Ctrl-Shift-f", run: openSearchPanel, preventDefault: true }]),
    ...searchKeymap,
    ...historyKeymap,
    ...defaultKeymap.filter(kept),
  ]
}

/** The indent unit for a file's indentation (lib/editor-text detectIndent). */
export function indentFor(indent: { tabs: boolean; width: number }): Extension {
  return indentUnit.of(indent.tabs ? "\t" : " ".repeat(indent.width))
}

// The same theme variables App.css gives highlight.js, so the view and the editor match.
const style = HighlightStyle.define([
  {
    tag: [t.comment, t.lineComment, t.blockComment, t.docComment],
    color: "var(--faint)",
    fontStyle: "italic",
  },
  {
    tag: [
      t.keyword,
      t.controlKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.moduleKeyword,
      t.modifier,
      t.bool,
      t.null,
      t.self,
    ],
    color: "var(--blue)",
  },
  {
    tag: [t.string, t.special(t.string), t.regexp, t.attributeValue, t.inserted, t.url],
    color: "var(--accent)",
  },
  { tag: [t.attributeName, t.propertyName], color: "var(--accent)" },
  { tag: [t.number, t.integer, t.float, t.meta, t.atom, t.escape], color: "var(--amber)" },
  {
    tag: [t.function(t.variableName), t.function(t.propertyName), t.heading, t.labelName],
    color: "var(--blue)",
  },
  {
    tag: [t.typeName, t.className, t.namespace, t.standard(t.variableName)],
    color: "var(--amber)",
  },
  { tag: [t.special(t.variableName), t.tagName, t.deleted], color: "var(--red)" },
  // Markdown: **bold** bold and _italic_ italic, their markers still there, dimmed.
  { tag: t.strong, fontWeight: "600" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.monospace, color: "var(--accent)" },
  { tag: [t.processingInstruction, t.contentSeparator], color: "var(--faint)" },
  { tag: t.invalid, color: "var(--red)" },
])

/** Token colours from the theme (a theme switch reaches the editor through the variables). */
export const highlighting: Extension = syntaxHighlighting(style)
