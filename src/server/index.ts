import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { DaemonHandle } from "./daemon.js";
import { ArtifactStatusSchema, VerdictSchema, artifactKey } from "../core/artifact.js";
import { toMarkdown } from "../core/export.js";
import { submitReview } from "../core/gh.js";
import { ReviewEvent, buildReviewPayload, computeCalibration } from "../core/send.js";
import { listArtifacts, loadArtifactByKey, updateArtifactByKey } from "../core/state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ServeOptions {
  port: number;
  host: string;
  /** When set, every request must present this token (Bearer header, ?token= query, or the cookie it sets). */
  token?: string;
  daemon?: DaemonHandle;
}

export async function buildApp(opts: Pick<ServeOptions, "token" | "daemon">): Promise<Hono> {
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
          additions: a.pr.additions,
          deletions: a.pr.deletions,
          changedFiles: a.pr.changedFiles,
        },
        verdict: a.verdict,
        commentCount: a.comments.filter((cm) => cm.status !== "dropped").length,
        costUsd: a.run?.costUsd ?? null,
      })),
    );
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
          origin: "user" as const,
          status: "draft" as const,
          editedByUser: false,
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
  const app = await buildApp(opts);
  serve({ fetch: app.fetch, port: opts.port, hostname: opts.host }, (info) => {
    const tokenHint = opts.token ? `/?token=${opts.token}` : "";
    console.log(`cerber cockpit: http://${opts.host}:${info.port}${tokenHint}`);
    if (opts.daemon) console.log("daemon: polling for PRs awaiting your review");
  });
}
