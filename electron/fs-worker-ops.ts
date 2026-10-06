// What the fs worker (a utility process) does for main: one request in, one reply out. Kept
// apart from the process glue so it's unit-tested in-process.
import fs from "node:fs"
import { readDirListing } from "./read-dir"
import type { DirListing } from "../src/lib/dir-listing"

export type FsCall = { op: "readdir" | "stat"; path: string }
export type FsRequest = FsCall & { id: number }

export type FsResult = DirListing | { isDir: boolean }

export type FsReply =
  { id: number; ok: true; value: FsResult } | { id: number; ok: false; code: string }

/** Run one request; never throws (a failure is a reply with the error code). */
export async function handleFsRequest(req: FsRequest): Promise<FsReply> {
  try {
    const value: FsResult =
      req.op === "readdir"
        ? await readDirListing(req.path)
        : { isDir: (await fs.promises.stat(req.path)).isDirectory() }
    return { id: req.id, ok: true, value }
  } catch (e) {
    return { id: req.id, ok: false, code: (e as { code?: string }).code ?? "EUNKNOWN" }
  }
}
