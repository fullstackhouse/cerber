// Light or dark. The cockpit follows the machine by default - the stylesheet's
// tokens are `light-dark()` pairs, so that needs no script at all - and this
// browser can pin one. Browser state, like the notification switch: it is a
// preference about this screen, not about reviews, so it lives in localStorage
// rather than in config.json.
//
// index.html applies the stored choice before the first paint, so a pinned
// dark cockpit never flashes white on reload. It can't import from here, so it
// repeats the key and the values; theme.test.ts fails if the two drift.

import { useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";

export const THEME_KEY = "cerber.theme";

/** Anything but a pin - absent, garbage, a hand edit gone wrong - follows the machine. */
export function parseTheme(raw: string | null): ThemeChoice {
  return raw === "light" || raw === "dark" ? raw : "system";
}

function stored(): ThemeChoice {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** A pin sets `data-theme`, which the stylesheet turns into `color-scheme`; "system" clears it. */
export function applyTheme(choice: ThemeChoice, root: HTMLElement = document.documentElement): void {
  if (choice === "system") delete root.dataset.theme;
  else root.dataset.theme = choice;
}

/**
 * Store a choice. "system" clears the key rather than storing a value, so an
 * absent key and the default are one state. Storage that refuses (private
 * mode, a locked-down profile) is not an error: the switch still applies to
 * this tab, and a reload just follows the machine again.
 */
export function saveTheme(choice: ThemeChoice, storage: Pick<Storage, "setItem" | "removeItem"> = localStorage): void {
  try {
    if (choice === "system") storage.removeItem(THEME_KEY);
    else storage.setItem(THEME_KEY, choice);
  } catch {
    // See above.
  }
}

/**
 * Keep every open tab on the pin: a switch flipped in one tab reaches the
 * others through the `storage` event, which fires everywhere but the tab
 * that wrote it. Called once at startup, so it works on every screen.
 */
export function followOtherTabs(): void {
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY || e.key === null) applyTheme(parseTheme(e.newValue));
  });
}

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(stored);
  const set = (next: ThemeChoice) => {
    saveTheme(next);
    applyTheme(next);
    setChoice(next);
  };
  return [choice, set];
}
