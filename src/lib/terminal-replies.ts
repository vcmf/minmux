// What xterm says back to the program it shows (cursor position, device attributes, colour and
// mode reports, focus events), as opposed to what the user typed. A remote surface shows another
// machine's pane, whose own terminal already answers its program: these replies are dropped.

/* eslint-disable no-control-regex -- escape sequences are what these match */
const REPLIES = [
  /^\x1b\[\??\d+(;\d+)*R$/, // cursor position (DSR 6)
  /^\x1b\[[?>=][\d;]*c$/, // device attributes
  /^\x1b\[\??[\d;]*\$y$/, // mode reports (DECRQM)
  /^\x1b\[\??[\d;]*n$/, // status and colour-scheme reports
  /^\x1b\[[\d;]*t$/, // window reports
  /^\x1b\][^\x07\x1b]*(\x07|\x1b\\)$/, // OSC replies (colours 10/11/4, …)
  /^\x1bP[\s\S]*\x1b\\$/, // DCS replies (XTVERSION, DECRQSS)
]
/* eslint-enable no-control-regex */

/** A reply xterm made while parsing output (while output is being parsed only: Shift+F3 also
 *  reads `ESC [1;2R`). */
export const isTerminalReply = (data: string): boolean => REPLIES.some((r) => r.test(data))

/** Focus in/out reports: for the remote pane's own window, never this one's focus. */
export const isFocusReport = (data: string): boolean => data === "\x1b[I" || data === "\x1b[O"

/** A mouse report xterm sends for the program (mouse mode): "use" for a press, "move" for
 *  motion, wheel and releases, null when it isn't one. */
export function mouseReport(data: string): "use" | "move" | null {
  // eslint-disable-next-line no-control-regex -- an escape sequence
  const sgr = /^\x1b\[<(\d+);\d+;\d+([Mm])$/.exec(data)
  if (sgr) {
    const b = Number(sgr[1])
    return sgr[2] === "M" && (b & 32) === 0 && b < 64 ? "use" : "move"
  }
  if (data.startsWith("\x1b[M") && data.length === 6) {
    const b = data.charCodeAt(3) - 32
    return (b & 32) === 0 && b < 64 && (b & 3) !== 3 ? "use" : "move"
  }
  return null
}
