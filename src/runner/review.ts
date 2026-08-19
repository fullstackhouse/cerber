import { randomUUID } from "node:crypto";
import {
  AiReview,
  AiReviewSchema,
  Artifact,
  PrInfo,
  SCHEMA_VERSION,
  artifactId,
} from "../core/artifact.js";
import { evictOldCheckouts, neutralDir, prepareCheckout } from "../core/checkout.js";
import { PrRef, fetchPrDiff, fetchPrInfo, fetchRepoIsPrivate } from "../core/gh.js";
import { carryOverComments } from "../core/refresh.js";
import { loadArtifact, saveArtifact } from "../core/state.js";
import { decideTrust, loadTrustRules, needsVisibility } from "../core/trust.js";
import { extractJson, runClaude } from "./claude.js";
import { ReviewInProgressError, beginReview, endReview, isReviewRunning } from "./inflight.js";
import { buildReviewPrompt, buildRetryPrompt } from "./prompt.js";

export interface ReviewOptions {
  model?: string;
  onProgress?: (message: string) => void;
  /** Re-review even if a fresh artifact for the same head SHA exists. */
  force?: boolean;
  /**
   * Check the PR head out locally and let the reviewer read it — on by
   * default, because a reviewer that can only see the diff hedges over context
   * it could have just looked up. Set false to review the diff alone: faster
   * and cheaper, at the cost of everything outside the changed lines.
   */
  withSource?: boolean;
  /**
   * Override the trust rules in ~/.cerber/trusted.txt for this run: true lets
   * the review run commands in the checkout, false keeps it read-only.
   */
  trust?: boolean;
}

/** All an untrusted reviewer needs from a checkout — everything else stays off. */
const READ_TOOLS = ["Read", "Grep", "Glob"];
const OFF_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Task", "WebFetch", "WebSearch"];
/** A trusted reviewer may run things. It still may not rewrite the PR. */
const TRUSTED_TOOLS = [...READ_TOOLS, "Bash", "WebFetch", "WebSearch"];
const TRUSTED_OFF_TOOLS = ["Edit", "Write", "NotebookEdit"];

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

/**
 * Trust is a claim about the people behind a PR, so it comes from the user:
 * the rules they wrote in ~/.cerber/trusted.txt, or an explicit flag on this
 * run. Nothing about the PR's own content can earn it.
 */
async function resolveTrust(
  pr: PrInfo,
  opts: ReviewOptions,
  log: (message: string) => void,
): Promise<boolean> {
  if (opts.trust !== undefined) {
    log(opts.trust ? "Trusted by --trust: the review may run commands." : "Untrusted by --no-trust.");
    return opts.trust;
  }
  const rules = await loadTrustRules();
  if (rules.length === 0) return false;

  const isPrivate = needsVisibility(rules)
    ? await fetchRepoIsPrivate(pr).catch(() => undefined)
    : undefined;
  const decision = decideTrust(rules, { owner: pr.owner, repo: pr.repo, author: pr.author, isPrivate });
  if (decision.trusted) log(`Trusted (${decision.reason}): the review may run commands in the checkout.`);
  return decision.trusted;
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

  const trusted = await resolveTrust(pr, opts, log);

  // A checkout is an optimisation, never a precondition: if git or gh can't
  // produce one, fall back to the diff-only review rather than failing the run.
  let source: string | null = null;
  if (opts.withSource !== false) {
    try {
      const checkout = await prepareCheckout(ref, { log, trusted });
      source = checkout.dir;
      const evicted = await evictOldCheckouts({ inUse: isReviewRunning });
      if (evicted.length > 0) log(`Evicted ${evicted.length} least-recently-used checkout(s) from the cache.`);
      if (pr.headSha && checkout.sha !== pr.headSha) {
        log(
          `Note: the checkout is at ${checkout.sha.slice(0, 7)} but the PR head is ${pr.headSha.slice(0, 7)} — ` +
            `the PR moved while we fetched.`,
        );
      }
    } catch (err: unknown) {
      log(
        `Could not check out the source (${err instanceof Error ? err.message : err}) — ` +
          `reviewing from the diff alone.`,
      );
    }
  }

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
    run: {
      model: opts.model ?? null,
      startedAt: now(),
      finishedAt: null,
      costUsd: null,
      error: null,
      withSource: source !== null,
      trusted: trusted && source !== null,
    },
    sent: null,
    refresh: null,
    calibration: null,
  };
  await saveArtifact(artifact);

  const { prompt, truncated } = buildReviewPrompt(pr, diff, { source: source !== null, trusted });
  if (truncated) log("Warning: diff exceeds the context budget and was truncated.");
  log(
    `Reviewing with Claude${opts.model ? ` (${opts.model})` : ""}` +
      `${source ? (trusted ? ", reading and running the full source" : ", reading the full source") : ""}` +
      `… this can take a few minutes.`,
  );

  try {
    const review = await runAiReview(prompt, opts, source, trusted);
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
        withSource: source !== null,
        trusted: trusted && source !== null,
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
  source: string | null,
  trusted: boolean,
): Promise<{ ai: AiReview; costUsd: number | null; model: string | null }> {
  // Without a checkout the run has nothing legitimate to read — cerber's own
  // cwd is not the reviewed repo — so every tool stays off, and it runs in an
  // empty directory so no unrelated project's CLAUDE.md rides along.
  const claudeOpts = {
    model: opts.model,
    cwd: source ?? (await neutralDir()),
    allowedTools: source ? (trusted ? TRUSTED_TOOLS : READ_TOOLS) : undefined,
    disallowedTools: source
      ? trusted
        ? TRUSTED_OFF_TOOLS
        : OFF_TOOLS
      : [...OFF_TOOLS, ...READ_TOOLS],
    // A trusted checkout gets to configure its own run, the way it would if
    // the user had opened the repo themselves.
    isolateWorkspace: !(source && trusted),
  };
  const first = await runClaude(prompt, claudeOpts);
  try {
    return { ai: AiReviewSchema.parse(extractJson(first.text)), costUsd: first.costUsd, model: first.model };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    opts.onProgress?.("Model output failed validation — retrying once…");
    const second = await runClaude(buildRetryPrompt(prompt, first.text, message), claudeOpts);
    const cost = (first.costUsd ?? 0) + (second.costUsd ?? 0);
    return {
      ai: AiReviewSchema.parse(extractJson(second.text)),
      costUsd: cost > 0 ? cost : null,
      model: second.model,
    };
  }
}
