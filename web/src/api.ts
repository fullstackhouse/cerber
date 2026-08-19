import { Artifact, ReviewListItem } from "./types";

export async function fetchReviews(): Promise<ReviewListItem[]> {
  const res = await fetch("/api/reviews");
  if (!res.ok) throw new Error(`GET /api/reviews: ${res.status}`);
  return res.json();
}

export async function fetchReview(key: string): Promise<Artifact> {
  const res = await fetch(`/api/reviews/${encodeURIComponent(key)}`);
  if (!res.ok) throw new Error(`GET /api/reviews/${key}: ${res.status}`);
  return res.json();
}
