/** Keyboard focus back to the dialog after a click (a focused button would keep Enter). */
export const toDialog = (el: HTMLElement) => el.closest<HTMLElement>("[role=dialog]")?.focus()
