import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DaemonHandle, isPureStub } from "./daemon.js";
import {
  Artifact,
  ArtifactStatusSchema,
  SCHEMA_VERSION,
  SeveritySchema,
  VerdictSchema,
  artifactId,
  artifactKey,
} from "../core/artifact.js";
import { toMarkdown } from "../core/export.js";
import { fetchPrDiff, fetchPrInfo, parsePrRef, submitReview } from "../core/gh.js";
import { z } from "zod";
import { DaemonConfigSchema, configPath, loadConfig, saveConfig } from "../core/config.js";
import { refreshArtifact } from "../core/refresh.js";
import { TrustRuleError, describeRule, explainRule, parseTrustRule } from "../core/trust.js";
import { ReviewEvent, buildReviewPayload, computeCalibration } from "../core/send.js";
import {
  listArtifacts,
  loadArtifact,
  loadArtifactByKey,
  reconcileRunning,
  saveArtifact,
  updateArtifactByKey,
} from "../core/state.js";
import { isReviewRunning } from "../runner/inflight.js";
import { reviewPr } from "../runner/review.js";
import { runChatTurn } from "../runner/chat.js";
import { mergeConcurrentEdits, restoreReview } from "../core/revise.js";
import { progressWriter } from "./progress.js";
import { ChatTurnSchema } from "../core/artifact.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServeOptions {
  port: number;
  host: string;
  /** When set, every request must present this token (Bearer header, ?token= query, or the cookie it sets). */
  token?: string;
  daemon?: DaemonHandle;
  /** False makes cockpit re-reviews diff-only (`serve --no-source`). Defaults to on. */
  withSource?: boolean;
  /** False keeps cockpit re-reviews read-only whatever the trust config says. */
  trust?: boolean;
}

