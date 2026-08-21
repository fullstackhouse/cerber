// The dot on the tab, for an inbox with something in it.
//
// The cockpit spends its day as a background tab, where the only thing of it
// still on screen is the favicon. The bell is the loud half of that — it
// interrupts when a PR lands; this is the quiet half, a mark that simply sits
// there while work is waiting and goes away when it isn't. Browser state, like
// the bell: nothing here reaches config.json.

import { walkable } from "./inbox";
import { ReviewListItem } from "./types";

const PLAIN = "/favicon.svg";
const DOTTED = "/favicon-dot.svg";

/**
 * Whether the tab should wear the dot: the inbox holds a row that still wants
 * something from you. Deliberately the same list the ‹ › arrows walk and the
 * bell announces — three ways of saying "there is work here" that would be
 * worth nothing if they disagreed about which rows count.
 */
export const hasInboxWork = (list: ReviewListItem[]) => walkable(list).length > 0;

/** Which icon that state asks for. */
export const faviconHref = (work: boolean) => (work ? DOTTED : PLAIN);

/** Put the answer on the tab. A no-op when it is already the icon on screen. */
export function markFavicon(list: ReviewListItem[]) {
  const href = faviconHref(hasInboxWork(list));
  const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link || link.getAttribute("href") === href) return;
  link.setAttribute("href", href);
}
