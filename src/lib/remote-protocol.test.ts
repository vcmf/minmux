import { describe, expect, it } from "vitest"
import { isPermission, parseClientMessage, parseHostMessage } from "./remote-protocol"

describe("parseClientMessage", () => {
  it("accepts hello and seen, nothing else", () => {
    expect(parseClientMessage('{"t":"hello","v":1,"client":"web"}')).toEqual({
      t: "hello",
      v: 1,
      client: "web",
    })
    expect(parseClientMessage('{"t":"seen","extra":1}')).toEqual({ t: "seen" })
    expect(parseClientMessage('{"t":"hello","v":"1","client":"web"}')).toBeNull()
    expect(parseClientMessage('{"t":"hello","v":1,"client":"evil"}')).toBeNull()
    expect(parseClientMessage('{"t":"keys"}')).toBeNull()
    expect(parseClientMessage("null")).toBeNull()
    expect(parseClientMessage("{oops")).toBeNull()
    expect(parseClientMessage(42)).toBeNull()
    expect(parseClientMessage(`{"t":"seen","x":"${"a".repeat(70_000)}"}`)).toBeNull()
  })

  it("dialog and answer requests keep what names the dialog", () => {
    expect(parseClientMessage('{"t":"dialog","pane":"p","waitId":"w3"}')).toEqual({
      t: "dialog",
      pane: "p",
      waitId: "w3",
    })
    expect(parseClientMessage('{"t":"dialog","pane":"p"}')).toEqual({ t: "dialog", pane: "p" })
    expect(
      parseClientMessage('{"t":"answer","pane":"p","waitId":"w3","n":2,"seen":"sig"}'),
    ).toEqual({ t: "answer", pane: "p", waitId: "w3", n: 2, seen: "sig" })
    expect(
      parseClientMessage('{"t":"answer","pane":"p","waitId":"w3","n":0,"seen":"x"}'),
    ).toBeNull()
  })

  it("parseHostMessage checks the tag", () => {
    expect(parseHostMessage('{"t":"tick"}')).toEqual({ t: "tick" })
    expect(parseHostMessage('{"x":1}')).toBeNull()
    expect(parseHostMessage("nope")).toBeNull()
    expect(parseHostMessage(1)).toBeNull()
  })

  it("isPermission", () => {
    expect(isPermission("keys")).toBe(true)
    expect(isPermission("root")).toBe(false)
  })
})
