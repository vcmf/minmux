import type React from "react"

/** A hint button's mousedown: skips the pane's focus handler and keeps focus on the terminal. */
export const stopPaneMouseDown = (e: React.MouseEvent) => {
  e.stopPropagation()
  e.preventDefault()
}
