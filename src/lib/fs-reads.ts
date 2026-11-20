// The renderer's one folder-read queue and one watch set, shared by every folder and file tab:
// more views never mean more concurrent reads (lib/read-queue), and no owner replaces another's
// watched folders (lib/watch-set). Read keys are namespaced by who asked ("view\0…") so each
// can drop its own queued reads.
import { ipc } from "./ipc"
import { ReadQueue } from "./read-queue"
import { WatchSet } from "./watch-set"

export const folderReads = new ReadQueue()

export const watches = new WatchSet(
  (dirs, content) => void ipc.fsWatch(dirs, content).catch(() => {}),
)
