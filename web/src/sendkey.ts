// Which key sends a chat message: ⌘↵, like every other box in the cockpit, or
// Enter, like most chats, for someone who sends one-liners to the reviewer and
// would rather not reach for ⌘. Browser state, like the theme pin: it is about
// the keyboard in front of this screen, not about reviews, so it lives in
// localStorage rather than in config.json.

import { useState } from "react";

export type SendKey = "enter" | "mod-enter";

export const SEND_KEY = "cerber.sendKey";

/** Anything but the one alternative - absent, garbage, a hand edit gone wrong - sends on ⌘↵. */
export function parseSendKey(raw: string | null): SendKey {
  return raw === "enter" ? raw : "mod-enter";
}

/** The parts of a keydown the decision reads, so it can be tested without a DOM. */
export interface SendKeyEvent {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  isComposing: boolean;
}

/**
 * Whether this keydown sends. ⌘↵ (Ctrl+↵ off a Mac) sends under either
 * choice, so the default never stops working once Enter is switched on; plain
 * Enter sends only under "enter", where Shift+Enter is the new line. Never
 * mid-composition, where Enter picks the IME's candidate rather than finishing
 * the message.
 */
export function isSend(choice: SendKey, e: SendKeyEvent): boolean {
  if (e.key !== "Enter" || e.isComposing) return false;
  if (e.metaKey || e.ctrlKey) return true;
  return choice === "enter" && !e.shiftKey;
}

// The choice this tab made when storage refused to keep it (private mode, a
// locked-down profile). Settings and the chat box each read the choice when
// they mount, so without this the chat would read the default straight back
// and the switch would only ever have moved its own radio.
let unsaved: SendKey | null = null;

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** The choice in force: this tab's unsaved one if storage refused it, else the stored one. */
export function loadSendKey(storage?: Store): SendKey {
  if (unsaved) return unsaved;
  try {
    // Inside the try: with site data blocked, merely reading
    // `window.localStorage` throws.
    return parseSendKey((storage ?? localStorage).getItem(SEND_KEY));
  } catch {
    return "mod-enter";
  }
}

/**
 * Store a choice. The default clears the key rather than storing a value, so
 * an absent key and the default are one state. Storage that refuses is not an
 * error: the choice holds for this tab, and a reload sends on ⌘↵ again.
 */
export function saveSendKey(choice: SendKey, storage?: Store): void {
  try {
    const store = storage ?? localStorage;
    if (choice === "mod-enter") store.removeItem(SEND_KEY);
    else store.setItem(SEND_KEY, choice);
    unsaved = null;
  } catch {
    unsaved = choice;
  }
}

export function useSendKey(): [SendKey, (choice: SendKey) => void] {
  const [choice, setChoice] = useState<SendKey>(() => loadSendKey());
  const set = (next: SendKey) => {
    saveSendKey(next);
    setChoice(next);
  };
  return [choice, set];
}
