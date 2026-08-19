import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

/** A draft inline comment. Never sent to GitHub unless the user explicitly sends the review. */
export const CommentSchema = z.object({
  id: z.string(),
  path: z.string(),
  /** Line number in the NEW version of the file; null = file-level comment. */
  line: z.number().int().positive().nullable(),
  body: z.string(),
  chapterId: z.string().nullable().default(null),
  origin: z.enum(["ai", "user"]),
  status: z.enum(["draft", "approved", "dropped"]).default("draft"),
});
export type Comment = z.infer<typeof CommentSchema>;

/** A logical group of changes — the unit of the review walkthrough. */
export const ChapterSchema = z.object({
  id: z.string(),
  title: z.string(),
  explanation: z.string(),
  files: z.array(z.string()),
});
export type Chapter = z.infer<typeof ChapterSchema>;

export const VerdictSchema = z.object({
  recommendation: z.enum(["approve", "comment", "request_changes"]),
  /** 0-100. How confident the AI is that its recommendation is right. */
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

export const PrInfoSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  body: z.string().default(""),
  baseRefName: z.string(),
  headRefName: z.string(),
  headSha: z.string().default(""),
  additions: z.number().int().default(0),
  deletions: z.number().int().default(0),
  changedFiles: z.number().int().default(0),
});
export type PrInfo = z.infer<typeof PrInfoSchema>;

export const ArtifactStatusSchema = z.enum([
  "awaiting", // discovered, not yet reviewed by AI
  "running", // AI review in progress
  "ready", // AI review done, awaiting the human
  "reviewed", // human went through it (edited/approved comments)
  "sent", // review submitted to GitHub by explicit user action
  "skipped", // human decided not to review
  "failed", // AI run errored
]);
export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const RunInfoSchema = z.object({
  model: z.string().nullable().default(null),
  startedAt: z.string(),
  finishedAt: z.string().nullable().default(null),
  costUsd: z.number().nullable().default(null),
  error: z.string().nullable().default(null),
});
export type RunInfo = z.infer<typeof RunInfoSchema>;

export const ArtifactSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** "owner/repo#123" */
  id: z.string(),
  status: ArtifactStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  pr: PrInfoSchema,
  /** Full unified diff of the PR, as fetched at review time. */
  diff: z.string(),
  /** Markdown summary of what the PR does (pr-polish style). */
  summary: z.string().default(""),
  chapters: z.array(ChapterSchema).default([]),
  comments: z.array(CommentSchema).default([]),
  verdict: VerdictSchema.nullable().default(null),
  run: RunInfoSchema.nullable().default(null),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

/** What the AI must return. Subset of the artifact; cerber owns the rest. */
export const AiReviewSchema = z.object({
  summary: z.string(),
  chapters: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      explanation: z.string(),
      files: z.array(z.string()),
    }),
  ),
  comments: z.array(
    z.object({
      path: z.string(),
      line: z.number().int().positive().nullable(),
      body: z.string(),
      chapterId: z.string().nullable().optional(),
    }),
  ),
  verdict: VerdictSchema,
});
export type AiReview = z.infer<typeof AiReviewSchema>;

export function artifactId(pr: Pick<PrInfo, "owner" | "repo" | "number">): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

/** Filesystem-safe key for an artifact id: "owner/repo#123" -> "owner__repo__123" */
export function artifactKey(id: string): string {
  return id.replace(/\//g, "__").replace(/#/g, "__");
}
