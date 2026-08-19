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
  } | null;
}
