/** The keys main reads from `before-input-event` (a subset of Electron's Input). */
export type ChordInput = {
  key: string
  control: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

/** The full-screen chord: ⌃⌘F on macOS (the system's own), F11 elsewhere. */
export function isFullScreenChord(i: ChordInput, platform: string): boolean {
  if (platform === "darwin") {
    return i.control && i.meta && !i.alt && !i.shift && i.key.toLowerCase() === "f"
  }
  return i.key === "F11" && !i.control && !i.meta && !i.alt && !i.shift
}
