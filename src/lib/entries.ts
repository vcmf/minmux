// What a pane entry is. A terminal's entry id is its session id; folders and files (later
// steps of docs/design/WORKDIR_OBJECTS.md) get ids with OBJECT_PREFIX, never a session id.

export const OBJECT_PREFIX = "obj-"

/** A terminal entry (a session id), not a folder or file. */
export const isTerminalEntry = (id: string): boolean => !id.startsWith(OBJECT_PREFIX)
