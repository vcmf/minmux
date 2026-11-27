// The phone's terminal view: its keys bar and how its text is sized.

// Keys for a device allowed raw keys: what a phone keyboard lacks (and Enter, for prompts).
export const KEYS: { label: string; data: string }[] = [
  { label: "Esc", data: "\x1b" },
  { label: "Tab", data: "\t" },
  { label: "Ctrl-C", data: "\x03" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "←", data: "\x1b[D" },
  { label: "→", data: "\x1b[C" },
  { label: "Enter", data: "\r" },
]

/** The font size that fits `cols` columns in `width` px (monospace cells ≈ 0.6 em wide). */
export const fitFontSize = (width: number, cols: number): number =>
  Math.max(5, Math.min(14, Math.floor((width / (Math.max(cols, 1) * 0.6)) * 10) / 10))
