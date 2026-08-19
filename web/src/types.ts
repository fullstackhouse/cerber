// Mirrors src/core/artifact.ts (the zod schemas are the source of truth).

export interface ReviewListItem {
  id: string;
  key: string;
  status: string;
  updatedAt: string;
  pr: {
    title: string;
    url: string;
    author: string;
    owner: string;
    repo: string;
    number: number;
    additions: number;
    deletions: number;
    changedFiles: number;
  };
  verdict: Verdict | null;
  commentCount: number;
  costUsd: number | null;
}

export interface Verdict {
  recommendation: "approve" | "comment" | "request_changes";
  confidence: number;
  reasoning: string;
}

export interface Chapter {
  id: string;
  title: string;
  explanation: string;
  files: string[];
}

export interface ReviewComment {
  id: string;
  path: string;
  line: number | null;
  body: string;
  chapterId: string | null;
  origin: "ai" | "user";
  status: "draft" | "approved" | "dropped";
  /** Line this comment was written against, if a refresh has since moved it. */
  originalLine?: number | null;
  /** The commented code is gone from the diff — it can't post inline. */
  drifted?: boolean;
}

export interface Artifact {
  schemaVersion: number;
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  pr: ReviewListItem["pr"] & {
    body: string;
    baseRefName: string;
    headRefName: string;
    headSha: string;
    state?: "OPEN" | "CLOSED" | "MERGED";
  };
  diff: string;
  summary: string;
  chapters: Chapter[];
  comments: ReviewComment[];
  verdict: Verdict | null;
  run: {
    model: string | null;
    startedAt: string;
    finishedAt: string | null;
    costUsd: number | null;
    error: string | null;
    withSource?: boolean;
  } | null;
  sent: {
    at: string;
    event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
    url: string | null;
    auto?: boolean;
  } | null;
  refresh?: {
    at: string;
    fromSha: string;
    toSha: string;
    moved: number;
    drifted: number;
  } | null;
}

export interface RefreshResult {
  stale: boolean;
  changed: boolean;
  prState?: "OPEN" | "CLOSED" | "MERGED";
  moved?: number;
  drifted?: number;
  artifact: Artifact;
}

export type DaemonStatus =
  | { enabled: false }
  | {
      enabled: true;
      polling: boolean;
      repos: string[];
      intervalMs: number;
      polls: number;
      errors: number;
      lastPollAt: string | null;
      nextPollAt: string | null;
      lastSummary: string | null;
      autoSend: "shadow" | "on";
      autoSendThreshold: number;
      autoSent: number;
      autoSendCandidates: number;
    };

export interface SendPreview {
  event: "APPROVE" | "COMMENT" | "REQUEST_CHANGES";
  body: string;
  comments: { path: string; line: number; side: "RIGHT"; body: string }[];
  folded: ReviewComment[];
}
