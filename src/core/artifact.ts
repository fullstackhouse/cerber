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
  /** Set when the user edits an AI comment's body — calibration signal. */
  editedByUser: z.boolean().default(false),
  /** Line this comment was written against, when a refresh has since moved it. */
  originalLine: z.number().int().positive().nullable().default(null),
  /** The commented line no longer exists in the diff — it can't post inline. */
  drifted: z.boolean().default(false),
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
  /** OPEN | CLOSED | MERGED, as of the last fetch. */
  state: z.enum(["OPEN", "CLOSED", "MERGED"]).default("OPEN"),
  /** GitHub reports a draft's `state` as OPEN, so draftness needs its own field.
   *  Defaulted: artifacts written before this existed still load. */
  isDraft: z.boolean().default(false),
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
  /** The reviewer could read the repo at the PR head, not just the diff. */
  withSource: z.boolean().default(false),
  /** The user vouched for this PR, so the reviewer could also run commands. */
  trusted: z.boolean().default(false),
  /**
   * The Claude session this review ran in. Chat turns resume it, so the
   * reviewer answering a question still holds everything it read.
   */
  sessionId: z.string().nullable().default(null),
});
export type RunInfo = z.infer<typeof RunInfoSchema>;

export const SentInfoSchema = z.object({
  at: z.string(),
  event: z.enum(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
  url: z.string().nullable().default(null),
  /** True when the daemon auto-sent this review (opt-in --auto-send). */
  auto: z.boolean().default(false),
});
export type SentInfo = z.infer<typeof SentInfoSchema>;

/** Result of pulling a review forward onto a newer head commit. */
export const RefreshInfoSchema = z.object({
  at: z.string(),
  fromSha: z.string(),
  toSha: z.string(),
  /** Comments whose line number changed but whose code was found again. */
  moved: z.number().int().default(0),
  /** Comments whose line is gone from the new diff — they now post in the body. */
  drifted: z.number().int().default(0),
});
export type RefreshInfo = z.infer<typeof RefreshInfoSchema>;

/** What actually happened vs what the AI proposed — recorded at send time. */
export const CalibrationSchema = z.object({
  aiRecommendation: z.enum(["approve", "comment", "request_changes"]).nullable(),
  aiConfidence: z.number().nullable(),
  sentEvent: z.enum(["APPROVE", "COMMENT", "REQUEST_CHANGES"]),
  aiCommentsTotal: z.number().int(),
  aiCommentsDropped: z.number().int(),
  aiCommentsEdited: z.number().int(),
  userCommentsAdded: z.number().int(),
});
export type Calibration = z.infer<typeof CalibrationSchema>;

/**
 * One edit a chat turn made to the review it is about.
 *
 * The agent revises the draft directly — there is no accept step — so these are
 * a record of what already happened, rendered in the transcript, not a proposal
 * awaiting a click. The user's escape hatch is the conversation itself, plus
 * the one pre-chat snapshot.
 */
export const RevisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("summary"), body: z.string() }),
  z.object({ kind: z.literal("verdict"), verdict: VerdictSchema }),
  z.object({ kind: z.literal("chapter"), chapterId: z.string(), title: z.string().optional(), explanation: z.string().optional() }),
  z.object({ kind: z.literal("comment-edit"), commentId: z.string(), body: z.string() }),
  z.object({ kind: z.literal("comment-drop"), commentId: z.string() }),
  z.object({
    kind: z.literal("comment-add"),
    path: z.string(),
    line: z.number().int().positive().nullable(),
    body: z.string(),
    chapterId: z.string().nullable().default(null),
  }),
]);
export type Revision = z.infer<typeof RevisionSchema>;

/** A revision the run declined to make, and why — shown in the transcript. */
export const RefusalSchema = z.object({
  revision: RevisionSchema,
  reason: z.string(),
});
export type Refusal = z.infer<typeof RefusalSchema>;

export const ChatTurnSchema = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  at: z.string(),
  body: z.string(),
  /** What the user pointed at with "discuss this" — user turns only. */
  refs: z
    .array(
      z.object({
        target: z.enum(["summary", "verdict", "chapter", "comment"]),
        id: z.string().nullable().default(null),
      }),
    )
    .default([]),
  /** Edits this turn made to the review. Assistant turns only. */
  revisions: z.array(RevisionSchema).default([]),
  /** Edits this turn asked for but the artifact would not accept. */
  refused: z.array(RefusalSchema).default([]),
  costUsd: z.number().nullable().default(null),
});
export type ChatTurn = z.infer<typeof ChatTurnSchema>;

/**
 * The chat turn being answered right now — or the one that failed.
 *
 * A turn takes minutes: the reviewer re-reads the code before it answers. So
 * the turn runs detached and this is what the cockpit polls. The question is on
 * the artifact from the moment it is asked, which is what makes a reload
 * mid-turn show it still being answered rather than a conversation that lost
 * it, and what carries a failure back to a request that already returned.
 */
export const PendingChatSchema = z.object({
  /** The message being answered — shown in the transcript while we wait. */
  message: z.string(),
  refs: ChatTurnSchema.shape.refs,
  startedAt: z.string(),
  /**
   * What the turn has been doing, in its own words — "reading src/core/diff.ts",
   * "searching for carryOverComments". The answer takes minutes and this is the
   * only honest account of them; it is thrown away when the answer lands.
   */
  progress: z.array(z.string()).default([]),
  /** Why the turn failed. Null while it is still running. */
  error: z.string().nullable().default(null),
});
export type PendingChat = z.infer<typeof PendingChatSchema>;

/** The parts of a review a chat turn may rewrite — the reset target. */
export const ReviewSnapshotSchema = z.object({
  at: z.string(),
  summary: z.string(),
  chapters: z.array(ChapterSchema),
  comments: z.array(CommentSchema),
  verdict: VerdictSchema.nullable(),
});
export type ReviewSnapshot = z.infer<typeof ReviewSnapshotSchema>;

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
  /** Set once the review was sent to GitHub (explicitly, or via opt-in auto-send). */
  sent: SentInfoSchema.nullable().default(null),
  /** Last time this review was pulled forward onto a newer head commit. */
  refresh: RefreshInfoSchema.nullable().default(null),
  calibration: CalibrationSchema.nullable().default(null),
  /** The conversation about this review. Never sent to GitHub. */
  chat: z.array(ChatTurnSchema).default([]),
  /** A turn in flight, or the one that failed. Null when nothing is pending. */
  pendingChat: PendingChatSchema.nullable().default(null),
  /** The review as it stood before the first chat turn — "reset" restores this. */
  preChat: ReviewSnapshotSchema.nullable().default(null),
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

/** What a chat turn must return: something to say, and what it changed. */
export const AiChatTurnSchema = z.object({
  reply: z.string(),
  revisions: z.array(RevisionSchema).default([]),
});
export type AiChatTurn = z.infer<typeof AiChatTurnSchema>;

export function artifactId(pr: Pick<PrInfo, "owner" | "repo" | "number">): string {
  return `${pr.owner}/${pr.repo}#${pr.number}`;
}

/** Filesystem-safe key for an artifact id: "owner/repo#123" -> "owner__repo__123" */
export function artifactKey(id: string): string {
  return id.replace(/\//g, "__").replace(/#/g, "__");
}
