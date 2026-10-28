import { describe, expect, it } from "vitest";
import { isSend, loadSendKey, parseSendKey, saveSendKey, SEND_KEY, SendKeyEvent } from "./sendkey";

const key = (over: Partial<SendKeyEvent> = {}): SendKeyEvent => ({
  key: "Enter",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  keyCode: 13,
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

  it("never sends on the Enter that confirms a candidate in Safari", () => {
    // Arrives after compositionend: isComposing is already false.
    expect(isSend("enter", key({ keyCode: 229 }))).toBe(false);
    expect(isSend("mod-enter", key({ metaKey: true, keyCode: 229 }))).toBe(false);
  });

  it("ignores every other key", () => {
    expect(isSend("enter", key({ key: "a" }))).toBe(false);
    expect(isSend("enter", key({ key: "Escape", metaKey: true }))).toBe(false);
  });
});

describe("saveSendKey / loadSendKey", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
  };
  const refusing = () => ({
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("QuotaExceededError");
    },
  });

  it("stores the alternative and clears the key for the default", () => {
    const store = memory();
    saveSendKey("enter", store);
    expect(store.data.get(SEND_KEY)).toBe("enter");
    expect(loadSendKey(store)).toBe("enter");
    saveSendKey("mod-enter", store);
    expect(store.data.has(SEND_KEY)).toBe(false);
    expect(loadSendKey(store)).toBe("mod-enter");
  });

  it("keeps a choice storage refused for the rest of this tab", () => {
    saveSendKey("enter", refusing());
    // What the chat box reads when it mounts after Settings has unmounted.
    expect(loadSendKey(refusing())).toBe("enter");
  });

  it("lets a stored choice take over once storage accepts one again", () => {
    saveSendKey("enter", refusing());
    const store = memory();
    saveSendKey("mod-enter", store);
    expect(loadSendKey(store)).toBe("mod-enter");
  });
});
