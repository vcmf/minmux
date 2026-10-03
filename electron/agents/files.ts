// Files an agent adapter writes into the config dir at install.

import fs from "node:fs"

/** Replace `file` with `content` atomically, and only when it differs (a running agent may read it). */
export function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, "utf8") === content) return
  } catch {
    // missing: write it
  }
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content)
  fs.renameSync(tmp, file)
}
