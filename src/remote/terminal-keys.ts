// The phone's terminal view: its keys bar and how its text is sized.

// Keys for a device allowed raw keys: what a phone keyboard lacks (and Enter, for prompts).
// `short` is what the key shows (the bar fits all eight in a row); `aria` names it for screen readers.
export const KEYS: { label: string; data: string; short?: string; aria?: string }[] = [
  { label: "Esc", data: "\x1b", short: "esc" },
  { label: "Tab", data: "\t", short: "tab" },
  { label: "Ctrl-C", data: "\x03", short: "^C", aria: "Ctrl-C" },
  { label: "↑", data: "\x1b[A", aria: "Up" },
  { label: "↓", data: "\x1b[B", aria: "Down" },
  { label: "←", data: "\x1b[D", aria: "Left" },
  { label: "→", data: "\x1b[C", aria: "Right" },
  { label: "Enter", data: "\r", short: "⏎", aria: "Enter" },
]

/** The font size that fits `cols` columns in `width` px (monospace cells ≈ 0.6 em wide). */
export const fitFontSize = (width: number, cols: number): number =>
  Math.max(5, Math.min(14, Math.floor((width / (Math.max(cols, 1) * 0.6)) * 10) / 10))
