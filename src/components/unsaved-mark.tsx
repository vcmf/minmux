import { useSyncExternalStore } from "react"
import { edits } from "../lib/edit-store"

const subscribe = (fn: () => void) => edits.subscribe(fn)

/** A dot on a file's tab while it has unsaved changes (or a save in flight). */
export function UnsavedMark({ id }: { id: string }) {
  const unsaved = useSyncExternalStore(subscribe, () => edits.isUnsaved(id))
  return unsaved ? <span className="unsaved-mark" title="Unsaved changes" /> : null
}
