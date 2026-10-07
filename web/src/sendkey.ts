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

function stored(): SendKey {
  try {
    return parseSendKey(localStorage.getItem(SEND_KEY));
  } catch {
    return "mod-enter";
  }
}

export function useSendKey(): [SendKey, (choice: SendKey) => void] {
  const [choice, setChoice] = useState<SendKey>(stored);
  const set = (next: SendKey) => {
    try {
      if (next === "mod-enter") localStorage.removeItem(SEND_KEY);
      else localStorage.setItem(SEND_KEY, next);
    } catch {
      // Storage refused (private mode, a locked-down profile). The switch still
      // applies to this tab; a reload just sends on ⌘↵ again.
    }
    setChoice(next);
  };
  return [choice, set];
}
