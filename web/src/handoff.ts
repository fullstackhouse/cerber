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

/** A login as typed: a leading `@` is how people write one, and not part of it. */
export const asLogin = (typed: string) => typed.trim().replace(/^@/, "");

/** One name the box can offer, and whether you have handed to them before. */
export interface Candidate {
  login: string;
  /** True when this login is in your own recents — the half of the list you chose. */
  recent: boolean;
}

/**
 * Everyone the box offers, in the order it offers them.
 *
 * Your recents first and in recency order, then whoever else the repo allows,
 * in the order GitHub listed them. The two halves are merged rather than shown
 * as separate lists: it is one question — who takes this — and a name you have
 * used before is the same name, just a better guess.
 *
 * A recent who is not in the repo's list still shows. They may be a
 * collaborator GitHub does not list as assignable, or the list may have failed
 * to load entirely; either way, dropping a name you have *actually handed to*
 * on the strength of a list this does not treat as authoritative would be the
 * wrong way round.
 */
export function candidates(people: string[], recent: string[]): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const login of [...recent, ...people]) {
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ login, recent: recent.some((r) => r.toLowerCase() === key) });
  }
  return out;
}

/**
 * The candidates left standing against what has been typed.
 *
 * Case-insensitive, and a name that *starts* with what you typed comes first: a
 * match in the middle is a fallback, not an equal. Within each half the order
 * it was given in survives, so your recents stay at the top of their group.
 */
export function matchCandidates(all: Candidate[], typed: string): Candidate[] {
  const q = asLogin(typed).toLowerCase();
  if (!q) return all;
  const hits = all.filter((c) => c.login.toLowerCase().includes(q));
  const starts = (c: Candidate) => c.login.toLowerCase().startsWith(q);
  return [...hits.filter(starts), ...hits.filter((c) => !starts(c))];
}
