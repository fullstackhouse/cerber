// Whether a chapter's title, and each file's header under it, stays pinned
// while you scroll through it. On by default; browser state like the theme
// (theme.ts), since it is about this screen rather than about reviews. Only
// "off" is stored - anything else, or nothing, is on.

import { useState } from "react";

export const STICKY_CHAPTERS_KEY = "cerber.stickyChapters";

export function parseStickyChapters(raw: string | null): boolean {
  return raw !== "off";
}

function stored(): boolean {
  try {
    return parseStickyChapters(localStorage.getItem(STICKY_CHAPTERS_KEY));
  } catch {
    return true;
  }
}

export function useStickyChapters(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(stored);
  const set = (next: boolean) => {
    try {
      if (next) localStorage.removeItem(STICKY_CHAPTERS_KEY);
      else localStorage.setItem(STICKY_CHAPTERS_KEY, "off");
    } catch {
      // Storage refused: the switch still applies to this tab.
    }
    setOn(next);
  };
  return [on, set];
}
