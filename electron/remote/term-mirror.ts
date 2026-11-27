// A watched pane's screen in the remote-host worker (docs/design/REMOTE_CONTROL.md, "Terminal
// view"): a headless xterm fed from main's snapshot, then from the tap's batches in order. Each
// batch carries the epoch (a reattach drops in-flight bytes: new epoch) and its offset in the pane's
// output; anything that doesn't follow on exactly asks for a new snapshot. serialize() gives a
// page a clean start (colours, modes, cursor), so raw history is never replayed into a page.

// @xterm/headless is CommonJS: the worker is an ES module, where only its default import works.
import headless from "@xterm/headless"
import { SerializeAddon } from "@xterm/addon-serialize"

const { Terminal } = headless

export const MIRROR_SCROLLBACK = 1000
export const SNAPSHOT_LINES = 500

export interface TermSnapshot {
  epoch: number
  offset: number // where `text` ends in the pane's output
  cols: number
  rows: number
  text: string // the pane's retained output, up to `offset`
}

export class TermMirror {
  private term: InstanceType<typeof Terminal>
  private serializer = new SerializeAddon()
  private epoch: number
  private end: number // offset the mirror has taken in up to
  private writing: Promise<void> = Promise.resolve()

  constructor(snap: TermSnapshot) {
    this.term = new Terminal({
      cols: Math.max(2, snap.cols),
      rows: Math.max(1, snap.rows),
      scrollback: MIRROR_SCROLLBACK,
      allowProposedApi: true,
    })
    this.term.loadAddon(this.serializer)
    this.epoch = snap.epoch
    this.end = snap.offset
    this.feed(snap.text)
  }

  get cols(): number {
    return this.term.cols
  }

  get rows(): number {
    return this.term.rows
  }

  /** One tap batch: "ok", or "gap" when it doesn't follow on (a new snapshot is needed). */
  write(epoch: number, offset: number, data: string): "ok" | "gap" {
    if (epoch !== this.epoch || offset !== this.end) return "gap"
    this.end += data.length
    this.feed(data)
    return "ok"
  }

  resize(cols: number, rows: number): void {
    if (cols > 1 && rows > 0) this.term.resize(cols, rows)
  }

  /** The screen and recent scrollback as escape sequences, once every write so far is parsed. */
  async serialize(): Promise<string> {
    await this.writing
    return this.serializer.serialize({ scrollback: SNAPSHOT_LINES })
  }

  dispose(): void {
    this.term.dispose()
  }

  private feed(data: string): void {
    if (!data) return
    const parsed = new Promise<void>((r) => this.term.write(data, r))
    this.writing = this.writing.then(() => parsed)
  }
}
