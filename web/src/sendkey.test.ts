import { describe, expect, it } from "vitest";
import { isSend, parseSendKey, SendKeyEvent } from "./sendkey";

const key = (over: Partial<SendKeyEvent> = {}): SendKeyEvent => ({
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  ...over,
});

describe("parseSendKey", () => {
  it("keeps the alternative", () => {
    expect(parseSendKey("enter")).toBe("enter");
  });

  it("sends on ⌘↵ for anything else", () => {
    expect(parseSendKey(null)).toBe("mod-enter");
    expect(parseSendKey("")).toBe("mod-enter");
    expect(parseSendKey("Enter")).toBe("mod-enter");
    expect(parseSendKey("mod-enter")).toBe("mod-enter");
  });
});

describe("isSend", () => {
  it("sends on Enter and leaves Shift+Enter for a new line", () => {
    expect(isSend("enter", key())).toBe(true);
    expect(isSend("enter", key({ shiftKey: true }))).toBe(false);
  });

  it("leaves Enter for a new line when ⌘↵ sends", () => {
    expect(isSend("mod-enter", key())).toBe(false);
    expect(isSend("mod-enter", key({ shiftKey: true }))).toBe(false);
  });

  it("sends on ⌘↵ and Ctrl+↵ under either choice", () => {
    for (const choice of ["enter", "mod-enter"] as const) {
      expect(isSend(choice, key({ metaKey: true }))).toBe(true);
      expect(isSend(choice, key({ ctrlKey: true }))).toBe(true);
    }
  });

  it("never sends mid-composition", () => {
    expect(isSend("enter", key({ isComposing: true }))).toBe(false);
    expect(isSend("mod-enter", key({ metaKey: true, isComposing: true }))).toBe(false);
  });

  it("ignores every other key", () => {
    expect(isSend("enter", key({ key: "a" }))).toBe(false);
    expect(isSend("enter", key({ key: "Escape", metaKey: true }))).toBe(false);
  });
});
