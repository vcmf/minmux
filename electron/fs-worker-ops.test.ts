import { describe, it, expect, beforeAll, afterAll } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { handleFsRequest } from "./fs-worker-ops"

let tmp = ""
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "minmux-fsw-")))
  fs.mkdirSync(path.join(tmp, "sub"))
  fs.writeFileSync(path.join(tmp, "a.txt"), "")
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe("handleFsRequest", () => {
  it("readdir replies with the bounded listing", async () => {
    expect(await handleFsRequest({ id: 1, op: "readdir", path: tmp })).toEqual({
      id: 1,
      ok: true,
      value: {
        entries: [
          { name: "sub", isDir: true },
          { name: "a.txt", isDir: false },
        ],
        truncated: false,
        total: 2,
      },
    })
  })

  it("stat replies whether it's a folder", async () => {
    expect(await handleFsRequest({ id: 2, op: "stat", path: tmp })).toEqual({
      id: 2,
      ok: true,
      value: { isDir: true },
    })
  })

  it("a failure is a reply carrying the error code, never a throw", async () => {
    expect(await handleFsRequest({ id: 3, op: "readdir", path: path.join(tmp, "nope") })).toEqual({
      id: 3,
      ok: false,
      code: "ENOENT",
    })
  })
})
