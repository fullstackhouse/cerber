// The dot on the tab, for an inbox with something in it.
//
// The cockpit spends its day as a background tab, where the only thing of it
// still on screen is the favicon. The bell is the loud half of that — it
// interrupts when a PR lands; this is the quiet half, a mark that simply sits
// there while work is waiting and goes away when it isn't. Browser state, like
// the bell: nothing here reaches config.json.

import { isOwn, walkable } from "./inbox";
import { ReviewListItem } from "./types";

const PLAIN = "/favicon.svg";
const DOTTED = "/favicon-dot.svg";

/**
 * Whether the tab should wear the dot: the inbox holds a row that still wants
 * something from you. Read off the same list the ‹ › arrows walk and the bell
 * announces from — three ways of saying "there is work here" that would be
 * worth nothing if they disagreed about which rows count.
 *
 * The one row in that list that wants nothing is your own PR nobody has
 * drafted: it sits in the inbox for as long as it is open, waiting on nobody,
 * and a dot that never goes away says nothing. The bell skips it too (it is
 * never announceable). One you asked a draft for is work again.
 */
export const hasInboxWork = (list: ReviewListItem[]) =>
  walkable(list).some((r) => !(isOwn(r) && r.status === "awaiting"));

/** Which icon that state asks for. */
export const faviconHref = (work: boolean) => (work ? DOTTED : PLAIN);

/** Put the answer on the tab. A no-op when it is already the icon on screen. */
export function markFavicon(list: ReviewListItem[]) {
  const href = faviconHref(hasInboxWork(list));
  const link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
  if (!link || link.getAttribute("href") === href) return;
  link.setAttribute("href", href);
}
