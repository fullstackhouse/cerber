// Who you hand reviews to, remembered so the second time is one click.
//
// Browser state, beside the theme pin and the bell's announced-keys: a
// convenience about this screen rather than a fact about reviews, so
// config.json stays the file that decides what cerber *does*. Being wrong costs
// nothing either — the name is a text box with these as suggestions, and GitHub
// refuses a login that cannot review the PR anyway.

export const HANDOFF_KEY = "cerber.handoff.recent";

/** How many to keep: a list you glance at, not a directory of the org. */
export const MAX_RECENT = 5;

/** A GitHub login, as GitHub itself allows: 1-39 of alphanumerics and inner hyphens. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export const isLogin = (s: string) => LOGIN.test(s);

/**
 * Whatever is in storage, filtered down to things that could be logins.
 *
 * Defensive because the value is hand-editable like everything else cerber
 * keeps: garbage, an old shape, or a half-written array must leave the box
 * empty rather than put nonsense in front of a GitHub write.
 */
export function parseRecent(raw: string | null): string[] {
  try {
    const parsed = JSON.parse(raw ?? "");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string" && isLogin(s)).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function recentHandoffs(): string[] {
  try {
    return parseRecent(localStorage.getItem(HANDOFF_KEY));
  } catch {
    return [];
  }
}

/**
 * Put this login at the front, and hand back the list as it now stands.
 *
 * Case-insensitive de-duplication, because GitHub logins are: "Maks" and "maks"
 * are one person, and a list that said both would make the suggestion worse
 * than no suggestion.
 */
export function nextRecent(current: string[], login: string): string[] {
  const kept = current.filter((s) => s.toLowerCase() !== login.toLowerCase());
  return [login, ...kept].slice(0, MAX_RECENT);
}

export function rememberHandoff(login: string): string[] {
  const next = nextRecent(recentHandoffs(), login);
  try {
    localStorage.setItem(HANDOFF_KEY, JSON.stringify(next));
  } catch {
    // Storage refused (private mode, a locked-down profile). The handoff itself
    // already happened; only the suggestion for next time is lost.
  }
  return next;
}
