import { Artifact, DaemonStatus, ReviewListItem, SendPreview } from "./types";

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

export const fetchReviews = () => request<ReviewListItem[]>("/api/reviews");

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

export const fetchSendPreview = (key: string, event: string) =>
  request<SendPreview>(`/api/reviews/${encodeURIComponent(key)}/send-preview?event=${event}`);

export const sendReview = (key: string, event: string) =>
  request<Artifact>(`/api/reviews/${encodeURIComponent(key)}/send`, {
    method: "POST",
    body: JSON.stringify({ event, confirm: true }),
  });

export const exportUrl = (key: string) => `/api/reviews/${encodeURIComponent(key)}/export`;
