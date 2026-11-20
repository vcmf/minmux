import { describe, it, expect } from "vitest"
import { WatchSet } from "./watch-set"

const make = (cap = 32, first: string[] = []) => {
  const sent: string[][] = []
  const jobs: (() => void)[] = []
  const w = new WatchSet(
    (d) => sent.push(d),
    first,
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

  it("a `first` owner keeps its place under the cap, even when it rejoins later", () => {
    const { w, sent, tick } = make(2, ["panel"])
    w.set("panel", ["/p"])
    w.set("view", ["/v1", "/v2"])
    tick()
    w.set("panel", []) // e.g. a WSL pane
    tick()
    w.set("panel", ["/p"])
    tick()
    expect(sent[sent.length - 1]).toEqual(["/p", "/v1"])
  })
})
