import { randomUUID } from "node:crypto";
import {
  AiReview,
  AiReviewSchema,
  Artifact,
  SCHEMA_VERSION,
  artifactId,
} from "../core/artifact.js";
import { PrRef, fetchPrDiff, fetchPrInfo } from "../core/gh.js";
import { saveArtifact } from "../core/state.js";
import { extractJson, runClaude } from "./claude.js";
import { buildReviewPrompt, buildRetryPrompt } from "./prompt.js";

export interface ReviewOptions {
  model?: string;
  onProgress?: (message: string) => void;
}

/**
 * Fetch a PR, run the AI review, persist the artifact at each stage.
 * Everything stays local — nothing is ever written to GitHub.
 */
export async function reviewPr(ref: PrRef, opts: ReviewOptions = {}): Promise<Artifact> {
  const log = opts.onProgress ?? (() => {});
  const now = () => new Date().toISOString();

  log(`Fetching ${ref.owner}/${ref.repo}#${ref.number}…`);
  const pr = await fetchPrInfo(ref);
  const diff = await fetchPrDiff(ref);

  let artifact: Artifact = {
    schemaVersion: SCHEMA_VERSION,
    id: artifactId(pr),
    status: "running",
    createdAt: now(),
    updatedAt: now(),
    pr,
    diff,
    summary: "",
    chapters: [],
    comments: [],
    verdict: null,
    run: { model: opts.model ?? null, startedAt: now(), finishedAt: null, costUsd: null, error: null },
    sent: null,
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
  return artifact;
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
