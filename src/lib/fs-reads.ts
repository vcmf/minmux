// The renderer's one folder-read queue and one watch set, shared by the Files panel and every
// folder view: more views never mean more concurrent reads (lib/read-queue), and no owner
// replaces another's watched folders (lib/watch-set). Read keys are namespaced by who asked
// ("panel\0…", "view\0…") so each can drop its own queued reads.
import { ipc } from "./ipc"
import { ReadQueue } from "./read-queue"
import { WatchSet } from "./watch-set"

export const folderReads = new ReadQueue()

export const watches = new WatchSet(
  (dirs) => void ipc.fsWatch(dirs).catch(() => {}),
  ["files-panel"],
)
