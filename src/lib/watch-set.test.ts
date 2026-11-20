import { describe, it, expect } from "vitest"
import { WatchSet } from "./watch-set"

const make = (cap = 32) => {
  const sent: string[][] = []
  const jobs: (() => void)[] = []
  const w = new WatchSet(
    (d) => sent.push(d),
    cap,
    (fn) => jobs.push(fn),
  )
  const tick = () => jobs.splice(0).forEach((f) => f())
  return { w, sent, tick }
}

describe("WatchSet", () => {
  it("sends the union of every owner's folders, once per tick", () => {
    const { w, sent, tick } = make()
    w.set("panel", ["/a", "/b"])
    w.set("view1", ["/b", "/c"])
    tick()
    expect(sent).toEqual([["/a", "/b", "/c"]])
  })

  it("one owner leaving keeps the others' folders", () => {
    const { w, sent, tick } = make()
    w.set("panel", ["/a"])
    w.set("view1", ["/c"])
    tick()
    w.set("panel", [])
    tick()
    expect(sent[sent.length - 1]).toEqual(["/c"])
  })

  it("sends nothing when the union didn't change", () => {
    const { w, sent, tick } = make()
    w.set("v1", ["/a"])
    tick()
    w.set("v2", ["/a"])
    tick()
    expect(sent).toHaveLength(1)
  })

  it("caps the union, first owners first", () => {
    const { w, sent, tick } = make(2)
    w.set("v1", ["/a", "/b"])
    w.set("v2", ["/c"])
    tick()
    expect(sent).toEqual([["/a", "/b"]])
  })
})
