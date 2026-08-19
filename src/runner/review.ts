import { randomUUID } from "node:crypto";
import {
  AiReview,
  AiReviewSchema,
  Artifact,
  SCHEMA_VERSION,
  artifactId,
} from "../core/artifact.js";
import { PrRef, fetchPrDiff, fetchPrInfo } from "../core/gh.js";
import { carryOverComments } from "../core/refresh.js";
import { loadArtifact, saveArtifact } from "../core/state.js";
import { extractJson, runClaude } from "./claude.js";
import { ReviewInProgressError, beginReview, endReview } from "./inflight.js";
import { buildReviewPrompt, buildRetryPrompt } from "./prompt.js";

export interface ReviewOptions {
  model?: string;
  onProgress?: (message: string) => void;
  /** Re-review even if a fresh artifact for the same head SHA exists. */
  force?: boolean;
}

export interface ReviewResult {
  artifact: Artifact;
  /** True when an up-to-date artifact already existed and no AI run happened. */
  skipped: boolean;
}

/** Statuses that a fresh artifact can keep without a re-run. */
const FRESH_STATUSES = new Set(["ready", "reviewed", "sent", "skipped"]);

/**
 * Fetch a PR, run the AI review, persist the artifact at each stage.
 * Everything stays local — nothing is ever written to GitHub.
 */
export async function reviewPr(ref: PrRef, opts: ReviewOptions = {}): Promise<ReviewResult> {
  beginReview(artifactId(ref));
  try {
    return await runReview(ref, opts);
  } finally {
    endReview(artifactId(ref));
  }
}

async function runReview(ref: PrRef, opts: ReviewOptions): Promise<ReviewResult> {
  const log = opts.onProgress ?? (() => {});
  const now = () => new Date().toISOString();

  log(`Fetching ${ref.owner}/${ref.repo}#${ref.number}…`);
  const pr = await fetchPrInfo(ref);

  const existing = await loadArtifact(artifactId(pr));
  if (!opts.force) {
    if (
      existing &&
      FRESH_STATUSES.has(existing.status) &&
      existing.pr.headSha !== "" &&
      existing.pr.headSha === pr.headSha
    ) {
      log(`Up to date (head ${pr.headSha.slice(0, 7)}, status ${existing.status}) — skipping. Use --force to re-review.`);
      return { artifact: existing, skipped: true };
    }
  }

  const diff = await fetchPrDiff(ref);

  let artifact: Artifact = {
    schemaVersion: SCHEMA_VERSION,
    id: artifactId(pr),
    status: "running",
    createdAt: existing?.createdAt ?? now(),
    updatedAt: now(),
    pr,
    diff,
    summary: "",
    chapters: [],
    comments: [],
    verdict: null,
    run: { model: opts.model ?? null, startedAt: now(), finishedAt: null, costUsd: null, error: null },
    sent: null,
    refresh: null,
    calibration: null,
  };
  await saveArtifact(artifact);

  const { prompt, truncated } = buildReviewPrompt(pr, diff);
  if (truncated) log("Warning: diff exceeds the context budget and was truncated.");
  log(`Reviewing with Claude${opts.model ? ` (${opts.model})` : ""}… this can take a few minutes.`);

  try {
    const review = await runAiReview(prompt, opts);
    // The prompt demands each file in exactly one chapter, but models drift:
    // keep a file only in the first chapter that claims it.
    const seen = new Set<string>();
    const chapters = review.ai.chapters.map((ch) => {
      const files = ch.files.filter((f) => !seen.has(f));
      files.forEach((f) => seen.add(f));
      return { ...ch, files };
    });
    artifact = {
      ...artifact,
      status: "ready",
      updatedAt: now(),
      summary: review.ai.summary,
      chapters,
      comments: review.ai.comments.map((c) => ({
        id: randomUUID(),
        path: c.path,
        line: c.line,
        body: c.body,
        chapterId: c.chapterId ?? null,
        origin: "ai" as const,
        status: "draft" as const,
        editedByUser: false,
        originalLine: null,
        drifted: false,
      })),
      verdict: review.ai.verdict,
      run: {
        model: review.model ?? opts.model ?? null,
        startedAt: artifact.run!.startedAt,
        finishedAt: now(),
        costUsd: review.costUsd,
        error: null,
      },
    };

    // A re-review regenerates the AI's comments, but the human's own comments
    // and their rewrites of AI ones are work the run must not throw away.
    if (existing) {
      const { comments, carried, drifted } = carryOverComments(existing, artifact);
      if (carried > 0) {
        artifact = { ...artifact, comments };
        log(
          `Carried over ${carried} comment(s) you wrote or edited` +
            (drifted > 0 ? `; ${drifted} no longer match the diff and will post in the body.` : "."),
        );
      }
    }
  } catch (err: unknown) {
    artifact = {
      ...artifact,
      status: "failed",
      updatedAt: now(),
      run: {
        ...artifact.run!,
        finishedAt: now(),
        error: err instanceof Error ? err.message : String(err),
      },
    };
    await saveArtifact(artifact);
    throw err;
  }

  await saveArtifact(artifact);
  return { artifact, skipped: false };
}

/** Run tasks with bounded concurrency, preserving order of results. */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runAiReview(
  prompt: string,
  opts: ReviewOptions,
): Promise<{ ai: AiReview; costUsd: number | null; model: string | null }> {
  const first = await runClaude(prompt, { model: opts.model });
  try {
    return { ai: AiReviewSchema.parse(extractJson(first.text)), costUsd: first.costUsd, model: first.model };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onProgress?.("Model output failed validation — retrying once…");
    const second = await runClaude(buildRetryPrompt(prompt, first.text, message), { model: opts.model });
    const cost = (first.costUsd ?? 0) + (second.costUsd ?? 0);
    return {
      ai: AiReviewSchema.parse(extractJson(second.text)),
      costUsd: cost > 0 ? cost : null,
      model: second.model,
    };
  }
}