export async function buildApp(
  opts: Pick<ServeOptions, "token" | "daemon" | "withSource" | "trust">,
): Promise<Hono> {
  const app = new Hono();

  if (opts.token) {
    const token = opts.token;
    app.use("*", async (c, next) => {
      const query = c.req.query("token");
      const cookie = getCookie(c, "cerber_token");
      const header = c.req.header("authorization");
      if (query === token || cookie === token || header === `Bearer ${token}`) {
        if (query === token && cookie !== token) {
          // First visit via ?token=… — set the cookie so the SPA's asset and API requests pass.
          setCookie(c, "cerber_token", token, { httpOnly: true, sameSite: "Strict", path: "/" });
        }
        return next();
      }
      return c.text("unauthorized — pass ?token=… or Authorization: Bearer …\n", 401);
    });
  }

  app.get("/api/daemon", (c) =>
    c.json(opts.daemon ? opts.daemon.status() : { enabled: false }),
  );

  // ---- Config: trust rules, edited from the cockpit's Settings view ----

  const trustView = (lines: string[]) =>
    lines.flatMap((line) => {
      try {
        const rule = parseTrustRule(line);
        return rule ? [{ rule: describeRule(rule), explanation: explainRule(rule), denies: rule.negated }] : [];
      } catch {
        // loadConfig rejects these, so reaching here means the file changed
        // under us; showing the rest beats failing the whole screen.
        return [];
      }
    });

  app.get("/api/config", async (c) => {
    try {
      const config = await loadConfig();
      return c.json({ path: configPath(), trust: trustView(config.trust), daemon: config.daemon });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // The inbox knobs. The daemon re-reads the config every poll, so a toggle
  // here applies on the next tick without restarting serve.
  app.post("/api/config/daemon", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    try {
      const config = await loadConfig();
      const daemon = DaemonConfigSchema.parse({ ...config.daemon, ...body });
      await saveConfig({ ...config, daemon });
      return c.json({ path: configPath(), trust: trustView(config.trust), daemon });
    } catch (err: unknown) {
      if (err instanceof z.ZodError) {
        return c.json(
          { error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") },
          400,
        );
      }
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/config/trust", async (c) => {
    let body: { rule?: unknown; remove?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const { rule, remove } = body;
    if (typeof rule !== "string" || !rule.trim()) {
      return c.json({ error: "rule is required" }, 400);
    }
    let parsed;
    try {
      parsed = parseTrustRule(rule);
    } catch (err: unknown) {
      // The message explains what to write instead — show it verbatim.
      if (err instanceof TrustRuleError) return c.json({ error: err.message }, 400);
      throw err;
    }
    if (!parsed) return c.json({ error: `not a trust rule: ${rule}` }, 400);

    const canonical = describeRule(parsed);
    try {
      const config = await loadConfig();
      const without = config.trust.filter((line) => {
        const existing = parseTrustRule(line);
        return !existing || describeRule(existing) !== canonical;
      });
      const trust = remove === true ? without : [...without, canonical];
      await saveConfig({ ...config, trust });
      // Full ConfigView — the cockpit replaces its config state with this
      // wholesale, so omitting daemon would crash the Settings toggles.
      return c.json({ path: configPath(), trust: trustView(trust), daemon: config.daemon });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get("/api/reviews", async (c) => {
    const artifacts = await listArtifacts();
    return c.json(
      artifacts.map((a) => ({
        id: a.id,
        key: artifactKey(a.id),
        status: a.status,
        updatedAt: a.updatedAt,
        pr: {
          title: a.pr.title,
          url: a.pr.url,
          author: a.pr.author,
          owner: a.pr.owner,
          repo: a.pr.repo,
          number: a.pr.number,
          state: a.pr.state,
          isDraft: a.pr.isDraft,
          additions: a.pr.additions,
          deletions: a.pr.deletions,
          changedFiles: a.pr.changedFiles,
          // The queue's cursor row explains itself without opening the review,
          // so the list carries what that explanation is made of.
          baseRefName: a.pr.baseRefName,
          headRefName: a.pr.headRefName,
        },
        verdict: a.verdict,
        commentCount: a.comments.filter((cm) => cm.status !== "dropped").length,
        driftedCount: a.comments.filter((cm) => cm.status !== "dropped" && cm.drifted).length,
        // Only blockers block, so the queue's verdict cell names the count the
        // verdict rests on rather than a confidence the reader can't check.
        blockerCount: a.comments.filter((cm) => cm.status !== "dropped" && cm.severity === "blocker")
          .length,
        gradedCount: a.comments.filter((cm) => cm.severity != null).length,
        costUsd: a.run?.costUsd ?? null,
        withSource: a.run?.withSource ?? null,
        trusted: a.run?.trusted ?? null,
        runError: a.run?.error ?? null,
        sent: a.sent ? { at: a.sent.at, event: a.sent.event, url: a.sent.url, auto: a.sent.auto ?? false } : null,
      })),
    );
  });

  // ---- Pull a PR in: review anything, not just what the inbox found ----
  //
  // The daemon only ever discovers PRs GitHub is asking *you* to review. This
  // is the other door: paste a URL and cerber reviews it — your own PR, one you
  // were never requested on, one you already settled and want a second read of.

  const CreateReviewSchema = z.object({ input: z.string().min(1) });

  app.post("/api/reviews", async (c) => {
    const parsed = CreateReviewSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "expected { input: \"<pr url>\" }" }, 400);

    let ref;
    try {
      ref = parsePrRef(parsed.data.input.trim());
    } catch (err: unknown) {
      // A bare number is the one parse failure worth explaining: parsePrRef can
      // resolve it against a repo, and the cockpit has none to offer.
      const message = /bare number/.test(err instanceof Error ? err.message : "")
        ? "A number alone doesn't say which repo — paste the full PR URL, or owner/repo#123."
        : err instanceof Error
          ? err.message
          : String(err);
      return c.json({ error: message }, 400);
    }

    // Two tabs, or a retried request, can both get here before either has saved
    // anything. Letting both through would start a second run whose inflight
    // claim throws, and whose failure handler would then mark the *first* run's
    // artifact failed underneath it.
    if (isReviewRunning(artifactId(ref))) {
      return c.json({ error: "a review of this PR is already running" }, 409);
    }

    // Already here? Hand back what we have rather than reviewing it twice — but
    // only if there is something to hand back. A pure stub is the daemon saying
    // "GitHub is asking you for this", not a review; pasting its URL is the user
    // asking for the review that does not exist yet, so that falls through and
    // runs. Handing the stub over instead would answer 200 while silently
    // dropping what was actually requested.
    const existing = await loadArtifact(artifactId(ref));
    if (existing && !isPureStub(existing)) {
      return c.json({ ...existing, key: artifactKey(existing.id) }, 200);
    }

    // Validated in-request, on purpose. The run below is detached, so a typo'd
    // URL, a private repo or a logged-out `gh` would otherwise fail with no
    // artifact to record it on and no response left to report it in. The PR
    // this fetches is also what the artifact is built from, so it costs nothing.
    let pr;
    try {
      pr = await fetchPrInfo(ref);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }

    const withSource = opts.withSource;
    const now = new Date().toISOString();
    // Saved as `running`, with a run block, BEFORE the 202 — not as an
    // `awaiting` stub. reviewPr spends minutes on the diff, trust and checkout
    // before it first writes the artifact itself, and for a PR that isn't in
    // the awaiting search a stub sitting in that window is exactly what the
    // daemon's reaper deletes (isPureStub). Persisting the run up front is what
    // makes this artifact survive its own first poll.
    const artifact: Artifact = {
      schemaVersion: SCHEMA_VERSION,
      id: artifactId(ref),
      status: "running",
      createdAt: now,
      updatedAt: now,
      pr,
      diff: "",
      summary: "",
      chapters: [],
      comments: [],
      verdict: null,
      run: {
        model: null,
        startedAt: now,
        finishedAt: null,
        costUsd: null,
        error: null,
        withSource: withSource !== false,
        trusted: false,
        sessionId: null,
      },
      sent: null,
      refresh: null,
      calibration: null,
      chat: [],
      preChat: null,
      pendingChat: null,
    };
    await saveArtifact(artifact);

    void reviewPr(ref, {
      force: true,
      withSource,
      trust: opts.trust,
      onProgress: (m) => console.log(`[pull ${artifact.id}] ${m}`),
    }).catch(async (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[pull ${artifact.id}] failed: ${message}`);
      await updateArtifactByKey(artifactKey(artifact.id), (a) =>
        a.status === "running"
          ? { ...a, status: "failed" as const, run: a.run ? { ...a.run, error: message } : null }
          : a,
      ).catch(() => {});
    });

    return c.json({ ...artifact, key: artifactKey(artifact.id) }, 202);
  });

  app.get("/api/reviews/:key", async (c) => {
    const artifact = await loadArtifactByKey(c.req.param("key"));
    if (!artifact) return c.json({ error: "not found" }, 404);
    return c.json(artifact);
  });

  // ---- Mutations (all local — artifact edits only) ----

  app.patch("/api/reviews/:key", async (c) => {
    const body = await c.req.json();
    const updated = await updateArtifactByKey(c.req.param("key"), (a) => {
      const next = { ...a };
      if (body.status !== undefined) {
        next.status = ArtifactStatusSchema.parse(body.status);
      }
      if (body.verdictRecommendation !== undefined && next.verdict) {
        next.verdict = {
          ...next.verdict,
          recommendation: VerdictSchema.shape.recommendation.parse(body.verdictRecommendation),
        };
      }
      return next;
    });
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  app.patch("/api/reviews/:key/comments/:id", async (c) => {
    const body = await c.req.json();
    const id = c.req.param("id");
    const updated = await updateArtifactByKey(c.req.param("key"), (a) => ({
      ...a,
      comments: a.comments.map((cm) =>
        cm.id === id
          ? {
              ...cm,
              ...(body.body !== undefined ? { body: String(body.body) } : {}),
              ...(body.severity !== undefined
                ? { severity: SeveritySchema.nullable().parse(body.severity) }
                : {}),
              ...(body.status !== undefined
                ? { status: body.status as "draft" | "approved" | "dropped" }
                : {}),
              ...(body.body !== undefined && body.body !== cm.body && cm.origin === "ai"
                ? { editedByUser: true }
                : {}),
            }
          : cm,
      ),
    }));
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  app.post("/api/reviews/:key/comments", async (c) => {
    const body = await c.req.json();
    const updated = await updateArtifactByKey(c.req.param("key"), (a) => ({
      ...a,
      comments: [
        ...a.comments,
        {
          id: randomUUID(),
          path: String(body.path ?? ""),
          line: body.line != null ? Number(body.line) : null,
          body: String(body.body ?? ""),
          chapterId: body.chapterId ?? null,
          severity: SeveritySchema.nullable().parse(body.severity ?? null),
          origin: "user" as const,
          status: "draft" as const,
          editedByUser: false,
          originalLine: null,
          drifted: false,
        },
      ],
    }));
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  app.delete("/api/reviews/:key/comments/:id", async (c) => {
    const id = c.req.param("id");
    const updated = await updateArtifactByKey(c.req.param("key"), (a) => ({
      ...a,
      comments: a.comments.filter((cm) => cm.id !== id),
    }));
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  // ---- Freshness: pull a review forward onto the PR's current head ----
  // Read-only against GitHub (pr view + pr diff); writes only the local artifact.

  app.post("/api/reviews/:key/refresh", async (c) => {
    const artifact = await loadArtifactByKey(c.req.param("key"));
    if (!artifact) return c.json({ error: "not found" }, 404);
    const ref = { owner: artifact.pr.owner, repo: artifact.pr.repo, number: artifact.pr.number };

    let pr;
    try {
      pr = await fetchPrInfo(ref);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }

    const stale = artifact.pr.headSha !== "" && artifact.pr.headSha !== pr.headSha;
    // A sent review is a record of what was posted — never rewrite it. A running
    // one is mid-run and would be overwritten from under the runner.
    if (!stale || artifact.sent || artifact.status === "running") {
      return c.json({ stale, changed: false, prState: pr.state, artifact });
    }

    try {
      const diff = await fetchPrDiff(ref);
      const result = refreshArtifact(artifact, pr, diff);
      const saved = await updateArtifactByKey(c.req.param("key"), () => result.artifact);
      return c.json({
        stale: true,
        changed: result.changed,
        prState: pr.state,
        moved: result.moved,
        drifted: result.drifted,
        artifact: saved,
      });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // ---- Re-review: start an AI run for a PR that has moved on ----

  app.post("/api/reviews/:key/rerun", async (c) => {
    const key = c.req.param("key");
    const artifact = await loadArtifactByKey(key);
    if (!artifact) return c.json({ error: "not found" }, 404);
    if (artifact.sent) return c.json({ error: `already sent at ${artifact.sent.at}` }, 409);
    if (isReviewRunning(artifact.id)) {
      return c.json({ error: "a review of this PR is already running" }, 409);
    }

    const ref = { owner: artifact.pr.owner, repo: artifact.pr.repo, number: artifact.pr.number };
    // Source-backed unless the server was started with --no-source; ?source=1
    // overrides that per re-review, ?source=0 opts one out.
    const sourceParam = c.req.query("source");
    const withSource = sourceParam == null ? opts.withSource : sourceParam !== "0";
    // Mark it running before responding, so the cockpit's next poll can't catch
    // the old "ready" status and conclude the run already finished.
    const running = await updateArtifactByKey(key, (a) => ({
      ...a,
      status: "running" as const,
      run: {
        model: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        costUsd: null,
        error: null,
        withSource: withSource !== false,
        trusted: false,
        sessionId: null,
      },
    }));

    // Minutes-long: run it detached and let the cockpit poll the artifact.
    void reviewPr(ref, {
      force: true,
      withSource,
      trust: opts.trust,
      onProgress: (m) => console.log(`[rerun ${artifact.id}] ${m}`),
    })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[rerun ${artifact.id}] failed: ${message}`);
        // The runner marks the artifact failed once it owns it; a failure before
        // that (fetching the PR, or a run already in flight) would otherwise
        // leave it stuck at "running" with nothing to clear it.
        await updateArtifactByKey(key, (a) =>
          a.status === "running"
            ? { ...a, status: "failed" as const, run: a.run ? { ...a.run, error: message } : null }
            : a,
        ).catch(() => {});
      });

    return c.json(running, 202);
  });

  // ---- Chat: argue with the review before sending it ----
  // Local only. The transcript never reaches GitHub — Send still builds its
  // payload from the summary, comments and verdict alone.

  const ChatRequestSchema = z.object({
    message: z.string().min(1),
    refs: ChatTurnSchema.shape.refs.optional(),
    /** The user said, in so many words, that the run may touch their comments. */
    allowUserComments: z.boolean().optional(),
  });

  const turnInFlight = (a: Artifact) => a.pendingChat != null && a.pendingChat.error == null;

  app.post("/api/reviews/:key/chat", async (c) => {
    const key = c.req.param("key");
    const artifact = await loadArtifactByKey(key);
    if (!artifact) return c.json({ error: "not found" }, 404);
    // A sent review is a record of what was posted — arguing with it now would
    // rewrite history that GitHub already has.
    if (artifact.sent) return c.json({ error: `already sent at ${artifact.sent.at}` }, 409);
    if (isReviewRunning(artifact.id) || turnInFlight(artifact)) {
      return c.json({ error: "a run for this PR is already in flight" }, 409);
    }

    let request;
    try {
      request = ChatRequestSchema.parse(await c.req.json());
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    // Record the question before responding, so the cockpit's next poll — and a
    // reload mid-turn — finds a turn being answered rather than a message that
    // went nowhere.
    const pending = await updateArtifactByKey(key, (a) => ({
      ...a,
      pendingChat: {
        message: request.message,
        refs: request.refs ?? [],
        startedAt: new Date().toISOString(),
        progress: [],
        error: null,
      },
    }));

    // The turn narrates itself as it reads the code; those lines go onto the
    // artifact so the cockpit's poll can show them instead of a spinner.
    const progress = progressWriter(key);

    // Minutes-long, like a re-review: run it detached and let the cockpit poll.
    // Holding the request open is fine on localhost and fails behind a reverse
    // proxy's read timeout, which tells the user it broke while the turn
    // quietly succeeds — a worse failure than an honest error.
    void runChatTurn(artifact, request.message, {
      refs: request.refs,
      allowUserComments: request.allowUserComments,
      onProgress: (m) => {
        console.log(`[chat ${artifact.id}] ${m}`);
        progress.push(m);
      },
    })
      .then(async (result) => {
        // Let the narration finish writing first: an append that read the
        // artifact before this point would otherwise land on top of the answer.
        await progress.stop();
        // The cockpit stays live throughout, so fold the result onto whatever
        // is on disk now rather than overwriting it — an edit the user made
        // while waiting must not vanish when the answer lands.
        await updateArtifactByKey(key, (current) => ({
          ...mergeConcurrentEdits(artifact, result.artifact, current),
          pendingChat: null,
        }));
      })
      .catch(async (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[chat ${artifact.id}] failed: ${message}`);
        await progress.stop();
        // Nobody is holding a response to hand this to any more, so the failure
        // lives on the artifact against the question that caused it — under
        // whatever the turn had managed to do before it died.
        await updateArtifactByKey(key, (a) => ({
          ...a,
          pendingChat: a.pendingChat ? { ...a.pendingChat, error: message } : null,
        })).catch(() => {});
      });

    return c.json(pending, 202);
  });

  // Clear a turn that failed. Only that: a turn still being answered would come
  // back on the next write and the cockpit would have lied about dropping it.
  app.delete("/api/reviews/:key/chat/pending", async (c) => {
    const key = c.req.param("key");
    const artifact = await loadArtifactByKey(key);
    if (!artifact) return c.json({ error: "not found" }, 404);
    if (turnInFlight(artifact)) {
      return c.json({ error: "that turn is still being answered" }, 409);
    }
    const updated = await updateArtifactByKey(key, (a) => ({ ...a, pendingChat: null }));
    return c.json(updated);
  });

  // Put the review back the way it was before the conversation started. The
  // conversation itself stays — you lose the edits, not the reasoning.
  app.post("/api/reviews/:key/chat/reset", async (c) => {
    const key = c.req.param("key");
    const artifact = await loadArtifactByKey(key);
    if (!artifact) return c.json({ error: "not found" }, 404);
    if (artifact.sent) return c.json({ error: `already sent at ${artifact.sent.at}` }, 409);
    // A turn in flight will fold its own result on top of whatever is on disk
    // when it lands, so resetting now would be undone a minute later.
    if (turnInFlight(artifact)) {
      return c.json({ error: "a turn is still being answered — wait for it to land" }, 409);
    }
    if (!artifact.preChat) return c.json({ error: "this review has not been chatted about" }, 409);

    const updated = await updateArtifactByKey(key, (a) =>
      a.preChat ? restoreReview(a, a.preChat) : a,
    );
    return c.json(updated);
  });

  // ---- Export (local file download) ----

  app.get("/api/reviews/:key/export", async (c) => {
    const artifact = await loadArtifactByKey(c.req.param("key"));
    if (!artifact) return c.json({ error: "not found" }, 404);
    c.header("Content-Type", "text/markdown; charset=utf-8");
    c.header(
      "Content-Disposition",
      `attachment; filename="review-${artifactKey(artifact.id)}.md"`,
    );
    return c.body(toMarkdown(artifact));
  });

  // ---- Send: THE ONLY GITHUB WRITE. Explicit user action from the cockpit. ----

  app.post("/api/reviews/:key/send", async (c) => {
    const { event, confirm } = await c.req.json();
    if (confirm !== true) {
      return c.json({ error: "send requires an explicit confirm: true" }, 400);
    }
    if (!["APPROVE", "COMMENT", "REQUEST_CHANGES"].includes(event)) {
      return c.json({ error: `invalid event: ${event}` }, 400);
    }
    const artifact = await loadArtifactByKey(c.req.param("key"));
    if (!artifact) return c.json({ error: "not found" }, 404);
    if (artifact.sent) {
      return c.json({ error: `already sent at ${artifact.sent.at}` }, 409);
    }

    const payload = buildReviewPayload(artifact, event as ReviewEvent);
    try {
      const { url } = await submitReview(
        { owner: artifact.pr.owner, repo: artifact.pr.repo, number: artifact.pr.number },
        { event: payload.event, body: payload.body, comments: payload.comments, commitId: payload.commitId },
      );
      const updated = await updateArtifactByKey(c.req.param("key"), (a) => ({
        ...a,
        status: "sent" as const,
        sent: { at: new Date().toISOString(), event: payload.event, url, auto: false },
        calibration: computeCalibration(a, payload.event),
      }));
      return c.json(updated);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });

  // Preview what send would post, without posting anything.
  app.get("/api/reviews/:key/send-preview", async (c) => {
    const artifact = await loadArtifactByKey(c.req.param("key"));
    if (!artifact) return c.json({ error: "not found" }, 404);
    const event = (c.req.query("event") ?? "COMMENT") as ReviewEvent;
    return c.json(buildReviewPayload(artifact, event));
  });

  // Static cockpit build. In the published package web/dist ships alongside dist/.
  // __dirname is src/server (dev via tsx) or dist/server (built) — both are two levels below the repo root.
  const webDist = path.resolve(__dirname, "../../web/dist");
  const hasWebBuild = await fs
    .access(path.join(webDist, "index.html"))
    .then(() => true)
    .catch(() => false);

  if (hasWebBuild) {
    app.use("/*", serveStatic({ root: path.relative(process.cwd(), webDist) }));
    app.get("*", serveStatic({ path: path.relative(process.cwd(), path.join(webDist, "index.html")) }));
  } else {
    app.get("/", (c) =>
      c.text(
        "cerber API is running, but the web cockpit is not built.\nRun `pnpm build` in the cerber repo, or use the API: GET /api/reviews\n",
      ),
    );
  }

  return app;
}

export async function startServer(opts: ServeOptions): Promise<void> {
  const cleared = await reconcileRunning();
  if (cleared > 0) {
    console.log(
      `Cleared ${cleared} AI run(s) left in flight by a previous process — start them again from the cockpit.`,
    );
  }
  const app = await buildApp(opts);
  serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, (info) => {
    const tokenHint = opts.token ? `/?token=${opts.token}` : "";
    console.log(`cerber cockpit: http://${opts.host}:${info.port}${tokenHint}`);
    if (opts.daemon) {
      const s = opts.daemon.status();
      console.log(
        `inbox: polling every ${Math.round(s.intervalMs / 60_000)}m` +
          `${s.autoReview ? ", drafting a review for each PR awaiting you" : " (auto-review off — click review in the queue)"}`,
      );
    }
  });
}
