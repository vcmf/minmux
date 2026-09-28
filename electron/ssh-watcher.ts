// One long-lived chokidar watcher over a changing set of paths (the ssh config files and
// Include dirs), for SshService. Two chokidar 5 traps handled here:
//  - unwatch() puts the path — and everything under it — on a permanent ignore list, so a
//    still-wanted file inside a removed dir would go silent: on a removal we rebuild instead
//    (removals only happen on a config change, so that's rare).
//  - an 'error' event with no listener throws in main (e.g. a WSL share going away).

import { watch } from "chokidar"

export interface PathWatcher {
  set: (paths: string[]) => void
  close: () => void
}

export function createPathWatcher(
  onChange: (path: string) => void,
  onError: (err: unknown) => void,
): PathWatcher {
  let w: ReturnType<typeof watch> | null = null
  let current = new Set<string>()
  const start = (paths: string[]) =>
    watch(paths, { ignoreInitial: true, depth: 0 })
      .on("all", (_event, changed) => onChange(changed))
      .on("error", onError)
  return {
    set: (paths) => {
      const next = new Set(paths)
      const added = [...next].filter((p) => !current.has(p))
      const removed = [...current].filter((p) => !next.has(p))
      current = next
      if (removed.length || !w) {
        void w?.close()
        w = next.size ? start([...next]) : null
      } else if (added.length) w.add(added)
    },
    close: () => {
      void w?.close()
      w = null
      current = new Set()
    },
  }
}
