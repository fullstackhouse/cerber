import { markFavicon } from "./favicon";
import {
  Artifact,
  ChatRef,
  ConfigView,
  DaemonConfig,
  DaemonStatus,
  RefreshResult,
  ReviewListItem,
  SendPreview,
} from "./types";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
  });
  if (!res.ok) {
    let message = `${init?.method ?? "GET"} ${path}: ${res.status}`;
    try {
      const data = await res.json();
      if (data.error) message = data.error;
    } catch {
      // keep default message
    }
    throw new Error(message);
  }
  return res.json();
}

/**
 * The queue, and the tab's dot along with it. Three screens poll this list on
 * their own timers, so re-badging here is the only version of "the tab matches
 * the last queue the cockpit saw" that cannot go stale on whichever screen
 * forgot to do it.
 */
export const fetchReviews = async () => {
  const list = await request<ReviewListItem[]>("/api/reviews");
  markFavicon(list);
  return list;
};

export const fetchDaemonStatus = () => request<DaemonStatus>("/api/daemon");

export const fetchReview = (key: string) =>
  request<Artifact>(`/api/reviews/${encodeURIComponent(key)}`);

export const patchReview = (key: string, body: { status?: string; verdictRecommendation?: string }) =>
  request<Artifact>(`/api/reviews/${encodeURIComponent(key)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const patchComment = (key: string, id: string, body: { body?: string; status?: string }) =>
  request<Artifact>(`/api/reviews/${encodeURIComponent(key)}/comments/${id}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });

export const addComment = (
  key: string,
  body: { path: string; line: number | null; body: string; chapterId?: string | null },
) =>
  request<Artifact>(`/api/reviews/${encodeURIComponent(key)}/comments`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const deleteComment = (key: string, id: string) =>
  request<Artifact>(`/api/reviews/${encodeURIComponent(key)}/comments/${id}`, {
    method: "DELETE",
  });

/**
 * Review a PR the inbox never offered — pasted as a URL or `owner/repo#123`.
 * The reference is checked against GitHub before this returns, so a bad paste
 * throws here with a usable message rather than failing invisibly minutes later.
 * A PR already in the queue comes back as-is instead of being reviewed twice.
 */
export const createReview = (input: string) =>
  request<Artifact & { key: string }>("/api/reviews", {
    method: "POST",
    body: JSON.stringify({ input }),
  });

/** Pull the review onto the PR's current head, re-anchoring comments. */
export const refreshReview = (key: string) =>
  request<RefreshResult>(`/api/reviews/${encodeURIComponent(key)}/refresh`, { method: "POST" });

/**
 * Start a fresh AI review of the PR's current head. Returns while it runs.
 * `withSource` overrides the server default: the run checks the head out and
 * reads the code around the diff.
 */
export const rerunReview = (key: string, withSource?: boolean) =>
  request<Artifact>(
    `/api/reviews/${encodeURIComponent(key)}/rerun` +
      (withSource === undefined ? "" : `?source=${withSource ? "1" : "0"}`),
    { method: "POST" },
  );

/**
 * Start one turn of the conversation about this review. Minutes-long — the
 * reviewer re-reads the code before answering — so it runs detached and this
 * returns as soon as the question is recorded, with `pendingChat` set. Poll the
 * artifact until it clears: whatever the turn revised is already applied by
 * then, so there is nothing to accept.
 */
export const startChatTurn = (
  key: string,
  body: { message: string; refs?: ChatRef[]; allowUserComments?: boolean },
) =>
  request<Artifact>(`/api/reviews/${encodeURIComponent(key)}/chat`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/** Clear a turn that failed. Refused while one is still being answered. */
export const dismissPendingChat = (key: string) =>
  request<Artifact>(`/api/reviews/${encodeURIComponent(key)}/chat/pending`, { method: "DELETE" });

/** Put the review back the way it was before the conversation. Keeps the chat. */
export const resetReviewToPreChat = (key: string) =>
  request<Artifact>(`/api/reviews/${encodeURIComponent(key)}/chat/reset`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const fetchSendPreview = (key: string, event: string) =>
  request<SendPreview>(`/api/reviews/${encodeURIComponent(key)}/send-preview?event=${event}`);

export const sendReview = (key: string, event: string) =>
  request<Artifact>(`/api/reviews/${encodeURIComponent(key)}/send`, {
    method: "POST",
    body: JSON.stringify({ event, confirm: true }),
  });

export const exportUrl = (key: string) => `/api/reviews/${encodeURIComponent(key)}/export`;

export const fetchConfig = () => request<ConfigView>("/api/config");

/** Add a trust rule, or remove it. Returns the config as it now stands. */
export const updateTrustRule = (rule: string, remove = false) =>
  request<ConfigView>("/api/config/trust", {
    method: "POST",
    body: JSON.stringify({ rule, remove }),
  });

/** Flip the inbox knobs. The daemon picks the change up on its next poll. */
export const updateDaemonConfig = (patch: Partial<DaemonConfig>) =>
  request<ConfigView>("/api/config/daemon", {
    method: "POST",
    body: JSON.stringify(patch),
  });
