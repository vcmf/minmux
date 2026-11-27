import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { DeviceFile } from "./device-file"

const tmpFile = () =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), "devfile-")), "remote-devices.json")

describe("DeviceFile", () => {
  it("writes the latest contents, owner-only", async () => {
    const f = new DeviceFile(tmpFile())
    expect(await f.read()).toBeNull()
    f.write("a")
    f.write("b")
    f.write("c")
    await f.idle()
    expect(await f.read()).toBe("c")
    if (process.platform !== "win32") expect(fs.statSync(f.file).mode & 0o777).toBe(0o600)
  })

  it("close writes what's queued, and a write in flight never lands over it", async () => {
    const f = new DeviceFile(tmpFile())
    f.write("old")
    f.write("new") // queued behind "old", which is in flight
    f.close()
    await f.idle()
    expect(fs.readFileSync(f.file, "utf8")).toBe("new")
    f.write("after") // ignored once closed
    await f.idle()
    expect(fs.readFileSync(f.file, "utf8")).toBe("new")
  })
})
