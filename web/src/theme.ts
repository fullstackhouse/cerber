// Light or dark. The cockpit follows the machine by default - the stylesheet's
// tokens are `light-dark()` pairs, so that needs no script at all - and this
// browser can pin one. Browser state, like the notification switch: it is a
// preference about this screen, not about reviews, so it lives in localStorage
// rather than in config.json.
//
// index.html applies the stored choice before the first paint, so a pinned
// dark cockpit never flashes white on reload. Keep its key and values in step
// with these.

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

export function useTheme(): [ThemeChoice, (choice: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(stored);
  const set = (next: ThemeChoice) => {
    try {
      if (next === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, next);
    } catch {
      // Storage refused (private mode, a locked-down profile). The switch still
      // applies to this tab; a reload just follows the machine again.
    }
    applyTheme(next);
    setChoice(next);
  };
  return [choice, set];
}
