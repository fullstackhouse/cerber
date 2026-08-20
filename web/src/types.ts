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
    /** Merged/closed PRs are archived out of the default queue view. */
    state?: "OPEN" | "CLOSED" | "MERGED";
    /** A draft still awaiting you: reviewable, but its author hasn't finished. */
    isDraft?: boolean;
    additions: number;
    deletions: number;
    changedFiles: number;
    baseRefName?: string;
    headRefName?: string;
  };
  verdict: Verdict | null;
  commentCount: number;
  /** Of those, the ones whose code is gone — they post in the body, not inline. */
  driftedCount?: number;
  costUsd: number | null;
  withSource?: boolean | null;
  trusted?: boolean | null;
  runError?: string | null;
  sent?: Artifact["sent"];
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

/** Merge impact of a finding. Absent/null = not a finding (question, note). */
export type Severity = "blocker" | "minor" | "nit";

export interface ReviewComment {
  id: string;
  path: string;
  line: number | null;
  body: string;
  chapterId: string | null;
  /** Only "blocker" stands between the PR and approval. */
  severity?: Severity | null;
  origin: "ai" | "user";
  status: "draft" | "approved" | "dropped";
  /** Line this comment was written against, if a refresh has since moved it. */
  originalLine?: number | null;
  /** The commented code is gone from the diff — it can't post inline. */
  drifted?: boolean;
}

/** What the user pointed at with "discuss this". */
export interface ChatRef {
  target: "summary" | "verdict" | "chapter" | "comment";
  id: string | null;
}

/** One edit a chat turn made to the review. Already applied — not a proposal. */
export type Revision =
  | { kind: "summary"; body: string }
  | { kind: "verdict"; verdict: Verdict }
  | { kind: "chapter"; chapterId: string; title?: string; explanation?: string }
  | { kind: "comment-edit"; commentId: string; body: string; severity?: Severity | null }
  | { kind: "comment-drop"; commentId: string }
  | { kind: "comment-add"; path: string; line: number | null; body: string; chapterId: string | null; severity?: Severity | null };

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  at: string;
  body: string;
  refs: ChatRef[];
  revisions: Revision[];
  refused: { revision: Revision; reason: string }[];
  costUsd: number | null;
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
    trusted?: boolean;
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
  /** The conversation about this review. Never sent to GitHub. */
  chat?: ChatTurn[];
  /** A turn being answered right now, or the one that failed. */
  pendingChat?: PendingChat | null;
  /** Present once a chat has started — what "reset" goes back to. */
  preChat?: { at: string } | null;
}

/** A chat turn in flight. Turns run detached; this is what the cockpit polls. */
export interface PendingChat {
  message: string;
  refs: ChatRef[];
  startedAt: string;
  /** What the turn has been doing, in its own words. Grows while you wait. */
  progress: string[];
  /** Why the turn failed. Null while it is still being answered. */
  error: string | null;
}

export interface RefreshResult {
  stale: boolean;
  changed: boolean;
  prState?: "OPEN" | "CLOSED" | "MERGED";
  moved?: number;
  drifted?: number;
  artifact: Artifact;
}

/**
 * Whose move it is on a PR GitHub still asks you for. A review of any kind
 * clears the request, so one that is still open means you never pressed
 * GitHub's review button — but you may well have said your piece in the
 * conversation. `unknown` means the conversation could not be read.
 */
export type Reply = "none" | "you" | "them" | "unknown";

export interface AwaitingPr {
  id: string;
  reply: Reply;
}

export type DaemonStatus =
  | { enabled: false }
  | {
      enabled: true;
      polling: boolean;
      repos: string[];
      intervalMs: number;
      /** False when the config's poll toggle idles the loop. */
      pollEnabled: boolean;
      autoReview: boolean;
      /** Unattended reviews may run PR code: auto-review on + trust rules set. */
      trustedRuns: boolean;
      polls: number;
      errors: number;
      lastPollAt: string | null;
      nextPollAt: string | null;
      lastSummary: string | null;
      /**
       * The PRs GitHub still holds a review request from you on, as of the last
       * poll that reached it, and whose move it is on each. The queue filters on
       * what you settled locally, so this is what tells it which awaiting PRs
       * its own filters are hiding.
       */
      awaiting: AwaitingPr[];
      /** GitHub discovery is failing (gh unauthed, offline); local queue still works. */
      lastPollError: string | null;
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

export interface TrustEntry {
  /** The rule as written: "@acme/*", "@acme/devs", "@someone", "!@acme/devs". */
  rule: string;
  explanation: string;
  denies: boolean;
}

export interface DaemonConfig {
  poll: boolean;
  autoReview: boolean;
  intervalMinutes: number;
  parallel: number;
  repos: string[];
}

export interface ConfigView {
  path: string;
  trust: TrustEntry[];
  daemon: DaemonConfig;
}
